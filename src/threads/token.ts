import type { LoginStore } from '../oauth.js';
import { describeUnknownError, err, ok, type Result } from '../result.js';

/**
 * The saved Threads login: a long-lived (60-day) token, refreshed before it
 * runs out, and the account it belongs to. A bearer credential: keep it
 * encrypted, and never send it to a browser or log it.
 */
export interface ThreadsLogin {
  readonly accessToken: string;
  readonly userId: string;
  readonly username: string | null;
  /** ISO; null when Threads didn't say. */
  readonly expiresAt: string | null;
  /** ISO, when the token was issued or last refreshed (a refresh needs it 24 hours old). */
  readonly tokenIssuedAt: string;
  /** ISO, when this login was first saved. */
  readonly savedAt: string;
}

/** Reads a saved login (its JSON), or explains what's wrong with it. */
export function parseThreadsLogin(raw: string): Result<ThreadsLogin> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause: unknown) {
    return err(`not valid JSON: ${describeUnknownError(cause)}`, cause);
  }
  const value = parsed as Partial<Record<keyof ThreadsLogin, unknown>> | null;
  if (value === null || typeof value !== 'object')
    return err('not a JSON object');
  if (typeof value.accessToken !== 'string' || value.accessToken === '') {
    return err('no accessToken');
  }
  if (typeof value.userId !== 'string' || !/^\d+$/.test(value.userId))
    return err('no userId');
  const savedAt: string =
    typeof value.savedAt === 'string'
      ? value.savedAt
      : new Date(0).toISOString();
  return ok({
    accessToken: value.accessToken,
    userId: value.userId,
    username: typeof value.username === 'string' ? value.username : null,
    expiresAt: typeof value.expiresAt === 'string' ? value.expiresAt : null,
    tokenIssuedAt:
      typeof value.tokenIssuedAt === 'string' ? value.tokenIssuedAt : savedAt,
    savedAt,
  });
}

/** A refresh only works on a token at least this old. */
export const MIN_TOKEN_AGE_FOR_REFRESH_MS: number = 24 * 60 * 60 * 1000;
/** Refresh once the token has less than this left. */
export const REFRESH_WHEN_LEFT_MS: number = 30 * 24 * 60 * 60 * 1000;

/** Whether the token should be refreshed now: due within 30 days, and old enough to refresh. */
export function threadsTokenDueForRefresh(
  login: ThreadsLogin,
  now: Date
): boolean {
  if (
    now.getTime() - Date.parse(login.tokenIssuedAt) <
    MIN_TOKEN_AGE_FOR_REFRESH_MS
  )
    return false;
  if (login.expiresAt === null) return true;
  const left: number = Date.parse(login.expiresAt) - now.getTime();
  return left > 0 && left < REFRESH_WHEN_LEFT_MS;
}

/** Whether the token has run out (a refresh can't bring it back; connect again). */
export function threadsTokenExpired(login: ThreadsLogin, now: Date): boolean {
  return (
    login.expiresAt !== null && Date.parse(login.expiresAt) <= now.getTime()
  );
}

/** Where the app keeps the Threads login (file, database...); encrypt it at rest. */
export type ThreadsLoginStore = LoginStore<ThreadsLogin>;
