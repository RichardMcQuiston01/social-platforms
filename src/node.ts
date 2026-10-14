import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';

import { readFile } from 'node:fs/promises';

import type {
  CallbackListener,
  CallbackListenerOptions,
  CallbackResult,
} from './oauth.js';
import { describeUnknownError, err, ok, type Result } from './result.js';

export type { CallbackListener, CallbackListenerOptions } from './oauth.js';

/** How long a login waits for the provider's redirect before giving up. */
export const LOGIN_TIMEOUT_MS: number = 5 * 60 * 1000;

/** Text for an HTML page; the detail can carry the provider's (or anyone's) query parameters. */
export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (character) => `&#${character.charCodeAt(0)};`
  );
}

/** The page the redirect lands on; the tab can be closed afterwards. */
export function callbackPage(title: string, detail: string): string {
  return (
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<body style="font-family:system-ui;padding:3rem;max-width:40rem">` +
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>`
  );
}

/**
 * Listens for the redirect (one request, then it closes). Resolves once the
 * port is open, so a busy port is reported before anyone is sent to the
 * provider; `callback` settles with the code, an error, or a timeout after
 * LOGIN_TIMEOUT_MS.
 */
export function listenForCallback(
  options: CallbackListenerOptions
): Promise<Result<CallbackListener>> {
  const { port, pathPrefix, providerName, expectedState, tls } = options;
  return new Promise((resolveListening) => {
    let resolveCallback: (result: Result<CallbackResult>) => void = () =>
      undefined;
    const callback = new Promise<Result<CallbackResult>>((resolve) => {
      resolveCallback = resolve;
    });
    let listening = false;
    let settled = false;

    const handle = (
      request: IncomingMessage,
      response: ServerResponse
    ): void => {
      const requestUrl = new URL(
        request.url ?? '/',
        `http://localhost:${port}`
      );
      if (!requestUrl.pathname.startsWith(pathPrefix)) {
        response.writeHead(404).end('Not found');
        return;
      }

      const code: string | null = requestUrl.searchParams.get('code');
      const state: string | null = requestUrl.searchParams.get('state');
      const oauthError: string | null = requestUrl.searchParams.get('error');
      const errorDescription: string | null =
        requestUrl.searchParams.get('error_description') ??
        requestUrl.searchParams.get('error_reason');

      const finish = (result: Result<CallbackResult>, title: string): void => {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(
          callbackPage(
            title,
            result.ok
              ? 'You can close this tab and go back to the app.'
              : `${result.error} Close this tab and try connecting again.`
          )
        );
        if (!settled) {
          settled = true;
          server.close();
          resolveCallback(result);
        }
      };

      if (oauthError !== null) {
        const detail: string =
          errorDescription === null ? '' : ` (${errorDescription})`;
        finish(
          err(
            `${providerName} returned an OAuth error: ${oauthError}${detail}.`
          ),
          'Authorization failed'
        );
        return;
      }
      if (code === null || state === null) {
        finish(
          err(
            `${providerName} redirected back without a code or state parameter.`
          ),
          'Authorization failed'
        );
        return;
      }
      if (state !== expectedState) {
        finish(
          err(
            'OAuth state mismatch: the redirect did not match this login attempt.'
          ),
          'Authorization failed'
        );
        return;
      }
      finish(ok({ code, state }), `Connected to ${providerName}`);
    };
    const server: Server =
      tls === undefined
        ? createServer(handle)
        : createHttpsServer({ cert: tls.cert, key: tls.key }, handle);

    server.on('error', (cause: unknown) => {
      const message: string =
        `Could not listen on 127.0.0.1:${port} for the ${providerName} OAuth callback ` +
        `(is another login, or another program, using that port?): ${describeUnknownError(cause)}`;
      if (!listening) {
        resolveListening(err(message, cause));
      } else if (!settled) {
        settled = true;
        resolveCallback(err(message, cause));
      }
    });

    server.listen(port, '127.0.0.1', () => {
      listening = true;
      resolveListening(
        ok({
          callback,
          close: () => {
            if (settled) return;
            settled = true;
            server.close();
          },
        })
      );
    });

    // Don't hang forever if the browser step is abandoned.
    setTimeout(() => {
      if (!settled) {
        settled = true;
        server.close();
        resolveCallback(
          err(
            `Timed out after ${LOGIN_TIMEOUT_MS / 60_000} minutes waiting for ${providerName}'s redirect.`
          )
        );
      }
    }, LOGIN_TIMEOUT_MS).unref();
  });
}

/**
 * A PEM certificate and key from disk, for the https listener (Threads only
 * redirects to https). Read when a login starts, so a renewed certificate
 * needs no restart.
 */
export async function readTlsFiles(
  certFile: string,
  keyFile: string,
  read: (path: string) => Promise<string> = (path) => readFile(path, 'utf8')
): Promise<Result<{ cert: string; key: string }>> {
  const files: [string, string][] = [
    ['the certificate file', certFile],
    ['the key file', keyFile],
  ];
  const contents: string[] = [];
  for (const [setting, file] of files) {
    try {
      contents.push(await read(file));
    } catch (cause: unknown) {
      return err(
        `Could not read ${setting} (${file}): ${describeUnknownError(cause)}`,
        cause
      );
    }
  }
  const [cert = '', key = ''] = contents;
  if (!cert.includes('-----BEGIN CERTIFICATE-----')) {
    return err(`The certificate file (${certFile}) isn't a PEM certificate.`);
  }
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key)) {
    return err(`The key file (${keyFile}) isn't a PEM private key.`);
  }
  return ok({ cert, key });
}
