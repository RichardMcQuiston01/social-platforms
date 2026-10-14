import { randomState } from '../encoding.js';
import { silentLogger, type SocialLogger } from '../logger.js';
import {
  checkAuthorizationUrl,
  type ListenForCallback,
  type LoginAttempt,
} from '../oauth.js';
import { err, ok, type Result } from '../result.js';
import type { PinterestClient } from './api.js';
import type { PinterestConfig } from './config.js';
import {
  pinterestLoginExpired,
  pinterestTokenDueForRefresh,
  type PinterestLogin,
  type PinterestLoginStore,
} from './token.js';

/**
 * The Pinterest login: a callback listener (Pinterest allows an http
 * localhost redirect),
 * the consent page on pinterest.com, then the code → tokens exchange and
 * the account's name, saved through the store.
 */

/** After the redirect: code → tokens → account, saved. Exported for tests. */
export async function completePinterestLogin(
  code: string,
  config: PinterestConfig,
  client: PinterestClient,
  store: PinterestLoginStore,
  now: Date,
  logger: SocialLogger = silentLogger
): Promise<Result<PinterestLogin>> {
  const tokens = await client.exchangeCode(code);
  if (!tokens.ok) return tokens;
  const account = await client.account(tokens.value.accessToken);
  if (!account.ok) return account;
  // Keep the default board when the same account connects again in the same environment.
  const previous = await store.load();
  const kept: PinterestLogin | null =
    previous.ok &&
    previous.value !== null &&
    previous.value.username === account.value.username &&
    previous.value.environment === config.environment
      ? previous.value
      : null;
  const login: PinterestLogin = {
    accessToken: tokens.value.accessToken,
    refreshToken: tokens.value.refreshToken,
    expiresAt: tokens.value.expiresAt?.toISOString() ?? null,
    refreshTokenExpiresAt:
      tokens.value.refreshTokenExpiresAt?.toISOString() ?? null,
    scopes: tokens.value.scopes,
    username: account.value.username,
    accountType: account.value.accountType,
    environment: config.environment,
    defaultBoardId: kept?.defaultBoardId ?? null,
    defaultBoardName: kept?.defaultBoardName ?? null,
    tokenIssuedAt: now.toISOString(),
    savedAt: now.toISOString(),
  };
  const saved = await store.save(login);
  if (!saved.ok) return saved;
  logger.info(
    `Saved the Pinterest login for ${login.username} (${config.environment}${login.accountType === '' ? '' : `, ${login.accountType}`})${login.expiresAt === null ? '' : `, token valid until ${login.expiresAt.slice(0, 10)}`}.`
  );
  if (login.accountType !== '' && login.accountType !== 'BUSINESS') {
    logger.warn(
      `Pinterest account ${login.username} is a ${login.accountType} account; newer apps may be refused its boards. Switch it to a Business account if posting fails.`
    );
  }
  return ok(login);
}

export interface StartPinterestLoginOptions {
  /** Catches the redirect; `listenForCallback` from the ./node subpath on Node. */
  readonly listen: ListenForCallback;
  readonly now?: () => Date;
  readonly logger?: SocialLogger;
}

/** Opens the callback listener, then returns Pinterest's consent URL and the completion. */
export async function startPinterestLogin(
  config: PinterestConfig,
  client: PinterestClient,
  store: PinterestLoginStore,
  options: StartPinterestLoginOptions
): Promise<Result<LoginAttempt>> {
  const now: () => Date = options.now ?? (() => new Date());
  const state: string = randomState();
  const listening = await options.listen({
    port: config.callbackPort,
    pathPrefix: config.callbackPath,
    providerName: 'Pinterest',
    expectedState: state,
  });
  if (!listening.ok) return listening;
  const completion = listening.value.callback.then(
    async (callback): Promise<Result<void>> => {
      if (!callback.ok) return callback;
      const completed = await completePinterestLogin(
        callback.value.code,
        config,
        client,
        store,
        now(),
        options.logger
      );
      return completed.ok
        ? ok(undefined)
        : err(completed.error, completed.cause);
    }
  );
  return ok({ authorizationUrl: client.authorizationUrl(state), completion });
}

/** Only https pinterest.com consent pages are handed to the browser. */
export function checkPinterestAuthorizationUrl(url: string): Result<string> {
  return checkAuthorizationUrl(
    url,
    ['www.pinterest.com', 'pinterest.com'],
    'Pinterest'
  );
}

/**
 * Refreshes the access token when it's due (under 3 days left). Pinterest
 * rotates the refresh token, so two refreshes at once would leave one with
 * a dead token: callers go through one PinterestRefresher per account.
 * A failed refresh keeps the old token while it still works.
 */
export class PinterestRefresher {
  private inFlight: Promise<Result<PinterestLogin | null>> | null = null;

  constructor(
    private readonly client: PinterestClient,
    private readonly store: PinterestLoginStore,
    private readonly logger: SocialLogger = silentLogger
  ) {}

  /** The login to use now, refreshed first if it's due. */
  current(now: Date): Promise<Result<PinterestLogin | null>> {
    if (this.inFlight !== null) return this.inFlight;
    const running = this.refreshIfDue(now).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = running;
    return running;
  }

  private async refreshIfDue(
    now: Date
  ): Promise<Result<PinterestLogin | null>> {
    const loaded = await this.store.load();
    if (!loaded.ok || loaded.value === null) return loaded;
    const login: PinterestLogin = loaded.value;
    if (pinterestLoginExpired(login, now)) {
      return err(
        `The Pinterest login expired on ${login.refreshTokenExpiresAt?.slice(0, 10) ?? 'an unknown date'}; connect Pinterest again.`
      );
    }
    if (!pinterestTokenDueForRefresh(login, now)) return ok(login);
    const refreshed = await this.client.refresh(login.refreshToken);
    const stillValid: boolean =
      login.expiresAt === null || Date.parse(login.expiresAt) > now.getTime();
    if (!refreshed.ok) {
      if (!stillValid) {
        return err(
          `The Pinterest token expired and couldn't be refreshed (${refreshed.error}); connect Pinterest again.`
        );
      }
      this.logger.warn(
        `Couldn't refresh the Pinterest login (it still works for now): ${refreshed.error}`
      );
      return ok(login);
    }
    const next: PinterestLogin = {
      ...login,
      accessToken: refreshed.value.accessToken,
      refreshToken: refreshed.value.refreshToken,
      expiresAt: refreshed.value.expiresAt?.toISOString() ?? null,
      refreshTokenExpiresAt:
        refreshed.value.refreshTokenExpiresAt?.toISOString() ??
        login.refreshTokenExpiresAt,
      scopes:
        refreshed.value.scopes.length > 0
          ? refreshed.value.scopes
          : login.scopes,
      tokenIssuedAt: now.toISOString(),
    };
    const saved = await this.store.save(next);
    if (!saved.ok) {
      // The old refresh token may be spent; this one must not be lost.
      this.logger.error(
        `Refreshed the Pinterest login but couldn't save it (${saved.error}); it's used for now, and connecting again may be needed after a restart.`
      );
      return ok(next);
    }
    this.logger.info(
      `Refreshed the Pinterest login${next.expiresAt === null ? '' : `; valid until ${next.expiresAt.slice(0, 10)}`}.`
    );
    return ok(next);
  }
}
