import { textToBase64 } from '../encoding.js';
import { expiryFromSeconds, readBody, type FetchLike } from '../http.js';
import { describeUnknownError, err, ok, type Result } from '../result.js';
import {
  PINTEREST_API_BASES,
  PINTEREST_AUTHORIZE_URL,
  PINTEREST_SCOPES,
  type PinterestConfig,
} from './config.js';

/**
 * A thin client for the Pinterest API v5 calls posting needs: the
 * login (code → tokens, refreshing them), the account, the owner's boards
 * (and making one), and creating a Pin from an image sent inline. No SDK;
 * `fetch` is injected so tests run without the network. Every call goes to
 * the configured environment (sandbox or production).
 */

export interface PinterestTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: Date | null;
  readonly refreshTokenExpiresAt: Date | null;
  readonly scopes: readonly string[];
}

export interface PinterestAccount {
  readonly username: string;
  /** BUSINESS or PINNER. */
  readonly accountType: string;
}

export interface PinterestBoard {
  readonly id: string;
  readonly name: string;
  /** PUBLIC, PROTECTED or SECRET. */
  readonly privacy: string;
}

export interface CreatePinRequest {
  readonly boardId: string;
  readonly title: string;
  readonly description: string;
  readonly link: string;
  readonly altText: string;
  readonly jpegBase64: string;
}

/** Pinterest's limits on a Pin's text. */
export const PIN_TITLE_MAX = 100;
export const PIN_DESCRIPTION_MAX = 800;
export const PIN_ALT_TEXT_MAX = 500;
/** Pages of boards read at most (100 a page). */
const MAX_BOARD_PAGES = 10;

/** The public link to a Pin. */
export function pinPermalink(pinId: string): string {
  return `https://www.pinterest.com/pin/${encodeURIComponent(pinId)}/`;
}

/** Pinterest's error as one specific line, with the fix for the common cases. */
export function describePinterestError(
  what: string,
  status: number,
  body: unknown
): string {
  const record = (typeof body === 'object' && body !== null ? body : {}) as {
    code?: unknown;
    message?: unknown;
  };
  const message: string =
    typeof record.message === 'string'
      ? record.message
      : typeof body === 'string' && body !== ''
        ? body.slice(0, 300)
        : 'no message';
  const code: string =
    typeof record.code === 'number' ? `, code ${record.code}` : '';
  let hint = '';
  if (status === 401) {
    hint =
      ' The Pinterest login has expired or was revoked; connect Pinterest again.';
  } else if (status === 403 && /trial/i.test(message)) {
    hint =
      " A Trial app can only post to the sandbox: set the account's environment to sandbox and connect again.";
  } else if (status === 403 && /scope|permission/i.test(message)) {
    hint = ` A permission is missing: connect Pinterest again and allow ${PINTEREST_SCOPES.join(', ')}.`;
  } else if (status === 429) {
    hint = " Pinterest's rate limit was reached; try again later.";
  }
  return `Pinterest refused ${what} (HTTP ${status}${code}): ${message}.${hint}`;
}

export class PinterestClient {
  constructor(
    private readonly config: PinterestConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => Date = () => new Date()
  ) {}

  private get apiBase(): string {
    return PINTEREST_API_BASES[this.config.environment];
  }

  /** The consent page on pinterest.com. */
  authorizationUrl(state: string): string {
    const url = new URL(PINTEREST_AUTHORIZE_URL);
    url.searchParams.set('client_id', this.config.appId);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', PINTEREST_SCOPES.join(','));
    url.searchParams.set('state', state);
    return url.toString();
  }

  /** The redirect's code → an access token and a refresh token. */
  exchangeCode(code: string): Promise<Result<PinterestTokens>> {
    return this.token(
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.config.redirectUri,
        continuous_refresh: 'true',
      },
      'the login code',
      null
    );
  }

  /** A refresh token → a new access token (and, usually, a new refresh token). */
  refresh(refreshToken: string): Promise<Result<PinterestTokens>> {
    return this.token(
      { grant_type: 'refresh_token', refresh_token: refreshToken },
      'refreshing the Pinterest login',
      refreshToken
    );
  }

  private async token(
    params: Readonly<Record<string, string>>,
    what: string,
    previousRefreshToken: string | null
  ): Promise<Result<PinterestTokens>> {
    const response = await this.request(
      `${this.apiBase}/oauth/token`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${textToBase64(`${this.config.appId}:${this.config.appSecret}`)}`,
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams(params),
      },
      what
    );
    if (!response.ok) return response;
    const value = response.value as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
      refresh_token_expires_in?: unknown;
      scope?: unknown;
    };
    if (typeof value.access_token !== 'string' || value.access_token === '') {
      return err(`Pinterest returned no access token for ${what}.`);
    }
    const refreshToken: string | null =
      typeof value.refresh_token === 'string' && value.refresh_token !== ''
        ? value.refresh_token
        : previousRefreshToken;
    if (refreshToken === null) {
      return err(`Pinterest returned no refresh token for ${what}.`);
    }
    const now: Date = this.now();
    return ok({
      accessToken: value.access_token,
      refreshToken,
      expiresAt: expiryFromSeconds(value.expires_in, now),
      refreshTokenExpiresAt: expiryFromSeconds(
        value.refresh_token_expires_in,
        now
      ),
      scopes:
        typeof value.scope === 'string'
          ? value.scope.split(/[\s,]+/).filter((scope) => scope !== '')
          : [],
    });
  }

  /** The account the token belongs to. */
  async account(accessToken: string): Promise<Result<PinterestAccount>> {
    const response = await this.get(
      '/user_account',
      accessToken,
      {},
      'the account'
    );
    if (!response.ok) return response;
    const value = response.value as {
      username?: unknown;
      account_type?: unknown;
    };
    if (typeof value.username !== 'string' || value.username === '') {
      return err('Pinterest returned no username for this login.');
    }
    return ok({
      username: value.username,
      accountType:
        typeof value.account_type === 'string' ? value.account_type : '',
    });
  }

  /** The owner's boards, A–Z (at most 1,000). */
  async listBoards(accessToken: string): Promise<Result<PinterestBoard[]>> {
    const boards: PinterestBoard[] = [];
    let bookmark: string | null = null;
    for (let page = 0; page < MAX_BOARD_PAGES; page += 1) {
      const params: Record<string, string> = { page_size: '100' };
      if (bookmark !== null) params['bookmark'] = bookmark;
      const response = await this.get(
        '/boards',
        accessToken,
        params,
        'the boards'
      );
      if (!response.ok) return response;
      const value = response.value as { items?: unknown; bookmark?: unknown };
      for (const item of Array.isArray(value.items) ? value.items : []) {
        const board = toBoard(item);
        if (board !== null) boards.push(board);
      }
      bookmark =
        typeof value.bookmark === 'string' && value.bookmark !== ''
          ? value.bookmark
          : null;
      if (bookmark === null) break;
    }
    return ok(boards.sort((a, b) => a.name.localeCompare(b.name)));
  }

  /** Makes a board on the owner's account. */
  async createBoard(
    accessToken: string,
    name: string,
    privacy: 'PUBLIC' | 'SECRET'
  ): Promise<Result<PinterestBoard>> {
    const response = await this.send(
      '/boards',
      accessToken,
      { name, privacy },
      `creating the board "${name}"`
    );
    if (!response.ok) return response;
    const board = toBoard(response.value);
    return board === null
      ? err(`Pinterest made the board "${name}" but returned no id for it.`)
      : ok(board);
  }

  /** Creates a Pin on one of the owner's boards; returns its id. */
  async createPin(
    accessToken: string,
    pin: CreatePinRequest
  ): Promise<Result<string>> {
    const body: Record<string, unknown> = {
      board_id: pin.boardId,
      title: pin.title,
      description: pin.description,
      link: pin.link,
      media_source: {
        source_type: 'image_base64',
        content_type: 'image/jpeg',
        data: pin.jpegBase64,
      },
    };
    if (pin.altText !== '') body['alt_text'] = pin.altText;
    const response = await this.send(
      '/pins',
      accessToken,
      body,
      `the Pin for board ${pin.boardId}`
    );
    if (!response.ok) return response;
    const id: unknown = (response.value as { id?: unknown }).id;
    return typeof id === 'string' && id !== ''
      ? ok(id)
      : err(
          `Pinterest accepted the Pin for board ${pin.boardId} but returned no id`
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
    return this.request(
      url.toString(),
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json',
        },
      },
      what
    );
  }

  private send(
    path: string,
    accessToken: string,
    body: unknown,
    what: string
  ): Promise<Result<unknown>> {
    return this.request(
      `${this.apiBase}${path}`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
      },
      what
    );
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
        `Could not reach Pinterest for ${what}: ${describeUnknownError(cause)}`,
        cause
      );
    }
    const body: unknown = await readBody(response);
    if (!response.ok)
      return err(describePinterestError(what, response.status, body));
    return ok(body);
  }
}

function toBoard(item: unknown): PinterestBoard | null {
  const value = (typeof item === 'object' && item !== null ? item : {}) as {
    id?: unknown;
    name?: unknown;
    privacy?: unknown;
  };
  if (typeof value.id !== 'string' || value.id === '') return null;
  return {
    id: value.id,
    name:
      typeof value.name === 'string' && value.name !== ''
        ? value.name
        : value.id,
    privacy: typeof value.privacy === 'string' ? value.privacy : 'PUBLIC',
  };
}
