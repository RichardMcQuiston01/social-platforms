import type { Result } from './result.js';

/**
 * One publisher per network, so an app can post the same image to any of
 * them through one interface. Every publisher posts only to the account
 * (Page, board) its owner confirmed, one image per call.
 */

export type SocialPlatform = 'facebook' | 'instagram' | 'threads' | 'pinterest';

export const SOCIAL_PLATFORMS: readonly SocialPlatform[] = [
  'facebook',
  'instagram',
  'threads',
  'pinterest',
];

export type SocialImageMimeType = 'image/jpeg' | 'image/png';

export interface PublishImageRequest {
  readonly bytes: Uint8Array;
  readonly mimeType: SocialImageMimeType;
  readonly fileName: string;
  /** The post's text; a Pin's description. */
  readonly caption: string;
  /**
   * The Page, account or (Pinterest) board the owner confirmed. A publisher
   * refuses to post anywhere else, so a stale choice can't post to the
   * wrong place.
   */
  readonly expectedAccountId: string;
  /** Pinterest only: the Pin's title, link and alt text. */
  readonly pin?: PinDetails;
}

export interface PinDetails {
  readonly title: string;
  /** Where the Pin leads, checked by the publisher's `checkLink`. */
  readonly link: string;
  readonly altText: string;
}

export interface PublishedPost {
  /** The network's id for the post. */
  readonly externalPostId: string;
  /** Link to the post; null when the network didn't give one. */
  readonly permalink: string | null;
  /** The Page, account or board it went to, for a history or confirmation. */
  readonly accountName: string;
}

export interface SocialPublisherPort {
  readonly platform: SocialPlatform;
  publishImage(request: PublishImageRequest): Promise<Result<PublishedPost>>;
}
