import type { LoginStore } from '../oauth.js';
import { describeUnknownError, err, ok, type Result } from '../result.js';
import { isPinterestEnvironment, type PinterestEnvironment } from './config.js';

/**
 * The saved Pinterest login: an access token (about 30 days), the refresh
 * token that renews it (Pinterest rotates it on each refresh), the
 * account's name and the board Pins go to by default. Stored encrypted in
 * social_account_token, never sent to the browser.
 */
export interface PinterestLogin {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** ISO; null when Pinterest didn't say. */
  readonly expiresAt: string | null;
  /** ISO; null when Pinterest didn't say. */
  readonly refreshTokenExpiresAt: string | null;
  readonly scopes: readonly string[];
  readonly username: string;
  /** BUSINESS or PINNER, as Pinterest reports it. */
  readonly accountType: string;
  /** Which API the tokens belong to; they don't work in the other one. */
  readonly environment: PinterestEnvironment;
  /** The board to offer first; null until one is chosen. */
  readonly defaultBoardId: string | null;
  readonly defaultBoardName: string | null;
  /** ISO, when the current access token was issued. */
  readonly tokenIssuedAt: string;
  /** ISO, when this login was first saved. */
  readonly savedAt: string;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Reads a saved login, or explains what's wrong with it. */
export function parsePinterestLogin(raw: string): Result<PinterestLogin> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause: unknown) {
    return err(`not valid JSON: ${describeUnknownError(cause)}`, cause);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return err('not a JSON object');
  }
  const value = parsed as Partial<Record<keyof PinterestLogin, unknown>>;
  if (typeof value.accessToken !== 'string' || value.accessToken === '') {
    return err('no accessToken');
  }
  if (typeof value.refreshToken !== 'string' || value.refreshToken === '') {
    return err('no refreshToken');
  }
  if (typeof value.username !== 'string' || value.username === '')
    return err('no username');
  if (!isPinterestEnvironment(value.environment)) return err('no environment');
  const savedAt: string =
    typeof value.savedAt === 'string'
      ? value.savedAt
      : new Date(0).toISOString();
  return ok({
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: optionalString(value.expiresAt),
    refreshTokenExpiresAt: optionalString(value.refreshTokenExpiresAt),
    scopes: Array.isArray(value.scopes)
      ? value.scopes.filter(
          (scope): scope is string => typeof scope === 'string'
        )
      : [],
    username: value.username,
    accountType: typeof value.accountType === 'string' ? value.accountType : '',
    environment: value.environment,
    defaultBoardId: optionalString(value.defaultBoardId),
    defaultBoardName: optionalString(value.defaultBoardName),
    tokenIssuedAt:
      typeof value.tokenIssuedAt === 'string' ? value.tokenIssuedAt : savedAt,
    savedAt,
  });
}

/** Refresh once the access token has less than this left. */
export const PINTEREST_REFRESH_WHEN_LEFT_MS: number = 3 * 24 * 60 * 60 * 1000;

/** Whether the access token should be refreshed now: under 3 days left, or already expired. */
export function pinterestTokenDueForRefresh(
  login: PinterestLogin,
  now: Date
): boolean {
  if (login.expiresAt === null) return false;
  return (
    Date.parse(login.expiresAt) - now.getTime() < PINTEREST_REFRESH_WHEN_LEFT_MS
  );
}

/** Whether the refresh token has run out too (only connecting again helps then). */
export function pinterestLoginExpired(
  login: PinterestLogin,
  now: Date
): boolean {
  return (
    login.refreshTokenExpiresAt !== null &&
    Date.parse(login.refreshTokenExpiresAt) <= now.getTime()
  );
}

/** Where the app keeps the Pinterest login (file, database...); encrypt it at rest. */
export type PinterestLoginStore = LoginStore<PinterestLogin>;
