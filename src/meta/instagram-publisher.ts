import { silentLogger, type SocialLogger } from '../logger.js';
import type {
  PublishedPost,
  PublishImageRequest,
  SocialPublisherPort,
} from '../port.js';
import { err, ok, type Result } from '../result.js';
import type { TempImageStore } from '../temp-image.js';
import { INSTAGRAM_REQUIRED_SCOPES } from './config.js';
import { selectedPostingPage } from './facebook-publisher.js';
import type { MetaGraphClient, MetaPage } from './graph.js';
import type { MetaLoginStore } from './token.js';

/** The Instagram account posts go to, and the Page (and token) it's reached through. */
export interface InstagramTarget {
  readonly accountId: string;
  /** null when Facebook didn't give the username. */
  readonly username: string | null;
  readonly page: MetaPage;
}

/**
 * The Instagram account linked to the chosen Facebook Page, or why there
 * isn't one. Instagram is reached through the Page (Facebook Login), so
 * every Page rule applies first, including a pinned Page.
 */
export function selectedInstagramAccount(
  login: Parameters<typeof selectedPostingPage>[0],
  pinnedPageId: string | null = null
): Result<InstagramTarget> {
  const page = selectedPostingPage(login, pinnedPageId);
  if (!page.ok) return page;
  const granted: readonly string[] = login?.grantedScopes ?? [];
  const missing: string[] = INSTAGRAM_REQUIRED_SCOPES.filter(
    (scope) => !granted.includes(scope)
  );
  if (granted.length > 0 && missing.length > 0) {
    return err(
      `The Facebook login doesn't grant ${missing.join(', ')}. Add them in the Meta app (Instagram use case → Permissions) and to the login's scopes, then reconnect and allow Instagram.`
    );
  }
  if (page.value.instagramAccountId === null) {
    return err(
      `The Page "${page.value.name}" has no Instagram account linked in this login. Link an Instagram Business account to the Page (Instagram app → Settings → Business tools, or Meta Business Suite), then reconnect and tick the Instagram account.`
    );
  }
  return ok({
    accountId: page.value.instagramAccountId,
    username: page.value.instagramUsername,
    page: page.value,
  });
}

/** Instagram takes 4:5 (portrait) to 1.91:1 (landscape). */
export const INSTAGRAM_MIN_ASPECT = 4 / 5;
export const INSTAGRAM_MAX_ASPECT = 1.91;

/** Why Instagram would refuse an image this shape, or null. */
export function findInstagramAspectProblem(
  width: number,
  height: number
): string | null {
  if (width <= 0 || height <= 0) return 'The image has no size.';
  const ratio: number = width / height;
  // A hair of slack, so 1080×1350 (exactly 4:5) isn't refused by rounding.
  if (ratio < INSTAGRAM_MIN_ASPECT - 0.005) {
    return `The image is ${width}×${height}, taller than Instagram allows (4:5 at most). Use a squarer image, or pad it to 4:5.`;
  }
  if (ratio > INSTAGRAM_MAX_ASPECT + 0.005) {
    return `The image is ${width}×${height}, wider than Instagram allows (1.91:1 at most).`;
  }
  return null;
}

export interface InstagramPublisherOptions {
  /** Between status checks while Instagram fetches the image. */
  readonly pollIntervalMs?: number;
  /** Give up after this long; the container then just expires unused. */
  readonly pollTimeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly logger?: SocialLogger;
}

/**
 * Posts to the Instagram Business account linked to the chosen Page: the
 * JPG goes to the temporary bucket, Instagram gets a short-lived link to
 * it in a media container, the container is published once Instagram has
 * fetched the image, and the temporary copy is deleted either way.
 */
export class InstagramPublisher implements SocialPublisherPort {
  readonly platform = 'instagram' as const;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logger: SocialLogger;

  constructor(
    private readonly graph: MetaGraphClient,
    private readonly store: MetaLoginStore,
    private readonly tempImages: TempImageStore,
    private readonly pinnedPageId: string | null = null,
    options: InstagramPublisherOptions = {}
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.pollTimeoutMs = options.pollTimeoutMs ?? 60_000;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.logger = options.logger ?? silentLogger;
  }

  async publishImage(
    request: PublishImageRequest
  ): Promise<Result<PublishedPost>> {
    if (request.mimeType !== 'image/jpeg') {
      return err('Instagram only takes JPG images; send the image as a JPG.');
    }
    const login = await this.store.load();
    if (!login.ok) return login;
    const target = selectedInstagramAccount(login.value, this.pinnedPageId);
    if (!target.ok) return target;
    const { accountId, page } = target.value;
    const accountName: string =
      target.value.username === null
        ? `Instagram ${accountId}`
        : `@${target.value.username}`;
    if (accountId !== request.expectedAccountId) {
      return err(
        `Not posted: Instagram account ${request.expectedAccountId} was confirmed, but the chosen Page's account is now ${accountName} (${accountId}). Check the account before posting again.`
      );
    }

    const stored = await this.tempImages.put(request.bytes, 'image/jpeg');
    if (!stored.ok) return err(`Not posted to Instagram: ${stored.error}`);
    try {
      const container = await this.graph.createInstagramContainer(
        accountId,
        page.accessToken,
        stored.value.url,
        request.caption
      );
      if (!container.ok) return container;
      const ready = await this.waitUntilFinished(
        container.value,
        page.accessToken
      );
      if (!ready.ok) return ready;
      const mediaId = await this.graph.publishInstagramContainer(
        accountId,
        page.accessToken,
        container.value
      );
      if (!mediaId.ok) return mediaId;

      // The post is up; a missing link only costs the "View post" button.
      const link = await this.graph.instagramPermalink(
        mediaId.value,
        page.accessToken
      );
      if (!link.ok)
        this.logger.warn(
          `Posted to ${accountName} but couldn't read its link: ${link.error}`
        );
      return ok({
        externalPostId: mediaId.value,
        permalink: link.ok ? link.value : null,
        accountName,
      });
    } finally {
      // Instagram has its own copy once the container is FINISHED (or it failed).
      const deleted = await this.tempImages.delete(stored.value.key);
      if (!deleted.ok) {
        this.logger.warn(
          `Couldn't delete the temporary Instagram image ${stored.value.key}; a later sweep removes it: ${deleted.error}`
        );
      }
    }
  }

  private async waitUntilFinished(
    containerId: string,
    pageToken: string
  ): Promise<Result<void>> {
    const attempts: number = Math.max(
      1,
      Math.ceil(this.pollTimeoutMs / this.pollIntervalMs)
    );
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const status = await this.graph.instagramContainerStatus(
        containerId,
        pageToken
      );
      if (!status.ok) return status;
      const { statusCode, detail } = status.value;
      if (statusCode === 'FINISHED') return ok(undefined);
      if (statusCode === 'ERROR' || statusCode === 'EXPIRED') {
        return err(
          `Instagram couldn't use the image (container ${containerId} is ${statusCode}${detail === '' ? '' : `: ${detail}`}). Check it's a JPG between 4:5 and 1.91:1 and under 8 MB.`
        );
      }
      if (statusCode === 'PUBLISHED') {
        return err(
          `Instagram container ${containerId} was already published; not posting it twice.`
        );
      }
      await this.sleep(this.pollIntervalMs);
    }
    return err(
      `Instagram hadn't finished fetching the image after ${Math.round(this.pollTimeoutMs / 1000)} s (container ${containerId}); nothing was posted. Try again.`
    );
  }
}
