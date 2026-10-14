import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { err, ok, type Result } from '../src/index.js';
import {
  checkHttpsLink,
  completePinterestLogin,
  describePinterestError,
  PINTEREST_SCOPES,
  PinterestClient,
  PinterestPublisher,
  PinterestRefresher,
  pinPermalink,
  readPinterestConfig,
  type PinterestConfig,
  type PinterestLogin,
  type PinterestLoginStore,
} from '../src/pinterest/index.js';

const DEFAULT_PINTEREST_REDIRECT_URI =
  'http://localhost:3006/oauth/pinterest/callback';

const CONFIG: PinterestConfig = {
  appId: '1234567',
  appSecret: 'pin-secret',
  redirectUri: DEFAULT_PINTEREST_REDIRECT_URI,
  callbackPort: 3006,
  callbackPath: '/oauth/pinterest/callback',
  environment: 'sandbox',
};

const NOW = new Date('2026-10-14T12:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const LOGIN: PinterestLogin = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: new Date(NOW.getTime() + 20 * DAY_MS).toISOString(),
  refreshTokenExpiresAt: new Date(NOW.getTime() + 300 * DAY_MS).toISOString(),
  scopes: [...PINTEREST_SCOPES],
  username: 'exampleshop',
  accountType: 'BUSINESS',
  environment: 'sandbox',
  defaultBoardId: '55',
  defaultBoardName: 'Laser jigs',
  tokenIssuedAt: NOW.toISOString(),
  savedAt: NOW.toISOString(),
};

interface Call {
  url: string;
  init: RequestInit | undefined;
}

/** A fake fetch answering by URL path; records every call. */
function fakeFetch(
  answers: Record<
    string,
    unknown | ((init: RequestInit | undefined) => unknown)
  >,
  status: Record<string, number> = {}
): {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const path: string = new URL(url).pathname;
      const answer = answers[path];
      const body: unknown =
        typeof answer === 'function' ? answer(init) : (answer ?? {});
      return new Response(JSON.stringify(body), {
        status: status[path] ?? 200,
      });
    },
  };
}

class MemoryStore implements PinterestLoginStore {
  saves = 0;
  constructor(public login: PinterestLogin | null) {}
  async load(): Promise<Result<PinterestLogin | null>> {
    return ok(this.login);
  }
  async save(login: PinterestLogin): Promise<Result<void>> {
    this.saves += 1;
    this.login = login;
    return ok(undefined);
  }
  async clear(): Promise<Result<void>> {
    this.login = null;
    return ok(undefined);
  }
}

void describe('PinterestClient', () => {
  void it('asks only for board, Pin and account-read scopes', () => {
    const url = new URL(
      new PinterestClient(CONFIG).authorizationUrl('state-1')
    );
    assert.equal(url.origin + url.pathname, 'https://www.pinterest.com/oauth/');
    assert.equal(
      url.searchParams.get('redirect_uri'),
      DEFAULT_PINTEREST_REDIRECT_URI
    );
    assert.equal(url.searchParams.get('state'), 'state-1');
    const scopes: string[] = (url.searchParams.get('scope') ?? '').split(',');
    assert.ok(
      scopes.every((scope) => /^(boards|pins|user_accounts):/.test(scope))
    );
    assert.ok(
      !scopes.some(
        (scope) => scope.startsWith('ads') || scope === 'user_accounts:write'
      )
    );
  });

  void it('exchanges the code at the sandbox with Basic auth', async () => {
    const fake = fakeFetch({
      '/v5/oauth/token': {
        access_token: 'a',
        refresh_token: 'r',
        expires_in: 2592000,
        refresh_token_expires_in: 31536000,
        scope: 'boards:read,pins:write',
      },
    });
    const client = new PinterestClient(CONFIG, fake.fetch, () => NOW);
    const tokens = await client.exchangeCode('code-1');
    assert.ok(tokens.ok);
    assert.equal(
      tokens.value.expiresAt?.toISOString(),
      '2026-11-13T12:00:00.000Z'
    );
    assert.deepEqual(tokens.value.scopes, ['boards:read', 'pins:write']);
    const call = fake.calls[0];
    assert.equal(call?.url, 'https://api-sandbox.pinterest.com/v5/oauth/token');
    const headers = call?.init?.headers as Record<string, string>;
    assert.equal(
      headers['authorization'],
      `Basic ${btoa('1234567:pin-secret')}`
    );
    const body = new URLSearchParams(String(call?.init?.body));
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('code'), 'code-1');
    assert.equal(body.get('continuous_refresh'), 'true');
  });

  void it('keeps the old refresh token when a refresh returns none', async () => {
    const fake = fakeFetch({
      '/v5/oauth/token': { access_token: 'a2', expires_in: 60 },
    });
    const tokens = await new PinterestClient(
      { ...CONFIG, environment: 'production' },
      fake.fetch,
      () => NOW
    ).refresh('refresh-old');
    assert.ok(tokens.ok);
    assert.equal(tokens.value.refreshToken, 'refresh-old');
    assert.equal(
      fake.calls[0]?.url,
      'https://api.pinterest.com/v5/oauth/token'
    );
  });

  void it('pages through the boards and sorts them', async () => {
    let page = 0;
    const fake = fakeFetch({
      '/v5/boards': () => {
        page += 1;
        return page === 1
          ? {
              items: [{ id: '2', name: 'Organizers', privacy: 'PUBLIC' }],
              bookmark: 'next',
            }
          : {
              items: [
                { id: '1', name: 'Laser jigs', privacy: 'SECRET' },
                { name: 'no id' },
              ],
            };
      },
    });
    const boards = await new PinterestClient(CONFIG, fake.fetch).listBoards(
      'token'
    );
    assert.ok(boards.ok);
    assert.deepEqual(
      boards.value.map((board) => board.name),
      ['Laser jigs', 'Organizers']
    );
    assert.equal(
      new URL(fake.calls[1]?.url ?? '').searchParams.get('bookmark'),
      'next'
    );
  });

  void it('sends the image inline and returns the Pin id', async () => {
    const fake = fakeFetch({ '/v5/pins': { id: '999' } });
    const created = await new PinterestClient(CONFIG, fake.fetch).createPin(
      'token',
      {
        boardId: '55',
        title: 'Jig',
        description: 'A jig',
        link: 'https://www.etsy.com/listing/123',
        altText: '',
        jpegBase64: 'AAAA',
      }
    );
    assert.deepEqual(created, ok('999'));
    const sent = JSON.parse(String(fake.calls[0]?.init?.body)) as Record<
      string,
      unknown
    >;
    assert.deepEqual(sent['media_source'], {
      source_type: 'image_base64',
      content_type: 'image/jpeg',
      data: 'AAAA',
    });
    assert.equal('alt_text' in sent, false);
    assert.equal(pinPermalink('999'), 'https://www.pinterest.com/pin/999/');
  });

  void it('explains a Trial app posting to production', () => {
    const message = describePinterestError('the Pin', 403, {
      code: 29,
      message: 'Apps with Trial access may not create Pins in production',
    });
    assert.match(message, /HTTP 403, code 29/);
    assert.match(message, /environment to sandbox/);
    assert.match(
      describePinterestError('x', 401, {}),
      /connect Pinterest again/
    );
  });
});

void describe('completePinterestLogin', () => {
  void it('saves the tokens and account, keeping the default board for the same account', async () => {
    const fake = fakeFetch({
      '/v5/oauth/token': {
        access_token: 'new-a',
        refresh_token: 'new-r',
        expires_in: 100,
      },
      '/v5/user_account': { username: 'exampleshop', account_type: 'BUSINESS' },
    });
    const store = new MemoryStore(LOGIN);
    const saved = await completePinterestLogin(
      'code',
      CONFIG,
      new PinterestClient(CONFIG, fake.fetch, () => NOW),
      store,
      NOW
    );
    assert.ok(saved.ok);
    assert.equal(store.login?.accessToken, 'new-a');
    assert.equal(store.login?.defaultBoardId, '55');
    assert.equal(store.login?.environment, 'sandbox');
  });

  void it("drops the default board when it's another account", async () => {
    const fake = fakeFetch({
      '/v5/oauth/token': { access_token: 'a', refresh_token: 'r' },
      '/v5/user_account': {
        username: 'someone-else',
        account_type: 'BUSINESS',
      },
    });
    const store = new MemoryStore(LOGIN);
    await completePinterestLogin(
      'code',
      CONFIG,
      new PinterestClient(CONFIG, fake.fetch),
      store,
      NOW
    );
    assert.equal(store.login?.defaultBoardId, null);
  });
});

void describe('PinterestRefresher', () => {
  void it('uses the saved token until it is due', async () => {
    const fake = fakeFetch({});
    const store = new MemoryStore(LOGIN);
    const current = await new PinterestRefresher(
      new PinterestClient(CONFIG, fake.fetch),
      store
    ).current(NOW);
    assert.ok(current.ok);
    assert.equal(current.value?.accessToken, 'access-1');
    assert.equal(fake.calls.length, 0);
  });

  void it('refreshes once even when asked twice at the same time, and saves the rotated token', async () => {
    const fake = fakeFetch({
      '/v5/oauth/token': {
        access_token: 'access-2',
        refresh_token: 'refresh-2',
        expires_in: 2592000,
      },
    });
    const due: PinterestLogin = {
      ...LOGIN,
      expiresAt: new Date(NOW.getTime() + DAY_MS).toISOString(),
    };
    const store = new MemoryStore(due);
    const refresher = new PinterestRefresher(
      new PinterestClient(CONFIG, fake.fetch, () => NOW),
      store
    );
    const [first, second] = await Promise.all([
      refresher.current(NOW),
      refresher.current(NOW),
    ]);
    assert.equal(fake.calls.length, 1);
    assert.ok(first.ok && second.ok);
    assert.equal(store.login?.refreshToken, 'refresh-2');
    assert.equal(store.saves, 1);
  });

  void it('says to connect again once the refresh token has run out', async () => {
    const store = new MemoryStore({
      ...LOGIN,
      refreshTokenExpiresAt: new Date(NOW.getTime() - 1000).toISOString(),
    });
    const current = await new PinterestRefresher(
      new PinterestClient(CONFIG, fakeFetch({}).fetch),
      store
    ).current(NOW);
    assert.ok(!current.ok);
    assert.match(current.error, /connect Pinterest again/);
  });
});

void describe('PinterestPublisher', () => {
  const request = {
    bytes: new Uint8Array([0xff, 0xd8]),
    mimeType: 'image/jpeg' as const,
    fileName: 'x.jpg',
    caption: 'A sturdy jig #laser',
    expectedAccountId: '55',
    pin: {
      title: 'Business card jig',
      link: 'https://www.etsy.com/listing/123',
      altText: 'A jig',
    },
  };

  /** Only one store's product pages, like an app would set. */
  const shopLinksOnly = (link: string): string | null =>
    /^https:\/\/www\.etsy\.com\/listing\/\d+$/.test(link)
      ? null
      : `A Pin links only to its Etsy listing, not "${link}".`;

  function publisher(boards: unknown[]): {
    publisher: PinterestPublisher;
    calls: Call[];
  } {
    const fake = fakeFetch({
      '/v5/boards': { items: boards },
      '/v5/pins': { id: '777' },
    });
    const client = new PinterestClient(CONFIG, fake.fetch);
    return {
      publisher: new PinterestPublisher(
        client,
        new PinterestRefresher(client, new MemoryStore(LOGIN)),
        { checkLink: shopLinksOnly, now: () => NOW }
      ),
      calls: fake.calls,
    };
  }

  void it('pins to the confirmed board', async () => {
    const { publisher: pin, calls } = publisher([
      { id: '55', name: 'Laser jigs' },
    ]);
    const published = await pin.publishImage(request);
    assert.deepEqual(
      published,
      ok({
        externalPostId: '777',
        permalink: 'https://www.pinterest.com/pin/777/',
        accountName: 'Laser jigs (exampleshop, sandbox)',
      })
    );
    const body = JSON.parse(String(calls.at(-1)?.init?.body)) as Record<
      string,
      unknown
    >;
    assert.equal(body['board_id'], '55');
    assert.equal(body['link'], 'https://www.etsy.com/listing/123');
  });

  void it("refuses a board the login can't see, and a link that isn't the listing", async () => {
    const { publisher: wrongBoard, calls } = publisher([
      { id: '66', name: 'Other' },
    ]);
    const refused = await wrongBoard.publishImage(request);
    assert.ok(!refused.ok);
    assert.match(
      refused.error,
      /board 55 isn't one of exampleshop's boards in the sandbox/
    );
    assert.ok(!calls.some((call) => call.url.endsWith('/pins')));

    const { publisher: pin } = publisher([{ id: '55', name: 'Laser jigs' }]);
    const offEtsy = await pin.publishImage({
      ...request,
      pin: { ...request.pin, link: 'https://example.com/shop' },
    });
    assert.deepEqual(
      offEtsy,
      err(
        'A Pin links only to its Etsy listing, not "https://example.com/shop".'
      )
    );
  });

  void it('accepts any https link by default', () => {
    assert.equal(checkHttpsLink('https://example.com/p/1'), null);
    assert.match(checkHttpsLink('http://example.com') ?? '', /https/);
    assert.match(checkHttpsLink('not a link') ?? '', /https/);
  });
});

void describe('readPinterestConfig', () => {
  void it('needs an app id and secret and a loopback redirect', () => {
    const base = {
      appId: '1234567',
      appSecret: 's',
      redirectUri: DEFAULT_PINTEREST_REDIRECT_URI,
      environment: 'sandbox' as const,
    };
    const config = readPinterestConfig(base);
    assert.ok(config.ok);
    assert.equal(config.value.callbackPort, 3006);
    assert.equal(readPinterestConfig({ ...base, appSecret: '' }).ok, false);
    assert.equal(
      readPinterestConfig({ ...base, redirectUri: 'https://localhost:3006/cb' })
        .ok,
      false
    );
  });
});
