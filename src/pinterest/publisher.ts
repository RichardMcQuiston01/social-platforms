import { bytesToBase64 } from '../encoding.js';
import type {
  PublishedPost,
  PublishImageRequest,
  SocialPublisherPort,
} from '../port.js';
import { err, ok, type Result } from '../result.js';
import {
  PIN_ALT_TEXT_MAX,
  PIN_DESCRIPTION_MAX,
  PIN_TITLE_MAX,
  pinPermalink,
  type PinterestClient,
} from './api.js';
import type { PinterestRefresher } from './login.js';

/** Pinterest's smallest useful Pin image width. */
export const PINTEREST_MIN_IMAGE_WIDTH = 200;

/** Why Pinterest's Pin would be refused or look wrong at this size, or null. */
export function findPinterestImageProblem(
  width: number,
  height: number
): string | null {
  if (width <= 0 || height <= 0) return 'The image has no size.';
  if (width < PINTEREST_MIN_IMAGE_WIDTH) {
    return `The image is ${width} px wide; Pinterest needs at least ${PINTEREST_MIN_IMAGE_WIDTH}.`;
  }
  return null;
}

/**
 * The default link check: any https address. Pass `checkLink` to the
 * publisher to allow only your own (e.g. product pages on one store).
 */
export function checkHttpsLink(link: string): string | null {
  try {
    if (new URL(link).protocol === 'https:') return null;
  } catch {
    // Reported below.
  }
  return `A Pin's link must be an https address, not "${link}".`;
}

export interface PinterestPublisherOptions {
  /** Why a Pin may not link to this address, or null when it may. */
  readonly checkLink?: (link: string) => string | null;
  readonly now?: () => Date;
}

/**
 * Pins an image to one of the owner's boards. The image goes inline
 * (base64), so Pinterest needs no temporary bucket. The board must be one
 * the login can see, and the one the owner confirmed, so a Pin never lands
 * on the wrong board.
 */
export class PinterestPublisher implements SocialPublisherPort {
  readonly platform = 'pinterest' as const;

  private readonly checkLink: (link: string) => string | null;
  private readonly now: () => Date;

  constructor(
    private readonly client: PinterestClient,
    private readonly refresher: PinterestRefresher,
    options: PinterestPublisherOptions = {}
  ) {
    this.checkLink = options.checkLink ?? checkHttpsLink;
    this.now = options.now ?? (() => new Date());
  }

  async publishImage(
    request: PublishImageRequest
  ): Promise<Result<PublishedPost>> {
    if (request.mimeType !== 'image/jpeg') {
      return err('Pinterest takes JPG images here; send the image as a JPG.');
    }
    const pin = request.pin;
    if (pin === undefined)
      return err('A Pin needs a title and the listing link.');
    if (pin.title === '' || pin.title.length > PIN_TITLE_MAX) {
      return err(`A Pin's title must be 1 to ${PIN_TITLE_MAX} characters.`);
    }
    if (request.caption.length > PIN_DESCRIPTION_MAX) {
      return err(
        `A Pin's description can be at most ${PIN_DESCRIPTION_MAX} characters.`
      );
    }
    if (pin.altText.length > PIN_ALT_TEXT_MAX) {
      return err(
        `A Pin's alt text can be at most ${PIN_ALT_TEXT_MAX} characters.`
      );
    }
    const linkProblem: string | null = this.checkLink(pin.link);
    if (linkProblem !== null) return err(linkProblem);

    const login = await this.refresher.current(this.now());
    if (!login.ok) return login;
    if (login.value === null)
      return err("Pinterest isn't connected: connect Pinterest first.");
    const { accessToken, username, environment } = login.value;

    const boards = await this.client.listBoards(accessToken);
    if (!boards.ok) return boards;
    const board = boards.value.find(
      (item) => item.id === request.expectedAccountId
    );
    if (board === undefined) {
      return err(
        `Not pinned: board ${request.expectedAccountId} isn't one of ${username}'s boards${environment === 'sandbox' ? ' in the sandbox' : ''}. Choose the board again.`
      );
    }

    const pinId = await this.client.createPin(accessToken, {
      boardId: board.id,
      title: pin.title,
      description: request.caption,
      link: pin.link,
      altText: pin.altText,
      jpegBase64: bytesToBase64(request.bytes),
    });
    if (!pinId.ok) return pinId;
    return ok({
      externalPostId: pinId.value,
      permalink: pinPermalink(pinId.value),
      accountName: `${board.name} (${username}${environment === 'sandbox' ? ', sandbox' : ''})`,
    });
  }
}
