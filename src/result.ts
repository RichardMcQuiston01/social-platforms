/**
 * A small Result type. Every function in this package returns one instead
 * of throwing, so callers have to look at the outcome. Error messages name
 * the network, what was being done and, for HTTP, the status and the
 * network's own message.
 */

export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Err {
  readonly ok: false;
  readonly error: string;
  readonly cause?: unknown;
}

export type Result<T> = Ok<T> | Err;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err(error: string, cause?: unknown): Err {
  return cause === undefined
    ? { ok: false, error }
    : { ok: false, error, cause };
}

/** Turns an unknown thrown value into a readable message. */
export function describeUnknownError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}
