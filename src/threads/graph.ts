import { expiryFromSeconds, readBody, type FetchLike } from '../http.js';
import { describeUnknownError, err, ok, type Result } from '../result.js';
import { THREADS_SCOPES, type ThreadsConfig } from './config.js';

/**
 * A thin client for the Threads API calls posting needs: the login
 * (code → short-lived → long-lived token, and refreshing it), the account's
 * id and username, and the two-step image post. No SDK; `fetch` is
 * injected so tests run without the network.
 */

export const THREADS_AUTHORIZE_URL = 'https://threads.net/oauth/authorize';
const THREADS_API_ORIGIN = 'https://graph.threads.net';

export interface ThreadsToken {
  readonly accessToken: string;
  /** null when Threads doesn't say (long-lived tokens last 60 days). */
  readonly expiresAt: Date | null;
}

export interface ThreadsProfile {
  readonly id: string;
  /** null when Threads doesn't give it. */
  readonly username: string | null;
}

/** A Threads media container's state while Threads fetches the image. */
export interface ThreadsContainerStatus {
  /** IN_PROGRESS, FINISHED, PUBLISHED, ERROR or EXPIRED. */
  readonly status: string;
  /** Threads' reason when it's ERROR; '' when none. */
  readonly errorMessage: string;
}

interface ThreadsErrorBody {
  readonly error?: {
    readonly message?: string;
    readonly type?: string;
    readonly code?: number;
    readonly error_subcode?: number;
    readonly fbtrace_id?: string;
  };
}

/** Error code for an invalid or expired token. */
const INVALID_TOKEN_CODE = 190;
/** Error codes for a missing permission. */
const PERMISSION_CODES: ReadonlySet<number> = new Set([10, 200]);

/** Threads' error as one specific line, with the fix for the common cases. */
export function describeThreadsError(
  what: string,
  status: number,
  body: unknown
): string {
  const apiError = (body as ThreadsErrorBody | null)?.error;
  if (apiError === undefined) {
    const text: string =
      typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body);
    return `Threads refused ${what} (HTTP ${status}): ${text}`;
  }
  const code: string =
    apiError.code === undefined
      ? ''
      : `, code ${apiError.code}${apiError.error_subcode === undefined ? '' : `/${apiError.error_subcode}`}`;
  const trace: string =
    apiError.fbtrace_id === undefined ? '' : ` (trace ${apiError.fbtrace_id})`;
  let hint = '';
  if (apiError.code === INVALID_TOKEN_CODE) {
    hint =
      ' The Threads login has expired or was revoked; connect Threads again.';
  } else if (
    apiError.code !== undefined &&
    PERMISSION_CODES.has(apiError.code)
  ) {
    hint = ` A permission is missing: connect Threads again and allow ${THREADS_SCOPES.join(' and ')}.`;
  }
  return `Threads refused ${what} (HTTP ${status}${code}): ${apiError.message ?? 'no message'}${trace}.${hint}`;
}

export class ThreadsClient {
  constructor(
    private readonly config: ThreadsConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => Date = () => new Date()
  ) {}

  private get apiBase(): string {
    return `${THREADS_API_ORIGIN}/${this.config.apiVersion}`;
  }

  /** The consent page on threads.net. */
  authorizationUrl(state: string): string {
    const url = new URL(THREADS_AUTHORIZE_URL);
    url.searchParams.set('client_id', this.config.appId);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('scope', THREADS_SCOPES.join(','));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);
    return url.toString();
  }

  /** The redirect's code → a short-lived (1 hour) token and the account id. */
  async exchangeCode(
    code: string
  ): Promise<Result<{ accessToken: string; userId: string }>> {
    const body = new URLSearchParams({
      client_id: this.config.appId,
      client_secret: this.config.appSecret,
      grant_type: 'authorization_code',
      redirect_uri: this.config.redirectUri,
      code,
    });
    const response = await this.request(
      `${THREADS_API_ORIGIN}/oauth/access_token`,
      { method: 'POST', body },
      'the login code'
    );
    if (!response.ok) return response;
    const value = response.value as {
      access_token?: unknown;
      user_id?: unknown;
    };
    if (typeof value.access_token !== 'string' || value.access_token === '') {
      return err(
        'Threads accepted the login code but returned no access token.'
      );
    }
    const userId: string =
      typeof value.user_id === 'number' || typeof value.user_id === 'string'
        ? String(value.user_id)
        : '';
    return ok({ accessToken: value.access_token, userId });
  }

  /** A short-lived token → a long-lived (60-day) one. */
  async exchangeForLongLived(
    shortLivedToken: string
  ): Promise<Result<ThreadsToken>> {
    const url = new URL(`${THREADS_API_ORIGIN}/access_token`);
    url.searchParams.set('grant_type', 'th_exchange_token');
    url.searchParams.set('client_secret', this.config.appSecret);
    url.searchParams.set('access_token', shortLivedToken);
    return this.readToken(url, 'the long-lived token exchange');
  }

  /** A long-lived token at least a day old → a fresh 60-day one. */
  async refresh(longLivedToken: string): Promise<Result<ThreadsToken>> {
    const url = new URL(`${THREADS_API_ORIGIN}/refresh_access_token`);
    url.searchParams.set('grant_type', 'th_refresh_token');
    url.searchParams.set('access_token', longLivedToken);
    return this.readToken(url, 'refreshing the Threads login');
  }

  private async readToken(
    url: URL,
    what: string
  ): Promise<Result<ThreadsToken>> {
    const response = await this.request(
      url.toString(),
      { method: 'GET' },
      what
    );
    if (!response.ok) return response;
    const value = response.value as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    if (typeof value.access_token !== 'string' || value.access_token === '') {
      return err(`Threads returned no access token for ${what}.`);
    }
    return ok({
      accessToken: value.access_token,
      expiresAt: expiryFromSeconds(value.expires_in, this.now()),
    });
  }

  /** The account the token belongs to. */
  async profile(accessToken: string): Promise<Result<ThreadsProfile>> {
    const response = await this.get(
      '/me',
      accessToken,
      { fields: 'id,username' },
      'the account'
    );
    if (!response.ok) return response;
    const value = response.value as { id?: unknown; username?: unknown };
    if (typeof value.id !== 'string' || value.id === '') {
      return err('Threads returned no account id for this login.');
    }
    return ok({
      id: value.id,
      username:
        typeof value.username === 'string' && value.username !== ''
          ? value.username
          : null,
    });
  }

  /** Step 1 of a post: a container for the image at `imageUrl` (Threads fetches it) and the text. */
  async createImageContainer(
    userId: string,
    accessToken: string,
    imageUrl: string,
    text: string
  ): Promise<Result<string>> {
    const params: Record<string, string> = {
      media_type: 'IMAGE',
      image_url: imageUrl,
    };
    if (text !== '') params['text'] = text;
    const response = await this.post(
      `/${encodeURIComponent(userId)}/threads`,
      accessToken,
      params,
      `the Threads media container for account ${userId}`
    );
    if (!response.ok) return response;
    const id: unknown = (response.value as { id?: unknown }).id;
    return typeof id === 'string' && id !== ''
      ? ok(id)
      : err(
          `Threads accepted the image for account ${userId} but returned no container id`
        );
  }

  /** Whether Threads has fetched and processed the container's image yet. */
  async containerStatus(
    containerId: string,
    accessToken: string
  ): Promise<Result<ThreadsContainerStatus>> {
    const response = await this.get(
      `/${encodeURIComponent(containerId)}`,
      accessToken,
      { fields: 'status,error_message' },
      `the status of Threads container ${containerId}`
    );
    if (!response.ok) return response;
    const value = response.value as {
      status?: unknown;
      error_message?: unknown;
    };
    if (typeof value.status !== 'string') {
      return err(`Threads returned no status for container ${containerId}`);
    }
    return ok({
      status: value.status,
      errorMessage:
        typeof value.error_message === 'string' ? value.error_message : '',
    });
  }

  /** Step 2: publishes a FINISHED container. Returns the post's id. */
  async publishContainer(
    userId: string,
    accessToken: string,
    containerId: string
  ): Promise<Result<string>> {
    const response = await this.post(
      `/${encodeURIComponent(userId)}/threads_publish`,
      accessToken,
      { creation_id: containerId },
      `publishing Threads container ${containerId}`
    );
    if (!response.ok) return response;
    const id: unknown = (response.value as { id?: unknown }).id;
    return typeof id === 'string' && id !== ''
      ? ok(id)
      : err(
          `Threads published container ${containerId} but returned no post id`
        );
  }

  /** The public link to a post; null if Threads doesn't give one. */
  async permalink(
    mediaId: string,
    accessToken: string
  ): Promise<Result<string | null>> {
    const response = await this.get(
      `/${encodeURIComponent(mediaId)}`,
      accessToken,
      { fields: 'permalink' },
      `the link to Threads post ${mediaId}`
    );
    if (!response.ok) return response;
    const link: unknown = (response.value as { permalink?: unknown }).permalink;
    return ok(
      typeof link === 'string' && link.startsWith('https://') ? link : null
    );
  }

  private post(
    path: string,
    accessToken: string,
    params: Readonly<Record<string, string>>,
    what: string
  ): Promise<Result<unknown>> {
    const body = new URLSearchParams(params);
    body.set('access_token', accessToken);
    return this.request(
      `${this.apiBase}${path}`,
      { method: 'POST', body },
      what
    );
  }

  private get(
    path: string,
    accessToken: string,
    params: Readonly<Record<string, string>>,
    what: string
  ): Promise<Result<unknown>> {
    const url = new URL(`${this.apiBase}${path}`);
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value);
    url.searchParams.set('access_token', accessToken);
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
        `Could not reach Threads for ${what}: ${describeUnknownError(cause)}`,
        cause
      );
    }
    const body: unknown = await readBody(response);
    if (!response.ok)
      return err(describeThreadsError(what, response.status, body));
    return ok(body);
  }
}
