import type { Result } from './result.js';

/**
 * Instagram and Threads fetch a post's image from a public link; they can't
 * take uploaded bytes. A TempImageStore puts the image somewhere briefly
 * (S3TempImageStore in the ./s3 subpath is one), hands out a short-lived
 * link, and deletes it once the network has it.
 */

export interface StoredTempImage {
  readonly key: string;
  /** A link the network can fetch for a few minutes. */
  readonly url: string;
}

export interface TempImageStore {
  put(
    bytes: Uint8Array,
    contentType: 'image/jpeg'
  ): Promise<Result<StoredTempImage>>;
  delete(key: string): Promise<Result<void>>;
  /** Deletes leftovers older than `olderThanMs`; returns how many. */
  sweep(olderThanMs: number): Promise<Result<number>>;
}
