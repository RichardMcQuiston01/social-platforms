import { silentLogger, type SocialLogger } from '../logger.js';
import type {
  PublishedPost,
  PublishImageRequest,
  SocialPublisherPort,
} from '../port.js';
import { err, ok, type Result } from '../result.js';
import { FACEBOOK_REQUIRED_SCOPES } from './config.js';
import type { MetaGraphClient, MetaPage } from './graph.js';
import type { MetaLoginStore } from './token.js';

/** The Page task that allows posting. */
const CREATE_CONTENT_TASK = 'CREATE_CONTENT';

/**
 * The Page posts go to, or why there isn't one: not connected, no Page
 * chosen, a missing permission, or no right to post on it.
 */
export function selectedPostingPage(
  login: {
    readonly grantedScopes: readonly string[];
    readonly pages: readonly MetaPage[];
    readonly selectedPageId: string | null;
  } | null,
  /** MetaConfig's `preferredPageId`: when set, no other Page is ever posted to. */
  pinnedPageId: string | null = null
): Result<MetaPage> {
  if (login === null) {
    return err("Facebook isn't connected: connect Facebook first.");
  }
  const missing: string[] = FACEBOOK_REQUIRED_SCOPES.filter(
    (scope) => !login.grantedScopes.includes(scope)
  );
  if (login.grantedScopes.length > 0 && missing.length > 0) {
    return err(
      `The Facebook login doesn't grant ${missing.join(', ')}. Connect again and allow every permission (the Meta app needs the "Manage everything on your Page" use case).`
    );
  }
  if (login.pages.length === 0) {
    return err(
      "The Facebook login can see no Pages. Connect again and tick the Page when Facebook asks which Pages to allow. If the Page belongs to a business portfolio, add business_management to the login's scopes."
    );
  }
  if (login.selectedPageId === null) {
    return err('No Facebook Page is chosen to post to yet.');
  }
  if (pinnedPageId !== null && login.selectedPageId !== pinnedPageId) {
    const pinned: MetaPage | undefined = login.pages.find(
      (item) => item.id === pinnedPageId
    );
    return err(
      pinned === undefined
        ? `Posting is pinned to Page ${pinnedPageId}, but this Facebook login can't post to that Page. Connect again and tick it when Facebook asks which Pages to allow, or change the pinned Page id.`
        : `Posting is pinned to "${pinned.name}", but another Page is chosen. Choose "${pinned.name}".`
    );
  }
  const page: MetaPage | undefined = login.pages.find(
    (item) => item.id === login.selectedPageId
  );
  if (page === undefined) {
    return err(
      `The chosen Page ${login.selectedPageId} isn't in the saved login any more. Choose a Page again.`
    );
  }
  if (page.tasks.length > 0 && !page.tasks.includes(CREATE_CONTENT_TASK)) {
    return err(
      `Your Facebook account can't create posts on "${page.name}" (its Page tasks are ${page.tasks.join(', ')}).`
    );
  }
  return ok(page);
}

export class FacebookPagePublisher implements SocialPublisherPort {
  readonly platform = 'facebook' as const;

  constructor(
    private readonly graph: MetaGraphClient,
    private readonly store: MetaLoginStore,
    private readonly pinnedPageId: string | null = null,
    private readonly logger: SocialLogger = silentLogger
  ) {}

  async publishImage(
    request: PublishImageRequest
  ): Promise<Result<PublishedPost>> {
    const login = await this.store.load();
    if (!login.ok) return login;
    const page = selectedPostingPage(login.value, this.pinnedPageId);
    if (!page.ok) return page;
    // The Page the owner confirmed in the browser must still be the chosen one.
    if (page.value.id !== request.expectedAccountId) {
      return err(
        `Not posted: Page ${request.expectedAccountId} was confirmed, but the chosen Page is now "${page.value.name}" (${page.value.id}). Check the Page before posting again.`
      );
    }

    const published = await this.graph.publishPagePhoto(
      page.value,
      request,
      request.caption
    );
    if (!published.ok) return published;
    const postId: string | null = published.value.postId;
    const objectId: string = postId ?? published.value.photoId;

    // The post is up; a missing link only costs the "View post" button.
    const link = await this.graph.permalink(
      objectId,
      postId === null ? 'photo' : 'post',
      page.value.accessToken
    );
    if (!link.ok)
      this.logger.warn(
        `Posted to "${page.value.name}" but couldn't read its link: ${link.error}`
      );
    return ok({
      externalPostId: objectId,
      permalink: link.ok ? link.value : null,
      accountName: page.value.name,
    });
  }
}
