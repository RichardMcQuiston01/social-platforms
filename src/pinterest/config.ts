import { checkLoopbackRedirectUri } from '../oauth.js';
import { err, ok, type Result } from '../result.js';

/**
 * Pinterest settings (pure). Pinterest has its own app id, secret and login
 * (www.pinterest.com/oauth), separate from Meta's. A Trial app may only
 * create Pins in Pinterest's API sandbox (Pins visible only to their
 * creator), so the environment is a setting: `sandbox` until the app has
 * Standard access, then `production`. Tokens from one don't work in the
 * other, so changing it means connecting again.
 */

/**
 * What posting a Pin needs: the account's name, its boards (and making one,
 * since sandbox boards are separate from real ones), and Pins, each for
 * public and secret boards (a secret board is a handy place to test). No
 * ads, billing, catalogs or business access, and nothing that changes the
 * account or its followers.
 */
export const PINTEREST_SCOPES: readonly string[] = [
  'user_accounts:read',
  'boards:read',
  'boards:read_secret',
  'boards:write',
  'boards:write_secret',
  'pins:read',
  'pins:read_secret',
  'pins:write',
  'pins:write_secret',
];

export type PinterestEnvironment = 'sandbox' | 'production';

export function isPinterestEnvironment(
  value: unknown
): value is PinterestEnvironment {
  return value === 'sandbox' || value === 'production';
}

/** The REST API for each environment; the consent page is the same for both. */
export const PINTEREST_API_BASES: Readonly<
  Record<PinterestEnvironment, string>
> = {
  sandbox: 'https://api-sandbox.pinterest.com/v5',
  production: 'https://api.pinterest.com/v5',
};

export const PINTEREST_AUTHORIZE_URL = 'https://www.pinterest.com/oauth/';

export interface PinterestConfig {
  readonly appId: string;
  readonly appSecret: string;
  /** Exactly as registered in the Pinterest app (http, localhost, a port and a path). */
  readonly redirectUri: string;
  readonly callbackPort: number;
  readonly callbackPath: string;
  readonly environment: PinterestEnvironment;
}

export interface PinterestAccountFields {
  readonly appId: string;
  readonly appSecret: string;
  readonly redirectUri: string;
  readonly environment: PinterestEnvironment;
}

/** The settings the login, client and publisher use, or what's wrong with them. */
export function readPinterestConfig(
  fields: PinterestAccountFields
): Result<PinterestConfig> {
  const appId: string = fields.appId.trim();
  const appSecret: string = fields.appSecret.trim();
  if (appId === '' || appSecret === '') {
    return err('The Pinterest app id or secret is missing.');
  }
  const redirectUri: string = fields.redirectUri.trim();
  const redirect = checkLoopbackRedirectUri(redirectUri);
  if (!redirect.ok) return err(`Redirect URL: ${redirect.error}`);
  return ok({
    appId,
    appSecret,
    redirectUri,
    callbackPort: redirect.value.port,
    callbackPath: redirect.value.path,
    environment: fields.environment,
  });
}
