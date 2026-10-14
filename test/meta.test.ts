import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  appSecretProof,
  checkMetaAuthorizationUrl,
  choosePage,
  completeMetaLogin,
  describeGraphError,
  FacebookPagePublisher,
  grantedPageIdsFrom,
  mapPages,
  MetaGraphClient,
  NO_PAGE_TOKEN_REASON,
  parseMetaLogin,
  readMetaConfig,
  selectedPostingPage,
  type MetaConfig,
  type MetaConfigInput,
  type MetaLogin,
  type MetaLoginStore,
  type MetaPage,
} from '../src/meta/index.js';
import {
  checkLoopbackRedirectUri,
  ok,
  parseScopeList,
  type FetchLike,
  type Result,
} from '../src/index.js';

const NOW = new Date('2026-10-09T12:00:00.000Z');

const BASE_INPUT: MetaConfigInput = {
  appId: '123456',
  appSecret: 'shh',
  redirectUri: 'http://localhost:3004/oauth/meta/callback',
  scopes: 'pages_show_list,pages_read_engagement,pages_manage_posts',
  graphVersion: 'v23.0',
};

function config(overrides: Partial<MetaConfigInput> = {}): MetaConfig {
  const result = readMetaConfig({ ...BASE_INPUT, ...overrides });
  assert.ok(result.ok);
  return result.value;
}

const PAGE: MetaPage = {
  id: '111',
  name: 'Example Shop',
  accessToken: 'page-token',
  tasks: ['CREATE_CONTENT', 'MANAGE'],
  instagramAccountId: '999',
  instagramUsername: 'exampleshop',
};

function login(overrides: Partial<MetaLogin> = {}): MetaLogin {
  return {
    userAccessToken: 'user-token',
    userTokenExpiresAt: null,
    grantedScopes: [
      'pages_show_list',
      'pages_read_engagement',
      'pages_manage_posts',
    ],
    pages: [PAGE],
    unavailablePages: [],
    selectedPageId: '111',
    savedAt: NOW.toISOString(),
    ...overrides,
  };
}

class MemoryStore implements MetaLoginStore {
  constructor(public value: MetaLogin | null = null) {}
  async load(): Promise<Result<MetaLogin | null>> {
    return ok(this.value);
  }
  async save(next: MetaLogin): Promise<Result<void>> {
    this.value = next;
    return ok(undefined);
  }
  async clear(): Promise<Result<void>> {
    this.value = null;
    return ok(undefined);
  }
}

interface Call {
  readonly url: URL;
  readonly init: RequestInit | undefined;
}

/** Answers by "METHOD pathname" with a JSON body and status. */
function fakeFetch(
  routes: Record<string, { status?: number; json: unknown }>
): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      const url = new URL(input);
      calls.push({ url, init });
      const route = routes[`${init?.method ?? 'GET'} ${url.pathname}`];
      if (route === undefined) {
        return new Response(
          JSON.stringify({ error: { message: 'no route', code: 1 } }),
          { status: 404 }
        );
      }
      return new Response(JSON.stringify(route.json), {
        status: route.status ?? 200,
      });
    },
  };
}

void describe('meta-config', () => {
  void it('needs an app id and secret, and reads the callback port and path', () => {
    assert.equal(readMetaConfig({ ...BASE_INPUT, appId: '' }).ok, false);
    assert.equal(readMetaConfig({ ...BASE_INPUT, appSecret: ' ' }).ok, false);
    const value = config();
    assert.equal(value.callbackPort, 3004);
    assert.equal(value.callbackPath, '/oauth/meta/callback');
    assert.equal(value.loginConfigId, null);
    assert.equal(config({ pageId: '42' }).preferredPageId, '42');
  });

  void it('defaults the scopes and the Graph version', () => {
    const value = readMetaConfig({
      ...BASE_INPUT,
      scopes: '',
      graphVersion: '',
    });
    assert.ok(value.ok);
    assert.ok(value.value.scopes.includes('instagram_content_publish'));
    assert.equal(value.value.graphVersion, 'v23.0');
    assert.equal(
      readMetaConfig({ ...BASE_INPUT, graphVersion: '23' }).ok,
      false
    );
  });

  void it('refuses messaging permissions', () => {
    const result = readMetaConfig({
      ...BASE_INPUT,
      scopes: 'pages_manage_posts pages_messaging',
    });
    assert.ok(!result.ok);
    assert.match(result.error, /pages_messaging/);
  });

  void it('only accepts a loopback http redirect with a port and path', () => {
    assert.ok(checkLoopbackRedirectUri('http://127.0.0.1:3004/cb').ok);
    assert.match(
      (
        checkLoopbackRedirectUri('https://localhost:3004/cb') as {
          error: string;
        }
      ).error,
      /http/
    );
    assert.match(
      (
        checkLoopbackRedirectUri('http://example.com:3004/cb') as {
          error: string;
        }
      ).error,
      /localhost/
    );
    assert.match(
      (checkLoopbackRedirectUri('http://localhost/cb') as { error: string })
        .error,
      /port/
    );
    assert.match(
      (checkLoopbackRedirectUri('http://localhost:3004') as { error: string })
        .error,
      /path/
    );
  });

  void it('splits scope lists on commas and spaces, without duplicates', () => {
    assert.deepEqual(parseScopeList(' a, b  c,a '), ['a', 'b', 'c']);
  });
});

void describe('appSecretProof', () => {
  void it('is the hex HMAC-SHA256 of the token with the app secret', async () => {
    const expected: string = createHmac('sha256', 'shh')
      .update('page-token')
      .digest('hex');
    assert.equal(await appSecretProof('page-token', 'shh'), expected);
  });
});

void describe('MetaGraphClient', () => {
  void it('builds the consent URL with scopes, or the Login for Business configuration', () => {
    const scoped = new URL(
      new MetaGraphClient(config()).authorizationUrl('st')
    );
    assert.equal(scoped.origin, 'https://www.facebook.com');
    assert.equal(scoped.pathname, '/v23.0/dialog/oauth');
    assert.equal(scoped.searchParams.get('state'), 'st');
    assert.equal(
      scoped.searchParams.get('scope'),
      'pages_show_list,pages_read_engagement,pages_manage_posts'
    );
    const configured = new URL(
      new MetaGraphClient(config({ loginConfigId: '777' })).authorizationUrl(
        'st'
      )
    );
    assert.equal(configured.searchParams.get('config_id'), '777');
    assert.equal(configured.searchParams.get('scope'), null);
    assert.ok(checkMetaAuthorizationUrl(scoped.toString()).ok);
    assert.ok(!checkMetaAuthorizationUrl('https://evil.example/dialog').ok);
  });

  void it('sends appsecret_proof with every token and posts the photo bytes as multipart', async () => {
    const fake = fakeFetch({
      'POST /v23.0/111/photos': { json: { id: 'photo1', post_id: '111_222' } },
      'GET /v23.0/111_222': {
        json: { permalink_url: 'https://www.facebook.com/111/posts/222' },
      },
    });
    const client = new MetaGraphClient(config(), fake.fetch);
    const posted = await client.publishPagePhoto(
      PAGE,
      {
        bytes: new Uint8Array([0xff, 0xd8, 0xff]),
        mimeType: 'image/jpeg',
        fileName: 'a.jpg',
      },
      'Hello'
    );
    assert.deepEqual(posted, ok({ photoId: 'photo1', postId: '111_222' }));
    const form = fake.calls[0]?.init?.body as FormData;
    assert.equal(form.get('message'), 'Hello');
    assert.equal(form.get('access_token'), 'page-token');
    assert.equal(
      form.get('appsecret_proof'),
      await appSecretProof('page-token', 'shh')
    );
    assert.equal((form.get('source') as Blob).type, 'image/jpeg');

    const link = await client.permalink('111_222', 'post', 'page-token');
    assert.deepEqual(link, ok('https://www.facebook.com/111/posts/222'));
    // `link` on a Post is deprecated (error 12); only a Photo is asked for it.
    assert.equal(
      fake.calls[1]?.url.searchParams.get('fields'),
      'permalink_url'
    );
    assert.equal(
      fake.calls[1]?.url.searchParams.get('appsecret_proof'),
      await appSecretProof('page-token', 'shh')
    );
  });

  void it('asks a photo (no post id) for its link, made absolute', async () => {
    const fake = fakeFetch({
      'GET /v23.0/photo1': { json: { link: '/photo/?fbid=1' } },
    });
    const client = new MetaGraphClient(config(), fake.fetch);
    const link = await client.permalink('photo1', 'photo', 'page-token');
    assert.deepEqual(link, ok('https://www.facebook.com/photo/?fbid=1'));
    assert.equal(fake.calls[0]?.url.searchParams.get('fields'), 'link');
  });

  void it('reports Facebook errors specifically, with the fix for an expired token', async () => {
    const fake = fakeFetch({
      'POST /v23.0/111/photos': {
        status: 400,
        json: {
          error: { message: 'Session expired', code: 190, fbtrace_id: 'TR1' },
        },
      },
    });
    const posted = await new MetaGraphClient(
      config(),
      fake.fetch
    ).publishPagePhoto(
      PAGE,
      { bytes: new Uint8Array([1]), mimeType: 'image/jpeg', fileName: 'a.jpg' },
      ''
    );
    assert.ok(!posted.ok);
    assert.match(posted.error, /HTTP 400, code 190/);
    assert.match(posted.error, /Session expired/);
    assert.match(posted.error, /TR1/);
    assert.match(posted.error, /connect again/);
    assert.doesNotMatch(posted.error, /page-token/);
    assert.match(
      describeGraphError('x', 403, { error: { message: 'nope', code: 200 } }),
      /permission/
    );
    assert.match(
      describeGraphError('x', 500, 'plain text'),
      /HTTP 500\): plain text/
    );
  });

  void it('maps Pages, reporting rows without a token instead of dropping them', () => {
    assert.deepEqual(
      mapPages([
        {
          id: '111',
          name: 'Shop',
          access_token: 't',
          tasks: ['CREATE_CONTENT', 5],
          instagram_business_account: { id: '9', username: 'shop' },
        },
        { id: '222', name: 'No token' },
      ]),
      {
        pages: [
          {
            id: '111',
            name: 'Shop',
            accessToken: 't',
            tasks: ['CREATE_CONTENT'],
            instagramAccountId: '9',
            instagramUsername: 'shop',
          },
        ],
        unavailable: [
          { id: '222', name: 'No token', reason: NO_PAGE_TOKEN_REASON },
        ],
      }
    );
  });

  void it('reads the granted Page ids from debug_token', () => {
    assert.deepEqual(
      grantedPageIdsFrom({
        data: {
          granular_scopes: [
            { scope: 'pages_show_list', target_ids: ['111', '222'] },
            { scope: 'pages_manage_posts', target_ids: ['222', '333'] },
            { scope: 'business_management', target_ids: ['999'] },
            { scope: 'pages_read_engagement' },
          ],
        },
      }),
      ['111', '222', '333']
    );
    assert.deepEqual(grantedPageIdsFrom({}), []);
  });
});

void describe('completeMetaLogin', () => {
  void it('exchanges the code, extends the token, and saves the Pages and permissions', async () => {
    const fake = fakeFetch({
      'GET /v23.0/oauth/access_token': {
        json: { access_token: 'long', expires_in: 5_184_000 },
      },
      'GET /v23.0/me/permissions': {
        json: {
          data: [
            { permission: 'pages_show_list', status: 'granted' },
            { permission: 'pages_manage_posts', status: 'declined' },
          ],
        },
      },
      'GET /v23.0/me/accounts': {
        json: {
          data: [
            { id: '111', name: 'Example Shop', access_token: 'pt', tasks: [] },
          ],
        },
      },
    });
    const store = new MemoryStore();
    const result = await completeMetaLogin(
      'code1',
      config(),
      new MetaGraphClient(config(), fake.fetch, () => NOW),
      store,
      NOW
    );
    assert.ok(result.ok);
    assert.equal(store.value?.userAccessToken, 'long');
    assert.equal(store.value?.userTokenExpiresAt, '2026-12-08T12:00:00.000Z');
    assert.deepEqual(store.value?.grantedScopes, ['pages_show_list']);
    // Even a single Page isn't chosen for the owner: it may not be the shop's.
    assert.equal(store.value?.selectedPageId, null);
    assert.equal(fake.calls[0]?.url.searchParams.get('code'), 'code1');
    assert.equal(
      fake.calls[1]?.url.searchParams.get('grant_type'),
      'fb_exchange_token'
    );
  });

  void it("adds a granted Page that /me/accounts left out, and reports one it can't use", async () => {
    const fake = fakeFetch({
      'GET /v23.0/oauth/access_token': {
        json: { access_token: 'long', expires_in: 5_184_000 },
      },
      'GET /v23.0/me/permissions': {
        json: {
          data: [{ permission: 'pages_manage_posts', status: 'granted' }],
        },
      },
      // Facebook lists only one of the three Pages ticked in the dialog.
      'GET /v23.0/me/accounts': {
        json: {
          data: [
            { id: '111', name: 'Maker Settings Network', access_token: 'pt1' },
          ],
        },
      },
      'GET /v23.0/debug_token': {
        json: {
          data: {
            granular_scopes: [
              {
                scope: 'pages_manage_posts',
                target_ids: ['111', '222', '333'],
              },
            ],
          },
        },
      },
      'GET /v23.0/222': {
        json: {
          id: '222',
          name: 'Example For You Design',
          access_token: 'pt2',
          tasks: ['CREATE_CONTENT'],
        },
      },
      'GET /v23.0/333': { json: { id: '333', name: 'Portfolio Only' } },
    });
    const store = new MemoryStore();
    const result = await completeMetaLogin(
      'code1',
      config(),
      new MetaGraphClient(config(), fake.fetch, () => NOW),
      store,
      NOW
    );
    assert.ok(result.ok);
    assert.deepEqual(
      store.value?.pages.map((page) => [page.id, page.name, page.accessToken]),
      [
        ['111', 'Maker Settings Network', 'pt1'],
        ['222', 'Example For You Design', 'pt2'],
      ]
    );
    assert.deepEqual(store.value?.unavailablePages, [
      { id: '333', name: 'Portfolio Only', reason: NO_PAGE_TOKEN_REASON },
    ]);
    // A Page node has no `tasks` field (Facebook answers 400, code 100).
    const byId = fake.calls.find((call) => call.url.pathname.endsWith('/222'));
    assert.doesNotMatch(byId?.url.searchParams.get('fields') ?? '', /tasks/);
    const debug = fake.calls.find((call) =>
      call.url.pathname.endsWith('/debug_token')
    );
    assert.equal(debug?.url.searchParams.get('input_token'), 'long');
  });

  void it("still saves the listed Pages when the grants can't be read", async () => {
    const fake = fakeFetch({
      'GET /v23.0/oauth/access_token': { json: { access_token: 'long' } },
      'GET /v23.0/me/permissions': { json: { data: [] } },
      'GET /v23.0/me/accounts': {
        json: {
          data: [
            { id: '111', name: 'Maker Settings Network', access_token: 'pt1' },
          ],
        },
      },
    });
    const store = new MemoryStore();
    const result = await completeMetaLogin(
      'code1',
      config(),
      new MetaGraphClient(config(), fake.fetch, () => NOW),
      store,
      NOW
    );
    assert.ok(result.ok);
    assert.equal(store.value?.pages.length, 1);
    assert.deepEqual(store.value?.unavailablePages, []);
  });
});

void describe('saved login', () => {
  void it('parses a saved login and explains a broken one', () => {
    assert.deepEqual(parseMetaLogin(JSON.stringify(login())), ok(login()));
    assert.match((parseMetaLogin('{') as { error: string }).error, /JSON/);
    assert.match(
      (parseMetaLogin('{"pages":[]}') as { error: string }).error,
      /userAccessToken/
    );
  });

  void it('picks the pinned Page, then the previous choice, and never guesses', () => {
    const other: MetaPage = { ...PAGE, id: '222', name: 'Other' };
    assert.equal(choosePage([PAGE, other], '222', '111'), '222');
    assert.equal(choosePage([PAGE, other], '999', '111'), '111');
    assert.equal(choosePage([PAGE, other], null, null), null);
    assert.equal(choosePage([PAGE], null, null), null);
  });
});

void describe('FacebookPagePublisher', () => {
  void it("says why it can't post: not connected, missing permission, no Page, no posting right", () => {
    assert.match(
      (selectedPostingPage(null) as { error: string }).error,
      /isn't connected/
    );
    assert.match(
      (
        selectedPostingPage(login({ grantedScopes: ['pages_show_list'] })) as {
          error: string;
        }
      ).error,
      /pages_read_engagement, pages_manage_posts/
    );
    assert.match(
      (
        selectedPostingPage(login({ pages: [], selectedPageId: null })) as {
          error: string;
        }
      ).error,
      /no Pages/
    );
    assert.match(
      (
        selectedPostingPage(login({ selectedPageId: null })) as {
          error: string;
        }
      ).error,
      /No Facebook Page is chosen/
    );
    assert.match(
      (
        selectedPostingPage(
          login({ pages: [{ ...PAGE, tasks: ['ANALYZE'] }] })
        ) as { error: string }
      ).error,
      /can't create posts/
    );
    assert.deepEqual(selectedPostingPage(login()), ok(PAGE));
  });

  void it("posts to the chosen Page and still succeeds when the link can't be read", async () => {
    const fake = fakeFetch({
      'POST /v23.0/111/photos': { json: { id: 'photo1' } },
    });
    const publisher = new FacebookPagePublisher(
      new MetaGraphClient(config(), fake.fetch),
      new MemoryStore(login())
    );
    const result = await publisher.publishImage({
      bytes: new Uint8Array([0xff, 0xd8, 0xff]),
      mimeType: 'image/jpeg',
      fileName: 'a.jpg',
      caption: 'Hi',
      expectedAccountId: '111',
    });
    assert.deepEqual(
      result,
      ok({
        externalPostId: 'photo1',
        permalink: null,
        accountName: 'Example Shop',
      })
    );
  });

  void it('refuses when the chosen Page is not the one the owner confirmed', async () => {
    const fake = fakeFetch({});
    const publisher = new FacebookPagePublisher(
      new MetaGraphClient(config(), fake.fetch),
      new MemoryStore(login())
    );
    const result = await publisher.publishImage({
      bytes: new Uint8Array([0xff, 0xd8, 0xff]),
      mimeType: 'image/jpeg',
      fileName: 'a.jpg',
      caption: 'Hi',
      expectedAccountId: '222',
    });
    assert.match(
      (result as { error: string }).error,
      /Page 222 was confirmed.*"Example Shop" \(111\)/
    );
    assert.equal(fake.calls.length, 0);
  });

  void it('a pinned Page id pins the Page', async () => {
    const other: MetaPage = { ...PAGE, id: '222', name: 'Other' };
    const pinnedElsewhere = login({
      pages: [PAGE, other],
      selectedPageId: '222',
    });
    assert.match(
      (selectedPostingPage(pinnedElsewhere, '111') as { error: string }).error,
      /pinned to "Example Shop"/
    );
    assert.match(
      (selectedPostingPage(login(), '999') as { error: string }).error,
      /pinned to Page 999/
    );
    assert.deepEqual(selectedPostingPage(login(), '111'), ok(PAGE));

    const fake = fakeFetch({});
    const publisher = new FacebookPagePublisher(
      new MetaGraphClient(config(), fake.fetch),
      new MemoryStore(pinnedElsewhere),
      '111'
    );
    const result = await publisher.publishImage({
      bytes: new Uint8Array([0xff, 0xd8, 0xff]),
      mimeType: 'image/jpeg',
      fileName: 'a.jpg',
      caption: 'Hi',
      expectedAccountId: '222',
    });
    assert.equal(result.ok, false);
    assert.equal(fake.calls.length, 0);
  });
});
