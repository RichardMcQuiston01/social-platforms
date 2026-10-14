import { AwsClient } from 'aws4fetch';

import { describeUnknownError, err, ok, type Result } from './result.js';
import type { StoredTempImage, TempImageStore } from './temp-image.js';

export type { StoredTempImage, TempImageStore } from './temp-image.js';

/**
 * Instagram and Threads fetch the image from a public URL; they can't take
 * uploaded bytes. So the JPG goes briefly to the owner's private
 * S3-compatible bucket (DigitalOcean Spaces, AWS S3, ...), the network gets
 * a presigned GET link that expires in minutes, and the object is deleted
 * as soon as the network has it. The bucket itself stays private.
 */

/** The bucket calls are signed Requests, so this fetch takes a Request. */
export type RequestFetch = (input: Request) => Promise<Response>;

export interface TempStoreConfig {
  /** https origin, e.g. https://nyc3.digitaloceanspaces.com */
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Key prefix, ending in '/'. Only objects under it are ever written, read or deleted. */
  readonly prefix: string;
}

export interface TempStoreInput {
  /** https origin, e.g. https://nyc3.digitaloceanspaces.com */
  readonly endpoint: string;
  readonly bucket: string;
  /** Optional: DigitalOcean's is read from the endpoint; others default to us-east-1. */
  readonly region?: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** A folder like social-temp/; only objects under it are touched. */
  readonly prefix: string;
}

/** How long the network's link works. */
export const PRESIGNED_URL_SECONDS = 600;
/** Leftovers older than this are deleted by the sweep (a delete that failed). */
export const SWEEP_AFTER_MS: number = 60 * 60 * 1000;

/**
 * The bucket settings, or what's missing or wrong: the endpoint must be a
 * plain https origin, the bucket a bucket name, the prefix a folder.
 */
export function readTempStoreConfig(
  input: TempStoreInput
): Result<TempStoreConfig> {
  const missing: string[] = (
    [
      ['endpoint', input.endpoint],
      ['bucket', input.bucket],
      ['accessKeyId', input.accessKeyId],
      ['secretAccessKey', input.secretAccessKey],
    ] as const
  )
    .filter(([, value]) => value.trim() === '')
    .map(([name]) => name);
  if (missing.length > 0) {
    return err(
      `The temporary image bucket is missing its ${missing.join(', ')}.`
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(input.endpoint.trim());
  } catch {
    return err(
      `The bucket endpoint "${input.endpoint}" isn't a URL; use e.g. https://nyc3.digitaloceanspaces.com`
    );
  }
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.pathname !== '/' ||
    endpoint.search !== ''
  ) {
    return err(
      `The bucket endpoint must be an https origin with no path, e.g. https://nyc3.digitaloceanspaces.com (got "${input.endpoint}")`
    );
  }
  const bucket: string = input.bucket.trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    return err(
      `"${bucket}" isn't a bucket name (lower-case letters, digits, dots and dashes)`
    );
  }
  const prefix: string = input.prefix.trim().replace(/^\/+/, '');
  if (
    prefix === '' ||
    prefix.includes('..') ||
    !/^[A-Za-z0-9._\-/]+$/.test(prefix)
  ) {
    return err(
      `The bucket prefix "${input.prefix}" must be a folder like social-temp/`
    );
  }
  // DigitalOcean's region is the endpoint's first label (nyc3.…); others say it.
  const region: string =
    input.region?.trim() ||
    (endpoint.hostname.endsWith('.digitaloceanspaces.com')
      ? (endpoint.hostname.split('.')[0] ?? 'us-east-1')
      : 'us-east-1');
  return ok({
    endpoint: endpoint.origin,
    bucket,
    region,
    accessKeyId: input.accessKeyId.trim(),
    secretAccessKey: input.secretAccessKey.trim(),
    prefix: prefix.endsWith('/') ? prefix : `${prefix}/`,
  });
}

/** `<Contents><Key>…</Key><LastModified>…</LastModified>` pairs from a ListObjectsV2 reply. */
export function parseListObjects(
  xml: string
): { key: string; lastModified: Date }[] {
  const objects: { key: string; lastModified: Date }[] = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block: string = match[1] ?? '';
    const key: string | undefined = /<Key>([^<]*)<\/Key>/.exec(block)?.[1];
    const modified: string | undefined =
      /<LastModified>([^<]*)<\/LastModified>/.exec(block)?.[1];
    if (key === undefined || modified === undefined) continue;
    const lastModified = new Date(modified);
    if (Number.isNaN(lastModified.getTime())) continue;
    objects.push({ key: decodeXmlEntities(key), lastModified });
  }
  return objects;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** The bucket's error, e.g. `<Code>AccessDenied</Code>`, as one line. */
function describeBucketError(
  what: string,
  status: number,
  body: string
): string {
  const code: string | undefined = /<Code>([^<]*)<\/Code>/.exec(body)?.[1];
  const message: string | undefined = /<Message>([^<]*)<\/Message>/.exec(
    body
  )?.[1];
  const detail: string =
    code !== undefined
      ? `${code}${message !== undefined ? `: ${message}` : ''}`
      : body.slice(0, 200);
  const hint: string =
    status === 403
      ? " Check the bucket's access key and secret key, and that the key may use this bucket."
      : status === 404
        ? " Check the bucket's name and endpoint."
        : '';
  return `The temporary image bucket refused ${what} (HTTP ${status}${detail === '' ? '' : `, ${detail}`}).${hint}`;
}

/** The S3-compatible store, signed with SigV4 (aws4fetch); path-style URLs. */
export class S3TempImageStore implements TempImageStore {
  private readonly client: AwsClient;

  constructor(
    private readonly config: TempStoreConfig,
    private readonly fetchImpl: RequestFetch = (request) => fetch(request),
    private readonly now: () => Date = () => new Date()
  ) {
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: 's3',
      region: config.region,
    });
  }

  private objectUrl(key: string): URL {
    const path: string = key.split('/').map(encodeURIComponent).join('/');
    return new URL(`${this.config.endpoint}/${this.config.bucket}/${path}`);
  }

  private async send(
    request: Request,
    what: string
  ): Promise<Result<{ status: number; body: string }>> {
    let response: Response;
    try {
      response = await this.fetchImpl(request);
    } catch (cause: unknown) {
      return err(
        `Could not reach the temporary image bucket at ${this.config.endpoint} for ${what}: ${describeUnknownError(cause)}`,
        cause
      );
    }
    const body: string = await response.text().catch(() => '');
    if (!response.ok)
      return err(describeBucketError(what, response.status, body));
    return ok({ status: response.status, body });
  }

  async put(
    bytes: Uint8Array,
    contentType: 'image/jpeg'
  ): Promise<Result<StoredTempImage>> {
    const key = `${this.config.prefix}${crypto.randomUUID()}.jpg`;
    const url: URL = this.objectUrl(key);
    const signed: Request = await this.client.sign(url.toString(), {
      method: 'PUT',
      body: new Uint8Array(bytes),
      headers: { 'content-type': contentType, 'x-amz-acl': 'private' },
    });
    const uploaded = await this.send(signed, `the upload of ${key}`);
    if (!uploaded.ok) return uploaded;

    const getUrl: URL = this.objectUrl(key);
    getUrl.searchParams.set('X-Amz-Expires', String(PRESIGNED_URL_SECONDS));
    const presigned: Request = await this.client.sign(getUrl.toString(), {
      method: 'GET',
      aws: { signQuery: true },
    });
    return ok({ key, url: presigned.url });
  }

  async delete(key: string): Promise<Result<void>> {
    if (!key.startsWith(this.config.prefix)) {
      return err(
        `Refusing to delete ${key}: it isn't under ${this.config.prefix}`
      );
    }
    const signed: Request = await this.client.sign(
      this.objectUrl(key).toString(),
      {
        method: 'DELETE',
      }
    );
    const deleted = await this.send(signed, `the delete of ${key}`);
    return deleted.ok ? ok(undefined) : deleted;
  }

  async sweep(olderThanMs: number): Promise<Result<number>> {
    const list = new URL(`${this.config.endpoint}/${this.config.bucket}`);
    list.searchParams.set('list-type', '2');
    list.searchParams.set('prefix', this.config.prefix);
    list.searchParams.set('max-keys', '1000');
    const listed = await this.send(
      await this.client.sign(list.toString(), { method: 'GET' }),
      `the list of ${this.config.prefix}`
    );
    if (!listed.ok) return listed;
    const cutoff: number = this.now().getTime() - olderThanMs;
    let removed = 0;
    for (const object of parseListObjects(listed.value.body)) {
      if (!object.key.startsWith(this.config.prefix)) continue;
      if (object.lastModified.getTime() > cutoff) continue;
      const deleted = await this.delete(object.key);
      if (!deleted.ok)
        return err(`${deleted.error} (after deleting ${removed} old images)`);
      removed += 1;
    }
    return ok(removed);
  }
}
