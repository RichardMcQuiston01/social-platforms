import { checkLoopbackRedirectUri, parseScopeList } from '../oauth.js';
import { err, ok, type Result } from '../result.js';

/** What Facebook Page posting needs. */
export const FACEBOOK_REQUIRED_SCOPES: readonly string[] = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
];

/**
 * What Instagram posting needs, on top of the Page permissions: the
 * Instagram account is reached through the Page it's linked to.
 */
export const INSTAGRAM_REQUIRED_SCOPES: readonly string[] = [
  'instagram_basic',
  'instagram_content_publish',
];

/**
 * Asked for at login when no scopes are given. Each must be added to the
 * Meta app's use cases first; asking for one it hasn't been given makes
 * Facebook refuse the whole login ("Invalid Scopes").
 */
export const DEFAULT_META_SCOPES: readonly string[] = [
  ...FACEBOOK_REQUIRED_SCOPES,
  ...INSTAGRAM_REQUIRED_SCOPES,
];

/** Permissions this package refuses to ask for: it never messages or replies. */
export const FORBIDDEN_META_SCOPES: readonly string[] = [
  'pages_messaging',
  'instagram_manage_messages',
  'instagram_manage_comments',
  'pages_manage_engagement',
];

export const DEFAULT_META_GRAPH_VERSION = 'v23.0';

export interface MetaConfig {
  readonly appId: string;
  readonly appSecret: string;
  /** Exactly as registered in the Meta app (http, localhost, a port and a path). */
  readonly redirectUri: string;
  /** The port and path the callback listener serves, from `redirectUri`. */
  readonly callbackPort: number;
  readonly callbackPath: string;
  /** A Facebook Login for Business configuration id; null to ask for `scopes`. */
  readonly loginConfigId: string | null;
  readonly scopes: readonly string[];
  /** When set, posting goes to this Page only. */
  readonly preferredPageId: string | null;
  readonly graphVersion: string;
}

export interface MetaConfigInput {
  readonly appId: string;
  readonly appSecret: string;
  readonly redirectUri: string;
  readonly loginConfigId?: string;
  /** Space- or comma-separated, or a list; empty means DEFAULT_META_SCOPES. */
  readonly scopes?: string | readonly string[];
  /** Pins posting to one Page. */
  readonly pageId?: string;
  readonly graphVersion?: string;
}

/** The settings the login, Graph client and publishers use, or what's wrong. */
export function readMetaConfig(input: MetaConfigInput): Result<MetaConfig> {
  const appId: string = input.appId.trim();
  const appSecret: string = input.appSecret.trim();
  if (appId === '' || appSecret === '') {
    return err('The Meta app id or secret is missing.');
  }
  const redirectUri: string = input.redirectUri.trim();
  const redirect = checkLoopbackRedirectUri(redirectUri);
  if (!redirect.ok) return err(`Redirect URI: ${redirect.error}`);
  const requested: readonly string[] =
    typeof input.scopes === 'string'
      ? parseScopeList(input.scopes)
      : [...new Set(input.scopes ?? [])];
  const scopes: readonly string[] =
    requested.length === 0 ? DEFAULT_META_SCOPES : requested;
  const forbidden: string[] = scopes.filter((scope) =>
    FORBIDDEN_META_SCOPES.includes(scope)
  );
  if (forbidden.length > 0) {
    return err(
      `The scopes include ${forbidden.join(', ')}; this package never messages or replies to anyone, so remove ${forbidden.length === 1 ? 'it' : 'them'}.`
    );
  }
  const graphVersion: string =
    input.graphVersion?.trim() || DEFAULT_META_GRAPH_VERSION;
  if (!/^v\d+\.\d+$/.test(graphVersion)) {
    return err(`Graph API version "${graphVersion}" must look like v23.0.`);
  }
  const loginConfigId: string = input.loginConfigId?.trim() ?? '';
  const pageId: string = input.pageId?.trim() ?? '';
  return ok({
    appId,
    appSecret,
    redirectUri,
    callbackPort: redirect.value.port,
    callbackPath: redirect.value.path,
    loginConfigId: loginConfigId === '' ? null : loginConfigId,
    scopes,
    preferredPageId: pageId === '' ? null : pageId,
    graphVersion,
  });
}
