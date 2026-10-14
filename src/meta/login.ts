import { randomState } from '../encoding.js';
import { silentLogger, type SocialLogger } from '../logger.js';
import {
  checkAuthorizationUrl,
  type ListenForCallback,
  type LoginAttempt,
} from '../oauth.js';
import { err, ok, type Result } from '../result.js';
import { FACEBOOK_REQUIRED_SCOPES, type MetaConfig } from './config.js';
import type {
  MetaGraphClient,
  MetaPage,
  PageList,
  UnavailablePage,
} from './graph.js';
import { choosePage, type MetaLogin, type MetaLoginStore } from './token.js';

/**
 * The Meta login: a callback listener, Facebook's consent page, then the
 * code → short-lived → long-lived token exchange, the granted permissions
 * and the owner's Pages, saved through the store.
 */

/** After the redirect: everything that turns a code into a saved login. Exported for tests. */
export async function completeMetaLogin(
  code: string,
  config: MetaConfig,
  graph: MetaGraphClient,
  store: MetaLoginStore,
  now: Date,
  logger: SocialLogger = silentLogger
): Promise<Result<MetaLogin>> {
  const shortLived = await graph.exchangeCode(code);
  if (!shortLived.ok) return shortLived;
  const longLived = await graph.extendUserToken(shortLived.value.accessToken);
  if (!longLived.ok) return longLived;
  const userToken: string = longLived.value.accessToken;

  const granted = await graph.grantedPermissions(userToken);
  if (!granted.ok) return granted;
  const listed = await graph.listPages(userToken);
  if (!listed.ok) return listed;
  const pageList = await addGrantedPages(
    graph,
    userToken,
    listed.value,
    logger
  );
  const pages = { value: pageList.pages };

  const previous = await store.load();
  const login: MetaLogin = {
    userAccessToken: userToken,
    userTokenExpiresAt: longLived.value.expiresAt?.toISOString() ?? null,
    grantedScopes: granted.value,
    pages: pages.value,
    unavailablePages: pageList.unavailable,
    selectedPageId: choosePage(
      pages.value,
      config.preferredPageId,
      previous.ok ? (previous.value?.selectedPageId ?? null) : null
    ),
    savedAt: now.toISOString(),
  };
  const saved = await store.save(login);
  if (!saved.ok) return saved;

  const missing: string[] = FACEBOOK_REQUIRED_SCOPES.filter(
    (scope) => !login.grantedScopes.includes(scope)
  );
  logger.info(
    `Saved the Facebook login (app ${config.appId}): ${login.pages.length} Page(s)` +
      ` (${login.pages.map((page) => `"${page.name}" ${page.id}`).join(', ')})` +
      `${missing.length > 0 ? `, missing ${missing.join(', ')}` : ''}.`
  );
  for (const page of login.unavailablePages) {
    logger.warn(
      `Facebook Page ${page.name ?? ''} ${page.id} can't be posted to: ${page.reason}`
    );
  }
  return ok(login);
}

/** Most Pages asked for one by one after a login. */
const MAX_EXTRA_PAGE_LOOKUPS = 25;

/**
 * `/me/accounts` plus any Page granted in the dialog that it left out,
 * read by id. A failure to read the grants only costs those extra Pages.
 */
export async function addGrantedPages(
  graph: Pick<MetaGraphClient, 'grantedPageIds' | 'getPage'>,
  userToken: string,
  listed: PageList,
  logger: SocialLogger = silentLogger
): Promise<PageList> {
  const granted = await graph.grantedPageIds(userToken);
  if (!granted.ok) {
    logger.warn(
      `Couldn't read which Pages the Facebook login was granted: ${granted.error}`
    );
    return listed;
  }
  const known = new Set<string>([
    ...listed.pages.map((page) => page.id),
    ...listed.unavailable.map((page) => page.id),
  ]);
  const pages: MetaPage[] = [...listed.pages];
  const unavailable: UnavailablePage[] = [...listed.unavailable];
  for (const pageId of granted.value
    .filter((id) => !known.has(id))
    .slice(0, MAX_EXTRA_PAGE_LOOKUPS)) {
    const extra = await graph.getPage(pageId, userToken);
    pages.push(...extra.pages);
    unavailable.push(...extra.unavailable);
  }
  // A Page found by id replaces an earlier "unavailable" row for it.
  const usable = new Set<string>(pages.map((page) => page.id));
  return {
    pages,
    unavailable: unavailable.filter((page) => !usable.has(page.id)),
  };
}

export interface StartLoginOptions {
  /** Catches the redirect; `listenForCallback` from the ./node subpath on Node. */
  readonly listen: ListenForCallback;
  readonly now?: () => Date;
  readonly logger?: SocialLogger;
}

/** Opens the callback listener, then returns Facebook's consent URL and the completion. */
export async function startMetaLogin(
  config: MetaConfig,
  graph: MetaGraphClient,
  store: MetaLoginStore,
  options: StartLoginOptions
): Promise<Result<LoginAttempt>> {
  const now: () => Date = options.now ?? (() => new Date());
  const state: string = randomState();
  const listening = await options.listen({
    port: config.callbackPort,
    pathPrefix: config.callbackPath,
    providerName: 'Facebook',
    expectedState: state,
  });
  if (!listening.ok) return listening;

  const completion = listening.value.callback.then(
    async (callback): Promise<Result<void>> => {
      if (!callback.ok) return callback;
      const completed = await completeMetaLogin(
        callback.value.code,
        config,
        graph,
        store,
        now(),
        options.logger
      );
      return completed.ok
        ? ok(undefined)
        : err(completed.error, completed.cause);
    }
  );
  return ok({ authorizationUrl: graph.authorizationUrl(state), completion });
}

/** Only https Facebook consent pages are handed to the browser. */
export function checkMetaAuthorizationUrl(url: string): Result<string> {
  return checkAuthorizationUrl(
    url,
    ['www.facebook.com', 'facebook.com'],
    'Facebook'
  );
}
