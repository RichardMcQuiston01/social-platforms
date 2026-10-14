/**
 * Small runtime-neutral helpers (Node, Bun and browsers): base64 without
 * Buffer, random OAuth states and HMAC through Web Crypto.
 */

const BASE64_CHUNK = 0x8000;

/** Bytes → base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += BASE64_CHUNK) {
    binary += String.fromCharCode(
      ...bytes.subarray(start, start + BASE64_CHUNK)
    );
  }
  return btoa(binary);
}

/** Text (UTF-8) → base64, e.g. for an HTTP Basic header. */
export function textToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

/** A random OAuth `state`: 16 bytes, base64url. */
export function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** HMAC-SHA256 of `message` with `key`, as lower-case hex. */
export async function hmacSha256Hex(
  key: string,
  message: string
): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    encoder.encode(message)
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
