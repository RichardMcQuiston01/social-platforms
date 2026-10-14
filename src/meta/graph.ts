import { hmacSha256Hex } from '../encoding.js';
import { expiryFromSeconds, readBody, type FetchLike } from '../http.js';
import { describeUnknownError, err, ok, type Result } from '../result.js';
import type { MetaConfig } from './config.js';

/**
 * A thin client for the Meta Graph API calls posting needs: the login, the
 * Pages the owner manages, a photo on a Page, and an Instagram post.
 * No SDK; `fetch` is injected so tests run without the network.
 *
 * Every call that carries a token also sends `appsecret_proof` (an HMAC of
 * the token with the app secret), so a leaked token alone can't be used
 * from another app.
 */

export interface MetaUserToken {
  readonly accessToken: string;
  /** null when Meta doesn't say (long-lived user tokens usually last ~60 days). */
  readonly expiresAt: Date | null;
}

export interface MetaPage {
  readonly id: string;
  readonly name: string;
  /** A Page token from a long-lived user token doesn't expire. */
  readonly accessToken: string;
  /** What the owner can do on the Page, e.g. CREATE_CONTENT. */
  readonly tasks: readonly string[];
  readonly instagramAccountId: string | null;
  readonly instagramUsername: string | null;
}

/** An Instagram media container's state while Instagram fetches the image. */
export interface InstagramContainerStatus {
  /** IN_PROGRESS, FINISHED, ERROR, EXPIRED or PUBLISHED. */
  readonly statusCode: string;
  /** Instagram's detail, e.g. why it's ERROR; '' when none. */
  readonly detail: string;
}

export interface PublishedPhoto {
  /** The photo's id. */
  readonly photoId: string;
  /** The feed post's id ("pageid_postid"), when Meta returns one. */
  readonly postId: string | null;
}

/** Meta's error envelope: {"error": {"message", "type", "code", ...}}. */
interface GraphErrorBody {
  readonly error?: {
    readonly message?: string;
    readonly type?: string;
    readonly code?: number;
    readonly error_subcode?: number;
    readonly fbtrace_id?: string;
  };
}

/** Graph error code for an invalid or expired token. */
const INVALID_TOKEN_CODE = 190;
/** Graph error code for a missing permission. */
const PERMISSION_CODES: ReadonlySet<number> = new Set([10, 200]);

/** `appsecret_proof`: HMAC-SHA256 of the token with the app secret, hex. */
export function appSecretProof(
  accessToken: string,
  appSecret: string
): Promise<string> {
  return hmacSha256Hex(appSecret, accessToken);
}

/**
 * Meta's error as one specific line: the request, the HTTP status, Meta's
 * code and message, its trace id, and the fix for the common cases.
 */
export function describeGraphError(
  what: string,
  status: number,
  body: unknown
): string {
  const graphError = (body as GraphErrorBody | null)?.error;
  if (graphError === undefined) {
    const text: string =
      typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body);
    return `Facebook refused ${what} (HTTP ${status}): ${text}`;
  }
  const code: string =
    graphError.code === undefined
      ? ''
      : `, code ${graphError.code}${graphError.error_subcode === undefined ? '' : `/${graphError.error_subcode}`}`;
  const trace: string =
    graphError.fbtrace_id === undefined
      ? ''
      : ` (trace ${graphError.fbtrace_id})`;
  let hint = '';
  if (graphError.code === INVALID_TOKEN_CODE) {
    hint = ' The Facebook login has expired or was revoked; connect again.';
  } else if (
    graphError.code !== undefined &&
    PERMISSION_CODES.has(graphError.code)
  ) {
    hint =
      ' A permission is missing: connect again and allow every permission, and check the app has the Page use case.';
  }
  return `Facebook refused ${what} (HTTP ${status}${code}): ${graphError.message ?? 'no message'}${trace}.${hint}`;
}

interface RawPage {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly access_token?: unknown;
  readonly tasks?: unknown;
  readonly instagram_business_account?: {
    readonly id?: unknown;
    readonly username?: unknown;
  };
}

/** A Page Facebook told us about that can't be posted to, and why. */
export interface UnavailablePage {
  readonly id: string;
  /** null when Facebook didn't give the name either. */
  readonly name: string | null;
  readonly reason: string;
}

export interface PageList {
  readonly pages: readonly MetaPage[];
  readonly unavailable: readonly UnavailablePage[];
}

/** Why a Page row has no token: almost always no role or task on the Page itself. */
export const NO_PAGE_TOKEN_REASON =
  "Facebook gave no Page token for it, so your account has no role on the Page itself. If it's in a Business portfolio, open business.facebook.com/settings → Accounts → Pages → this Page → People, give yourself full control (or content), then reconnect.";

/** `/me/accounts` (or single-Page) rows → usable pages, plus the ones that can't be used and why. */
export function mapPages(rows: readonly RawPage[]): PageList {
  const pages: MetaPage[] = [];
  const unavailable: UnavailablePage[] = [];
  for (const row of rows) {
    if (typeof row.id !== 'string') continue;
    if (typeof row.name !== 'string' || typeof row.access_token !== 'string') {
      unavailable.push({
        id: row.id,
        name: typeof row.name === 'string' ? row.name : null,
        reason: NO_PAGE_TOKEN_REASON,
      });
      continue;
    }
    const instagram = row.instagram_business_account;
    pages.push({
      id: row.id,
      name: row.name,
      accessToken: row.access_token,
      tasks: Array.isArray(row.tasks)
        ? row.tasks.filter((task): task is string => typeof task === 'string')
        : [],
      instagramAccountId:
        typeof instagram?.id === 'string' ? instagram.id : null,
      instagramUsername:
        typeof instagram?.username === 'string' ? instagram.username : null,
    });
  }
  return { pages, unavailable };
}

/** The Page permissions whose per-Page grants say which Pages the owner allowed. */
const PAGE_SCOPES: readonly string[] = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
];

/** `debug_token`'s `granular_scopes` → the Page ids granted to any Page permission. */
export function grantedPageIdsFrom(body: unknown): readonly string[] {
  const scopes = (body as { data?: { granular_scopes?: unknown } } | null)?.data
    ?.granular_scopes;
  if (!Array.isArray(scopes)) return [];
  const ids = new Set<string>();
  for (const entry of scopes as Array<{
    scope?: unknown;
    target_ids?: unknown;
  }>) {
    if (typeof entry.scope !== 'string' || !PAGE_SCOPES.includes(entry.scope))
      continue;
    if (!Array.isArray(entry.target_ids)) continue;
    for (const id of entry.target_ids)
      if (typeof id === 'string' && id !== '') ids.add(id);
  }
  return [...ids];
}

export class MetaGraphClient {
  constructor(
    private readonly config: MetaConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => Date = () => new Date()
  ) {}

  private get graphBase(): string {
    return `https://graph.facebook.com/${this.config.graphVersion}`;
  }

  /** The consent page: a Login for Business configuration when set, else the scopes. */
  authorizationUrl(state: string): string {
    const url = new URL(
      `https://www.facebook.com/${this.config.graphVersion}/dialog/oauth`
    );
    url.searchParams.set('client_id', this.config.appId);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('state', state);
    url.searchParams.set('response_type', 'code');
    if (this.config.loginConfigId !== null) {
      url.searchParams.set('config_id', this.config.loginConfigId);
    } else {
      url.searchParams.set('scope', this.config.scopes.join(','));
    }
    return url.toString();
  }

  /** The code from the redirect → a short-lived user token. */
  async exchangeCode(code: string): Promise<Result<MetaUserToken>> {
    const url = new URL(`${this.graphBase}/oauth/access_token`);
    url.searchParams.set('client_id', this.config.appId);
    url.searchParams.set('client_secret', this.config.appSecret);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('code', code);
    return this.readToken(url, 'the login code exchange');
  }

  /** A short-lived user token → a long-lived one (about 60 days). */
  async extendUserToken(
    shortLivedToken: string
  ): Promise<Result<MetaUserToken>> {
    const url = new URL(`${this.graphBase}/oauth/access_token`);
    url.searchParams.set('grant_type', 'fb_exchange_token');
    url.searchParams.set('client_id', this.config.appId);
    url.searchParams.set('client_secret', this.config.appSecret);
    url.searchParams.set('fb_exchange_token', shortLivedToken);
    return this.readToken(url, 'the long-lived token exchange');
  }

  private async readToken(
    url: URL,
    what: string
  ): Promise<Result<MetaUserToken>> {
    const response = await this.request(
      url.toString(),
      { method: 'GET' },
      what
    );
    if (!response.ok) return response;
    const body = response.value as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    if (typeof body.access_token !== 'string' || body.access_token === '') {
      return err(`Facebook's reply to ${what} had no access_token`);
    }
    return ok({
      accessToken: body.access_token,
      expiresAt: expiryFromSeconds(body.expires_in, this.now()),
    });
  }

  /** The permissions the owner granted (status "granted" only). */
  async grantedPermissions(
    userToken: string
  ): Promise<Result<readonly string[]>> {
    const response = await this.get(
      '/me/permissions',
      userToken,
      {},
      'the granted permissions'
    );
    if (!response.ok) return response;
    const rows = (response.value as { data?: unknown }).data;
    if (!Array.isArray(rows))
      return err('Facebook returned no permission list');
    return ok(
      rows
        .filter(
          (row): row is { permission: string; status: string } =>
            typeof (row as { permission?: unknown }).permission === 'string' &&
            (row as { status?: unknown }).status === 'granted'
        )
        .map((row) => row.permission)
    );
  }

  /** The Pages the owner manages, with Page tokens and any linked Instagram account. */
  async listPages(userToken: string): Promise<Result<PageList>> {
    const response = await this.get(
      '/me/accounts',
      userToken,
      {
        fields:
          'id,name,access_token,tasks,instagram_business_account{id,username}',
        limit: '100',
      },
      'the list of your Facebook Pages'
    );
    if (!response.ok) return response;
    const rows = (response.value as { data?: unknown }).data;
    if (!Array.isArray(rows)) return err('Facebook returned no Page list');
    return ok(mapPages(rows as RawPage[]));
  }

  /**
   * The Page ids the owner ticked in the login dialog. `/me/accounts` can
   * leave out a granted Page (e.g. one reached through a Business
   * portfolio), so the login asks for those by id.
   */
  async grantedPageIds(userToken: string): Promise<Result<readonly string[]>> {
    const response = await this.get(
      '/debug_token',
      userToken,
      { input_token: userToken },
      'the Pages this login was granted'
    );
    if (!response.ok) return response;
    return ok(grantedPageIdsFrom(response.value));
  }

  /** One Page by id, read with the user token: a usable Page, or why not. */
  async getPage(pageId: string, userToken: string): Promise<PageList> {
    const response = await this.get(
      `/${encodeURIComponent(pageId)}`,
      userToken,
      // `tasks` exists only on /me/accounts rows; asking a Page node for it is a 400.
      {
        fields: 'id,name,access_token,instagram_business_account{id,username}',
      },
      `Page ${pageId}`
    );
    if (!response.ok) {
      return {
        pages: [],
        unavailable: [{ id: pageId, name: null, reason: response.error }],
      };
    }
    return mapPages([response.value as RawPage]);
  }

  /** Posts one photo with a caption to the Page's feed, uploading the bytes directly. */
  async publishPagePhoto(
    page: { readonly id: string; readonly accessToken: string },
    photo: {
      readonly bytes: Uint8Array;
      readonly mimeType: string;
      readonly fileName: string;
    },
    caption: string
  ): Promise<Result<PublishedPhoto>> {
    const form = new FormData();
    form.set(
      'source',
      new Blob([new Uint8Array(photo.bytes)], { type: photo.mimeType }),
      photo.fileName
    );
    if (caption !== '') form.set('message', caption);
    form.set('published', 'true');
    form.set('access_token', page.accessToken);
    form.set(
      'appsecret_proof',
      await appSecretProof(page.accessToken, this.config.appSecret)
    );
    const response = await this.request(
      `${this.graphBase}/${encodeURIComponent(page.id)}/photos`,
      { method: 'POST', body: form },
      `the photo post to Page ${page.id}`
    );
    if (!response.ok) return response;
    const body = response.value as { id?: unknown; post_id?: unknown };
    if (typeof body.id !== 'string') {
      return err(
        `Facebook accepted the photo for Page ${page.id} but returned no id`
      );
    }
    return ok({
      photoId: body.id,
      postId: typeof body.post_id === 'string' ? body.post_id : null,
    });
  }

  /**
   * The public link to a post or photo; null if Facebook doesn't give one.
   * A Post has `permalink_url`; asking a Post for `link` fails with error 12
   * (deprecated since v3.3), so only a Photo is asked for `link`.
   */
  async permalink(
    objectId: string,
    kind: 'post' | 'photo',
    pageToken: string
  ): Promise<Result<string | null>> {
    const field: string = kind === 'post' ? 'permalink_url' : 'link';
    const response = await this.get(
      `/${encodeURIComponent(objectId)}`,
      pageToken,
      { fields: field },
      `the link to ${kind} ${objectId}`
    );
    if (!response.ok) return response;
    const raw: unknown = (response.value as Record<string, unknown>)[field];
    if (typeof raw !== 'string' || raw === '') return ok(null);
    // Facebook sometimes returns a path; make it absolute.
    return ok(
      raw.startsWith('http')
        ? raw
        : `https://www.facebook.com${raw.startsWith('/') ? '' : '/'}${raw}`
    );
  }

  /**
   * Step 1 of an Instagram post: a media container for the image at
   * `imageUrl` (Instagram fetches it) with the caption. Returns its id.
   */
  async createInstagramContainer(
    instagramAccountId: string,
    pageToken: string,
    imageUrl: string,
    caption: string
  ): Promise<Result<string>> {
    const response = await this.post(
      `/${encodeURIComponent(instagramAccountId)}/media`,
      pageToken,
      caption === ''
        ? { image_url: imageUrl }
        : { image_url: imageUrl, caption },
      `the Instagram media container for account ${instagramAccountId}`
    );
    if (!response.ok) return response;
    const id: unknown = (response.value as { id?: unknown }).id;
    return typeof id === 'string' && id !== ''
      ? ok(id)
      : err(
          `Instagram accepted the image for account ${instagramAccountId} but returned no container id`
        );
  }

  /** Whether Instagram has fetched and processed the container's image yet. */
  async instagramContainerStatus(
    containerId: string,
    pageToken: string
  ): Promise<Result<InstagramContainerStatus>> {
    const response = await this.get(
      `/${encodeURIComponent(containerId)}`,
      pageToken,
      { fields: 'status_code,status' },
      `the status of Instagram container ${containerId}`
    );
    if (!response.ok) return response;
    const body = response.value as { status_code?: unknown; status?: unknown };
    if (typeof body.status_code !== 'string') {
      return err(
        `Instagram returned no status_code for container ${containerId}`
      );
    }
    return ok({
      statusCode: body.status_code,
      detail: typeof body.status === 'string' ? body.status : '',
    });
  }

  /** Step 2: publishes a FINISHED container. Returns the media id. */
  async publishInstagramContainer(
    instagramAccountId: string,
    pageToken: string,
    containerId: string
  ): Promise<Result<string>> {
    const response = await this.post(
      `/${encodeURIComponent(instagramAccountId)}/media_publish`,
      pageToken,
      { creation_id: containerId },
      `publishing Instagram container ${containerId}`
    );
    if (!response.ok) return response;
    const id: unknown = (response.value as { id?: unknown }).id;
    return typeof id === 'string' && id !== ''
      ? ok(id)
      : err(
          `Instagram published container ${containerId} but returned no media id`
        );
  }

  /** The public link to an Instagram post; null if Instagram doesn't give one. */
  async instagramPermalink(
    mediaId: string,
    pageToken: string
  ): Promise<Result<string | null>> {
    const response = await this.get(
      `/${encodeURIComponent(mediaId)}`,
      pageToken,
      { fields: 'permalink' },
      `the link to Instagram post ${mediaId}`
    );
    if (!response.ok) return response;
    const link: unknown = (response.value as { permalink?: unknown }).permalink;
    return ok(
      typeof link === 'string' && link.startsWith('https://') ? link : null
    );
  }

  private async post(
    path: string,
    accessToken: string,
    params: Readonly<Record<string, string>>,
    what: string
  ): Promise<Result<unknown>> {
    const body = new URLSearchParams(params);
    body.set('access_token', accessToken);
    body.set(
      'appsecret_proof',
      await appSecretProof(accessToken, this.config.appSecret)
    );
    return this.request(
      `${this.graphBase}${path}`,
      { method: 'POST', body },
      what
    );
  }

  private async get(
    path: string,
    accessToken: string,
    params: Readonly<Record<string, string>>,
    what: string
  ): Promise<Result<unknown>> {
    const url = new URL(`${this.graphBase}${path}`);
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value);
    url.searchParams.set('access_token', accessToken);
    url.searchParams.set(
      'appsecret_proof',
      await appSecretProof(accessToken, this.config.appSecret)
    );
    return this.request(url.toString(), { method: 'GET' }, what);
  }

  private async request(
    url: string,
    init: RequestInit,
    what: string
  ): Promise<Result<unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (cause: unknown) {
      return err(
        `Could not reach Facebook for ${what}: ${describeUnknownError(cause)}`,
        cause
      );
    }
    const body: unknown = await readBody(response);
    if (!response.ok)
      return err(describeGraphError(what, response.status, body));
    return ok(body);
  }
}
