/**
 * Where the package reports what it did (a login saved, a token refreshed,
 * a post whose link couldn't be read). Silent unless the app passes one.
 * Messages never contain a token or secret.
 */
export interface SocialLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const silentLogger: SocialLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
