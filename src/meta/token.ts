import type { LoginStore } from '../oauth.js';
import { describeUnknownError, err, ok, type Result } from '../result.js';
import type { MetaPage, UnavailablePage } from './graph.js';

/**
 * The saved Meta login: the long-lived user token, what it was granted, the
 * owner's Pages with their (non-expiring) Page tokens, and the Page chosen
 * for posting. A bearer credential: keep it encrypted, and never send it
 * to a browser or log it.
 */
export interface MetaLogin {
  readonly userAccessToken: string;
  /** ISO; null when Meta didn't say. */
  readonly userTokenExpiresAt: string | null;
  readonly grantedScopes: readonly string[];
  readonly pages: readonly MetaPage[];
  /** Pages Facebook mentioned that can't be posted to, with the reason. */
  readonly unavailablePages: readonly UnavailablePage[];
  readonly selectedPageId: string | null;
  /** ISO, when this login was saved. */
  readonly savedAt: string;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

/** Reads a saved login (its JSON), or explains what's wrong with it. */
export function parseMetaLogin(raw: string): Result<MetaLogin> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause: unknown) {
    return err(`not valid JSON: ${describeUnknownError(cause)}`, cause);
  }
  const value = parsed as Partial<Record<keyof MetaLogin, unknown>> | null;
  if (value === null || typeof value !== 'object')
    return err('not a JSON object');
  if (
    typeof value.userAccessToken !== 'string' ||
    value.userAccessToken === ''
  ) {
    return err('no userAccessToken');
  }
  if (!Array.isArray(value.pages)) return err('no pages list');
  const pages: MetaPage[] = [];
  for (const page of value.pages as Array<
    Partial<Record<keyof MetaPage, unknown>>
  >) {
    if (
      typeof page.id !== 'string' ||
      typeof page.name !== 'string' ||
      typeof page.accessToken !== 'string'
    ) {
      return err('a page entry is missing its id, name or accessToken');
    }
    pages.push({
      id: page.id,
      name: page.name,
      accessToken: page.accessToken,
      tasks: isStringArray(page.tasks) ? page.tasks : [],
      instagramAccountId:
        typeof page.instagramAccountId === 'string'
          ? page.instagramAccountId
          : null,
      instagramUsername:
        typeof page.instagramUsername === 'string'
          ? page.instagramUsername
          : null,
    });
  }
  return ok({
    userAccessToken: value.userAccessToken,
    userTokenExpiresAt:
      typeof value.userTokenExpiresAt === 'string'
        ? value.userTokenExpiresAt
        : null,
    grantedScopes: isStringArray(value.grantedScopes)
      ? value.grantedScopes
      : [],
    pages,
    unavailablePages: Array.isArray(value.unavailablePages)
      ? (
          value.unavailablePages as Array<
            Partial<Record<keyof UnavailablePage, unknown>>
          >
        )
          .filter(
            (page) =>
              typeof page.id === 'string' && typeof page.reason === 'string'
          )
          .map((page) => ({
            id: page.id as string,
            name: typeof page.name === 'string' ? page.name : null,
            reason: page.reason as string,
          }))
      : [],
    selectedPageId:
      typeof value.selectedPageId === 'string' ? value.selectedPageId : null,
    savedAt:
      typeof value.savedAt === 'string'
        ? value.savedAt
        : new Date(0).toISOString(),
  });
}

/**
 * Which Page to post to after a login: the pinned one (MetaConfig's
 * `preferredPageId`), else the one the owner chose before (if it's still
 * there); otherwise null, and the owner picks. Never guessed, not even when
 * the login sees one Page: that Page may not be the right one.
 */
export function choosePage(
  pages: readonly MetaPage[],
  preferredPageId: string | null,
  previousPageId: string | null
): string | null {
  const ids: ReadonlySet<string> = new Set(pages.map((page) => page.id));
  if (preferredPageId !== null && ids.has(preferredPageId))
    return preferredPageId;
  if (previousPageId !== null && ids.has(previousPageId)) return previousPageId;
  return null;
}

/** Where the app keeps the Meta login (file, database...); encrypt it at rest. */
export type MetaLoginStore = LoginStore<MetaLogin>;
