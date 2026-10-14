import { randomState } from '../encoding.js';
import { silentLogger, type SocialLogger } from '../logger.js';
import {
  checkAuthorizationUrl,
  parseRedirectAddress,
  type CallbackListener,
  type CallbackResult,
  type ListenForCallback,
  type LoginProgress,
} from '../oauth.js';
import { describeUnknownError, err, ok, type Result } from '../result.js';
import type { ThreadsConfig } from './config.js';
import type { ThreadsClient } from './graph.js';
import {
  threadsTokenDueForRefresh,
  threadsTokenExpired,
  type ThreadsLogin,
  type ThreadsLoginStore,
} from './token.js';

/**
 * The Threads login. Threads
 * only redirects to https, so the redirect is caught one of two ways: a
 * local https listener (when a certificate is configured), or the owner
 * pasting the address the browser ended on. Either way the `state` must
 * match the login that was started, then the code becomes a 60-day token.
 */

/** How long a started login waits for its redirect to be pasted. */
export const PASTE_TIMEOUT_MS: number = 15 * 60 * 1000;

/** The code and state from the address Threads redirected to, or what's wrong with it. */
export function parseThreadsRedirectAddress(
  text: string,
  redirectUri: string
): Result<CallbackResult> {
  return parseRedirectAddress(text, redirectUri, 'Threads');
}

/** After the redirect: code → short-lived → long-lived token, the account, saved. Exported for tests. */
export async function completeThreadsLogin(
  code: string,
  client: ThreadsClient,
  store: ThreadsLoginStore,
  now: Date,
  logger: SocialLogger = silentLogger
): Promise<Result<ThreadsLogin>> {
  const shortLived = await client.exchangeCode(code);
  if (!shortLived.ok) return shortLived;
  const longLived = await client.exchangeForLongLived(
    shortLived.value.accessToken
  );
  if (!longLived.ok) return longLived;
  const profile = await client.profile(longLived.value.accessToken);
  if (!profile.ok) return profile;
  if (
    shortLived.value.userId !== '' &&
    shortLived.value.userId !== profile.value.id
  ) {
    return err(
      `Threads gave account ${shortLived.value.userId} for the login but ${profile.value.id} for its profile; nothing was saved. Connect again.`
    );
  }
  const login: ThreadsLogin = {
    accessToken: longLived.value.accessToken,
    userId: profile.value.id,
    username: profile.value.username,
    expiresAt: longLived.value.expiresAt?.toISOString() ?? null,
    tokenIssuedAt: now.toISOString(),
    savedAt: now.toISOString(),
  };
  const saved = await store.save(login);
  if (!saved.ok) return saved;
  logger.info(
    `Saved the Threads login for ${login.username === null ? `account ${login.userId}` : `@${login.username}`}${login.expiresAt === null ? '' : `, valid until ${login.expiresAt.slice(0, 10)}`}.`
  );
  return ok(login);
}

/**
 * Refreshes the saved token when it's due (within 30 days of running out,
 * and at least a day old). Returns the login to use; a failed refresh
 * keeps the old token, which still works until it expires.
 */
export async function refreshThreadsLoginIfDue(
  client: ThreadsClient,
  store: ThreadsLoginStore,
  now: Date,
  logger: SocialLogger = silentLogger
): Promise<Result<ThreadsLogin | null>> {
  const loaded = await store.load();
  if (!loaded.ok || loaded.value === null) return loaded;
  const login: ThreadsLogin = loaded.value;
  if (threadsTokenExpired(login, now)) {
    return err(
      `The Threads login expired on ${login.expiresAt?.slice(0, 10) ?? 'an unknown date'}; connect Threads again.`
    );
  }
  if (!threadsTokenDueForRefresh(login, now)) return ok(login);
  const refreshed = await client.refresh(login.accessToken);
  if (!refreshed.ok) {
    logger.warn(
      `Couldn't refresh the Threads login (it still works until it expires): ${refreshed.error}`
    );
    return ok(login);
  }
  const next: ThreadsLogin = {
    ...login,
    accessToken: refreshed.value.accessToken,
    expiresAt: refreshed.value.expiresAt?.toISOString() ?? null,
    tokenIssuedAt: now.toISOString(),
  };
  const saved = await store.save(next);
  if (!saved.ok) {
    logger.warn(
      `Refreshed the Threads login but couldn't save it: ${saved.error}`
    );
    return ok(next);
  }
  logger.info(
    `Refreshed the Threads login${next.expiresAt === null ? '' : `; valid until ${next.expiresAt.slice(0, 10)}`}.`
  );
  return ok(next);
}

/** Only https Threads consent pages are handed to the browser. */
export function checkThreadsAuthorizationUrl(url: string): Result<string> {
  return checkAuthorizationUrl(
    url,
    ['threads.net', 'www.threads.net', 'threads.com', 'www.threads.com'],
    'Threads'
  );
}

/** The Threads login's progress, plus how the redirect will come back. */
export interface ThreadsLoginProgress extends LoginProgress {
  /** True when a local https listener catches the redirect; false means paste it. */
  readonly listening: boolean;
}

export interface ThreadsLoginSessionOptions {
  /** Catches the redirect; `listenForCallback` from the ./node subpath on Node. */
  readonly listen: ListenForCallback;
  /** The certificate and key, read when a login starts (`readTlsFiles` from ./node). */
  readonly readTls: () => Promise<Result<{ cert: string; key: string }>>;
  readonly now?: () => Date;
  readonly logger?: SocialLogger;
}

interface PendingLogin {
  readonly state: string;
  readonly authorizationUrl: string;
  readonly startedAt: Date;
  readonly listener: CallbackListener | null;
}

/**
 * One Threads login at a time. `begin` starts it (or returns the one
 * waiting); the redirect comes back through the listener or
 * `submitRedirect`, whichever is first.
 */
export class ThreadsLoginSession {
  private pending: PendingLogin | null = null;
  private lastError: string | null = null;
  private lastConnectedAt: Date | null = null;

  private readonly now: () => Date;
  private readonly logger: SocialLogger;

  constructor(
    private readonly config: ThreadsConfig,
    private readonly client: ThreadsClient,
    private readonly store: ThreadsLoginStore,
    private readonly options: ThreadsLoginSessionOptions
  ) {
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? silentLogger;
  }

  async begin(): Promise<
    Result<{ authorizationUrl: string; listening: boolean }>
  > {
    const current = this.pending;
    if (
      current !== null &&
      this.now().getTime() - current.startedAt.getTime() < PASTE_TIMEOUT_MS
    ) {
      return ok({
        authorizationUrl: current.authorizationUrl,
        listening: current.listener !== null,
      });
    }
    current?.listener?.close();
    this.pending = null;
    this.lastError = null;

    const state: string = randomState();
    let listener: CallbackListener | null = null;
    const listenerConfig = this.config.listener;
    if (listenerConfig !== null) {
      const tls = await this.options.readTls();
      if (!tls.ok) {
        this.lastError = tls.error;
        return tls;
      }
      const listening = await this.options.listen({
        port: listenerConfig.port,
        pathPrefix: listenerConfig.path,
        providerName: 'Threads',
        expectedState: state,
        tls: tls.value,
      });
      if (!listening.ok) {
        this.lastError = listening.error;
        return listening;
      }
      listener = listening.value;
    }

    const authorizationUrl: string = this.client.authorizationUrl(state);
    const pending: PendingLogin = {
      state,
      authorizationUrl,
      startedAt: this.now(),
      listener,
    };
    this.pending = pending;
    if (listener !== null) {
      void listener.callback.then(async (callback) => {
        if (this.pending !== pending) return;
        this.pending = null;
        if (!callback.ok) {
          this.lastError = callback.error;
          return;
        }
        await this.complete(callback.value.code);
      });
    }
    return ok({ authorizationUrl, listening: listener !== null });
  }

  /** The address the browser ended on after allowing access, pasted by the owner. */
  async submitRedirect(address: string): Promise<Result<ThreadsLogin>> {
    const pending = this.pending;
    if (pending === null) {
      return err(
        'No Threads login is waiting; click Connect Threads first, then paste the address.'
      );
    }
    if (
      this.now().getTime() - pending.startedAt.getTime() >=
      PASTE_TIMEOUT_MS
    ) {
      pending.listener?.close();
      this.pending = null;
      return err(
        `That login was started more than ${PASTE_TIMEOUT_MS / 60_000} minutes ago; click Connect Threads again.`
      );
    }
    const parsed = parseThreadsRedirectAddress(
      address,
      this.config.redirectUri
    );
    if (!parsed.ok) return parsed;
    if (parsed.value.state !== pending.state) {
      return err(
        "That address is from a different login attempt (its state doesn't match); click Connect Threads again and paste the new address."
      );
    }
    pending.listener?.close();
    this.pending = null;
    return this.complete(parsed.value.code);
  }

  private async complete(code: string): Promise<Result<ThreadsLogin>> {
    try {
      const completed = await completeThreadsLogin(
        code,
        this.client,
        this.store,
        this.now(),
        this.logger
      );
      if (completed.ok) {
        this.lastConnectedAt = this.now();
        this.lastError = null;
      } else {
        this.lastError = completed.error;
      }
      return completed;
    } catch (cause: unknown) {
      this.lastError = `The Threads login failed unexpectedly: ${describeUnknownError(cause)}`;
      return err(this.lastError, cause);
    }
  }

  progress(): ThreadsLoginProgress {
    const pending = this.pending;
    const live: boolean =
      pending !== null &&
      this.now().getTime() - pending.startedAt.getTime() < PASTE_TIMEOUT_MS;
    return {
      inProgress: live,
      authorizationUrl: live ? (pending?.authorizationUrl ?? null) : null,
      startedAt: live ? (pending?.startedAt.toISOString() ?? null) : null,
      lastError: this.lastError,
      lastConnectedAt: this.lastConnectedAt?.toISOString() ?? null,
      listening: this.config.listener !== null,
    };
  }
}
