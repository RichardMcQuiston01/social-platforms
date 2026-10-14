/** The `fetch` the clients use; injected so tests and proxies can stand in. */
export type FetchLike = (
  input: string,
  init?: RequestInit
) => Promise<Response>;

/** "in 5184000 seconds" → a date; null when absent or nonsense. */
export function expiryFromSeconds(expiresIn: unknown, now: Date): Date | null {
  if (
    typeof expiresIn !== 'number' ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0
  ) {
    return null;
  }
  return new Date(now.getTime() + expiresIn * 1000);
}

/** A response body as JSON when it parses, else its text ({} when empty). */
export async function readBody(response: Response): Promise<unknown> {
  const text: string = await response.text().catch(() => '');
  if (text === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
