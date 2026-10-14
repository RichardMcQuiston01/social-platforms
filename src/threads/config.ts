import { checkHttpsRedirectUri } from '../oauth.js';
import { err, ok, type Result } from '../result.js';

/**
 * Threads settings. Threads has its own app id, secret and login
 * (threads.net), separate from the Facebook login, and only redirects to
 * https: a local https listener (with a certificate, e.g. from `mkcert
 * localhost`) catches the redirect, or the owner pastes the address the
 * browser ended on.
 */

/** What posting to Threads needs. Nothing that reads or sends replies or messages. */
export const THREADS_SCOPES: readonly string[] = [
  'threads_basic',
  'threads_content_publish',
];

export const DEFAULT_THREADS_API_VERSION = 'v1.0';

export interface ThreadsConfig {
  readonly appId: string;
  readonly appSecret: string;
  /** Exactly as registered in the Meta app's Threads settings (https). */
  readonly redirectUri: string;
  /**
   * Set when the redirect points at this machine and a certificate is
   * configured: a local https listener catches it. Otherwise the owner
   * pastes the address the browser ended on.
   */
  readonly listener: {
    readonly port: number;
    readonly path: string;
    readonly certFile: string;
    readonly keyFile: string;
  } | null;
  readonly apiVersion: string;
}

export interface ThreadsConfigInput {
  readonly appId: string;
  readonly appSecret: string;
  readonly redirectUri: string;
  /** PEM certificate and key files for the local https listener; both or neither. */
  readonly tlsCertFile?: string;
  readonly tlsKeyFile?: string;
  readonly apiVersion?: string;
}

/** The settings the login, client and publisher use, or what's wrong. */
export function readThreadsConfig(
  input: ThreadsConfigInput
): Result<ThreadsConfig> {
  const appId: string = input.appId.trim();
  const appSecret: string = input.appSecret.trim();
  if (appId === '' || appSecret === '') {
    return err('The Threads app id or secret is missing.');
  }
  const redirectUri: string = input.redirectUri.trim();
  const redirect = checkHttpsRedirectUri(redirectUri);
  if (!redirect.ok) return err(`Redirect URI: ${redirect.error}`);
  const certFile: string = input.tlsCertFile?.trim() ?? '';
  const keyFile: string = input.tlsKeyFile?.trim() ?? '';
  if ((certFile === '') !== (keyFile === '')) {
    return err(
      'Give both the certificate and key files (e.g. from `mkcert localhost`), or neither to paste the redirect address instead.'
    );
  }
  if (certFile !== '' && !redirect.value.loopback) {
    return err(
      `A certificate is set, but the redirect points at ${new URL(redirectUri).hostname}, not localhost; the local listener can only catch a redirect to localhost or 127.0.0.1.`
    );
  }
  const apiVersion: string =
    input.apiVersion?.trim() || DEFAULT_THREADS_API_VERSION;
  if (!/^v\d+\.\d+$/.test(apiVersion)) {
    return err(`Threads API version "${apiVersion}" must look like v1.0.`);
  }
  return ok({
    appId,
    appSecret,
    redirectUri,
    listener:
      certFile === ''
        ? null
        : {
            port: redirect.value.port,
            path: redirect.value.path,
            certFile,
            keyFile,
          },
    apiVersion,
  });
}
