import { describeUnknownError, err, ok, type Result } from './result.js';

/**
 * What the OAuth logins share: the redirect's code and state, a listener
 * that catches the redirect (Node's comes from the ./node subpath; any
 * other runtime can pass its own), the redirect-address checks, and a
 * session that runs one login at a time.
 */

export interface CallbackResult {
  readonly code: string;
  readonly state: string;
}

export interface CallbackListener {
  /** Settles with the code, an OAuth error, or a timeout. */
  readonly callback: Promise<Result<CallbackResult>>;
  /** Stops listening (e.g. the redirect was pasted instead). */
  close(): void;
}

export interface CallbackListenerOptions {
  /** Port on 127.0.0.1, from the redirect URI registered with the network. */
  readonly port: number;
  /** Requests whose path starts with this are the redirect. */
  readonly pathPrefix: string;
  /** "Facebook", "Pinterest": used in messages and the page shown. */
  readonly providerName: string;
  /** The `state` this login sent; any other value is refused. */
  readonly expectedState: string;
  /** PEM certificate and key: serve https instead of http. */
  readonly tls?: { readonly cert: string; readonly key: string };
}

/**
 * Opens a one-shot listener for the redirect. Resolves once it's listening,
 * so a busy port is reported before anyone is sent to the network.
 * `listenForCallback` from the ./node subpath is one.
 */
export type ListenForCallback = (
  options: CallbackListenerOptions
) => Promise<Result<CallbackListener>>;

/** A started login: the consent page to open, and its outcome. */
export interface LoginAttempt {
  readonly authorizationUrl: string;
  readonly completion: Promise<Result<void>>;
}

/** Where a login stands, for a status screen. No tokens. */
export interface LoginProgress {
  /** True while waiting for the network's redirect. */
  readonly inProgress: boolean;
  /** The consent page to open while in progress. */
  readonly authorizationUrl: string | null;
  readonly startedAt: string | null;
  /** Why the last attempt failed; cleared when a new one starts. */
  readonly lastError: string | null;
  readonly lastConnectedAt: string | null;
}

/** How a saved login is kept: the app decides where (file, database...). */
export interface LoginStore<T> {
  load(): Promise<Result<T | null>>;
  save(login: T): Promise<Result<void>>;
  clear(): Promise<Result<void>>;
}

/**
 * One login at a time: `begin` starts it, or returns the one already
 * waiting so a second click opens the same consent page instead of failing
 * on the busy port.
 */
export class LoginSession {
  private current: { authorizationUrl: string; startedAt: Date } | null = null;
  private lastError: string | null = null;
  private lastConnectedAt: Date | null = null;

  constructor(
    private readonly start: () => Promise<Result<LoginAttempt>>,
    /** "Facebook", "Pinterest": names the network in an unexpected failure. */
    private readonly providerName: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  async begin(): Promise<Result<{ authorizationUrl: string }>> {
    if (this.current !== null) {
      return ok({ authorizationUrl: this.current.authorizationUrl });
    }
    this.lastError = null;
    const attempt = await this.start();
    if (!attempt.ok) {
      this.lastError = attempt.error;
      return attempt;
    }
    const authorizationUrl: string = attempt.value.authorizationUrl;
    this.current = { authorizationUrl, startedAt: this.now() };
    void attempt.value.completion
      .then((result) => {
        if (result.ok) this.lastConnectedAt = this.now();
        else this.lastError = result.error;
      })
      .catch((cause: unknown) => {
        this.lastError = `The ${this.providerName} login failed unexpectedly: ${describeUnknownError(cause)}`;
      })
      .finally(() => {
        this.current = null;
      });
    return ok({ authorizationUrl });
  }

  progress(): LoginProgress {
    return {
      inProgress: this.current !== null,
      authorizationUrl: this.current?.authorizationUrl ?? null,
      startedAt: this.current?.startedAt.toISOString() ?? null,
      lastError: this.lastError,
      lastConnectedAt: this.lastConnectedAt?.toISOString() ?? null,
    };
  }
}

/**
 * A redirect back to this machine: http on localhost or 127.0.0.1, with an
 * explicit port (for the listener) and a path.
 */
export function checkLoopbackRedirectUri(
  value: string
): Result<{ port: number; path: string }> {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return err(
      `"${value}" is not a URL; use e.g. http://localhost:3004/oauth/callback`
    );
  }
  if (parsed.protocol !== 'http:') {
    return err(
      `"${value}" must use http (the redirect is caught on this machine)`
    );
  }
  if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    return err(
      `"${value}" must point at localhost or 127.0.0.1, not ${parsed.hostname}`
    );
  }
  if (parsed.port === '') {
    return err(
      `"${value}" needs an explicit port, e.g. http://localhost:3004/oauth/callback`
    );
  }
  if (parsed.pathname === '/' || parsed.pathname === '') {
    return err(`"${value}" needs a path, e.g. /oauth/callback`);
  }
  return ok({ port: Number(parsed.port), path: parsed.pathname });
}

/** An https redirect with a path; also says whether it points at this machine. */
export function checkHttpsRedirectUri(
  value: string
): Result<{ loopback: boolean; port: number; path: string }> {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return err(
      `"${value}" is not a URL; use e.g. https://localhost:3005/oauth/callback`
    );
  }
  if (parsed.protocol !== 'https:') {
    return err(
      `"${value}" must use https: this network only redirects to https addresses, even on this machine`
    );
  }
  if (parsed.pathname === '/' || parsed.pathname === '') {
    return err(`"${value}" needs a path, e.g. /oauth/callback`);
  }
  const loopback: boolean =
    parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  return ok({
    loopback,
    port: parsed.port === '' ? 443 : Number(parsed.port),
    path: parsed.pathname,
  });
}

/** "a, b c" → ["a", "b", "c"], without duplicates. */
export function parseScopeList(value: string): readonly string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0)
    ),
  ];
}

/**
 * The code and state from a redirect address the owner pasted (for a
 * network that only redirects to https when no local https listener runs),
 * or what's wrong with it.
 */
export function parseRedirectAddress(
  text: string,
  redirectUri: string,
  providerName: string
): Result<CallbackResult> {
  let pasted: URL;
  try {
    pasted = new URL(text.trim());
  } catch {
    return err(
      `That isn't a web address. Paste the whole address from the browser's address bar after allowing access on ${providerName} (it starts with the redirect address and has "code=" in it).`
    );
  }
  const expected = new URL(redirectUri);
  if (
    pasted.origin !== expected.origin ||
    pasted.pathname !== expected.pathname
  ) {
    return err(
      `That address doesn't start with the redirect address ${expected.origin}${expected.pathname}; paste the address ${providerName} sent the browser to.`
    );
  }
  const oauthError: string | null = pasted.searchParams.get('error');
  if (oauthError !== null) {
    const detail: string | null =
      pasted.searchParams.get('error_description') ??
      pasted.searchParams.get('error_reason');
    return err(
      `${providerName} returned an OAuth error: ${oauthError}${detail === null ? '' : ` (${detail})`}.`
    );
  }
  // Some networks append "#_"; the URL parser keeps it out of the code.
  const code: string | null = pasted.searchParams.get('code');
  const state: string | null = pasted.searchParams.get('state');
  if (code === null || code === '' || state === null || state === '') {
    return err(
      `That address has no code or state in it; allow access on ${providerName}, then paste the address it sends you to.`
    );
  }
  return ok({ code, state });
}

/** Only https consent pages on the given hosts are handed to a browser. */
export function checkAuthorizationUrl(
  url: string,
  hosts: readonly string[],
  providerName: string
): Result<string> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' && hosts.includes(parsed.hostname)) {
      return ok(url);
    }
  } catch {
    // Reported below.
  }
  return err(
    `The ${providerName} authorization URL "${url}" isn't an https ${hosts[0] ?? ''} address; not opening it.`
  );
}
