import { silentLogger, type SocialLogger } from '../logger.js';
import type {
  PublishedPost,
  PublishImageRequest,
  SocialPublisherPort,
} from '../port.js';
import { err, ok, type Result } from '../result.js';
import type { TempImageStore } from '../temp-image.js';
import type { ThreadsClient } from './graph.js';
import { refreshThreadsLoginIfDue } from './login.js';
import type { ThreadsLoginStore } from './token.js';

/** Threads' text limit. */
export const THREADS_MAX_TEXT_LENGTH = 500;
/** Threads refuses images narrower than this. */
export const THREADS_MIN_IMAGE_WIDTH = 320;
/** Threads refuses images more lopsided than 10:1 either way. */
export const THREADS_MAX_ASPECT = 10;

/** Why Threads would refuse an image this size, or null. */
export function findThreadsImageProblem(
  width: number,
  height: number
): string | null {
  if (width <= 0 || height <= 0) return 'The image has no size.';
  if (width < THREADS_MIN_IMAGE_WIDTH) {
    return `The image is ${width} px wide; Threads needs at least ${THREADS_MIN_IMAGE_WIDTH}.`;
  }
  const ratio: number = width / height;
  if (ratio > THREADS_MAX_ASPECT || ratio < 1 / THREADS_MAX_ASPECT) {
    return `The image is ${width}×${height}; Threads takes nothing more lopsided than 10:1.`;
  }
  return null;
}

export interface ThreadsPublisherOptions {
  readonly pollIntervalMs?: number;
  readonly pollTimeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
  readonly logger?: SocialLogger;
}

/**
 * Posts to the owner's Threads account: the JPG goes to the temporary
 * bucket (Threads, like Instagram, fetches images from a link), a media
 * container is made with a short-lived link to it, published once Threads
 * has the image, and the temporary copy is deleted either way.
 */
export class ThreadsPublisher implements SocialPublisherPort {
  readonly platform = 'threads' as const;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly logger: SocialLogger;

  constructor(
    private readonly client: ThreadsClient,
    private readonly store: ThreadsLoginStore,
    private readonly tempImages: TempImageStore,
    options: ThreadsPublisherOptions = {}
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.pollTimeoutMs = options.pollTimeoutMs ?? 60_000;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? silentLogger;
  }

  async publishImage(
    request: PublishImageRequest
  ): Promise<Result<PublishedPost>> {
    if (request.mimeType !== 'image/jpeg') {
      return err('Threads takes JPG images here; send the image as a JPG.');
    }
    const login = await refreshThreadsLoginIfDue(
      this.client,
      this.store,
      this.now(),
      this.logger
    );
    if (!login.ok) return login;
    if (login.value === null)
      return err("Threads isn't connected: connect Threads first.");
    const { userId, accessToken } = login.value;
    const accountName: string =
      login.value.username === null
        ? `Threads ${userId}`
        : `@${login.value.username}`;
    if (userId !== request.expectedAccountId) {
      return err(
        `Not posted: Threads account ${request.expectedAccountId} was confirmed, but the saved login is ${accountName} (${userId}). Check the account before posting again.`
      );
    }

    const stored = await this.tempImages.put(request.bytes, 'image/jpeg');
    if (!stored.ok) return err(`Not posted to Threads: ${stored.error}`);
    try {
      const container = await this.client.createImageContainer(
        userId,
        accessToken,
        stored.value.url,
        request.caption
      );
      if (!container.ok) return container;
      const ready = await this.waitUntilFinished(container.value, accessToken);
      if (!ready.ok) return ready;
      const postId = await this.client.publishContainer(
        userId,
        accessToken,
        container.value
      );
      if (!postId.ok) return postId;

      // The post is up; a missing link only costs the "View post" button.
      const link = await this.client.permalink(postId.value, accessToken);
      if (!link.ok)
        this.logger.warn(
          `Posted to ${accountName} but couldn't read its link: ${link.error}`
        );
      return ok({
        externalPostId: postId.value,
        permalink: link.ok ? link.value : null,
        accountName,
      });
    } finally {
      const deleted = await this.tempImages.delete(stored.value.key);
      if (!deleted.ok) {
        this.logger.warn(
          `Couldn't delete the temporary Threads image ${stored.value.key}; a later sweep removes it: ${deleted.error}`
        );
      }
    }
  }

  private async waitUntilFinished(
    containerId: string,
    accessToken: string
  ): Promise<Result<void>> {
    const attempts: number = Math.max(
      1,
      Math.ceil(this.pollTimeoutMs / this.pollIntervalMs)
    );
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const status = await this.client.containerStatus(
        containerId,
        accessToken
      );
      if (!status.ok) return status;
      const { status: state, errorMessage } = status.value;
      if (state === 'FINISHED') return ok(undefined);
      if (state === 'ERROR' || state === 'EXPIRED') {
        return err(
          `Threads couldn't use the image (container ${containerId} is ${state}${errorMessage === '' ? '' : `: ${errorMessage}`}). Check it's a JPG under 8 MB, at least ${THREADS_MIN_IMAGE_WIDTH} px wide.`
        );
      }
      if (state === 'PUBLISHED') {
        return err(
          `Threads container ${containerId} was already published; not posting it twice.`
        );
      }
      await this.sleep(this.pollIntervalMs);
    }
    return err(
      `Threads hadn't finished fetching the image after ${Math.round(this.pollTimeoutMs / 1000)} s (container ${containerId}); nothing was posted. Try again.`
    );
  }
}
