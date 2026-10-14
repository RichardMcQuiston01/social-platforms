import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ok,
  type FetchLike,
  type ListenForCallback,
  type Result,
  type StoredTempImage,
  type TempImageStore,
} from '../src/index.js';
import { readTlsFiles } from '../src/node.js';
import {
  checkThreadsAuthorizationUrl,
  describeThreadsError,
  findThreadsImageProblem,
  parseThreadsLogin,
  parseThreadsRedirectAddress as parseRedirectAddress,
  readThreadsConfig,
  refreshThreadsLoginIfDue,
  ThreadsClient,
  ThreadsLoginSession,
  ThreadsPublisher,
  threadsTokenDueForRefresh,
  type ThreadsConfig,
  type ThreadsConfigInput,
  type ThreadsLogin,
  type ThreadsLoginStore,
} from '../src/threads/index.js';

const NOW = new Date('2026-10-12T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const REDIRECT = 'https://localhost:3005/oauth/threads/callback';

const ENV: ThreadsConfigInput = {
  appId: '424242',
  appSecret: 'threads-secret',
  redirectUri: REDIRECT,
  apiVersion: 'v1.0',
};

function config(overrides: Partial<ThreadsConfigInput> = {}): ThreadsConfig {
  const result = readThreadsConfig({ ...ENV, ...overrides });
  assert.ok(result.ok);
  return result.value;
}

/** Never called: these logins are completed by pasting the redirect. */
const NO_LISTENER: ListenForCallback = async () => {
  throw new Error('no listener in these tests');
};

function savedLogin(overrides: Partial<ThreadsLogin> = {}): ThreadsLogin {
  return {
    accessToken: 'long-token',
    userId: '77',
    username: 'exampleshop',
    expiresAt: new Date(NOW.getTime() + 50 * DAY).toISOString(),
    tokenIssuedAt: new Date(NOW.getTime() - 10 * DAY).toISOString(),
    savedAt: new Date(NOW.getTime() - 10 * DAY).toISOString(),
    ...overrides,
  };
}

class MemoryStore implements ThreadsLoginStore {
  constructor(public value: ThreadsLogin | null = null) {}
  async load(): Promise<Result<ThreadsLogin | null>> {
    return ok(this.value);
  }
  async save(next: ThreadsLogin): Promise<Result<void>> {
    this.value = next;
    return ok(undefined);
  }
  async clear(): Promise<Result<void>> {
    this.value = null;
    return ok(undefined);
  }
}

class FakeTempStore implements TempImageStore {
  readonly puts: Uint8Array[] = [];
  readonly deletes: string[] = [];
  async put(bytes: Uint8Array): Promise<Result<StoredTempImage>> {
    this.puts.push(bytes);
    return ok({
      key: 'etsy-dashboard/social-temp/t.jpg',
      url: 'https://bucket.example/t.jpg?sig=1',
    });
  }
  async delete(key: string): Promise<Result<void>> {
    this.deletes.push(key);
    return ok(undefined);
  }
  async sweep(): Promise<Result<number>> {
    return ok(0);
  }
}

/** Threads API routes by "METHOD pathname"; a list answers in turn (for polling). */
function fakeThreads(routes: Record<string, unknown[] | unknown>): {
  fetch: FetchLike;
  calls: { method: string; url: string; body: string }[];
} {
  const calls: { method: string; url: string; body: string }[] = [];
  const queues = new Map<string, unknown[]>();
  for (const [key, value] of Object.entries(routes)) {
    queues.set(key, Array.isArray(value) ? [...value] : [value]);
  }
  return {
    calls,
    fetch: async (input, init) => {
      const url = new URL(input);
      const method: string = init?.method ?? 'GET';
      calls.push({ method, url: input, body: String(init?.body ?? '') });
      const queue = queues.get(`${method} ${url.pathname}`);
      if (queue === undefined || queue.length === 0) {
        return new Response(
          JSON.stringify({ error: { message: 'no route', code: 1 } }),
          { status: 404 }
        );
      }
      const next: unknown = queue.length > 1 ? queue.shift() : queue[0];
      const reply = next as { status?: number; json: unknown };
      return new Response(JSON.stringify(reply.json), {
        status: reply.status ?? 200,
      });
    },
  };
}

const LOGIN_ROUTES = {
  'POST /oauth/access_token': {
    json: { access_token: 'short-token', user_id: 77 },
  },
  'GET /access_token': {
    json: { access_token: 'long-token', expires_in: 5184000 },
  },
  'GET /v1.0/me': { json: { id: '77', username: 'exampleshop' } },
};

/** A JPEG with just enough segments to carry its size. */
function jpegOfSize(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
    0xff,
    0xd9,
  ]);
}

void describe('Threads config', () => {
  void it('needs an app id and secret, and an https redirect', () => {
    assert.equal(readThreadsConfig({ ...ENV, appSecret: '' }).ok, false);
    const http = readThreadsConfig({
      ...ENV,
      redirectUri: 'http://localhost:3005/cb',
    });
    assert.match(http.ok ? '' : http.error, /must use https/);
    assert.equal(config().listener, null);
  });

  void it('listens locally only with both certificate files and a localhost redirect', () => {
    const files = {
      tlsCertFile: 'localhost.pem',
      tlsKeyFile: 'localhost-key.pem',
    };
    assert.deepEqual(config(files).listener, {
      port: 3005,
      path: '/oauth/threads/callback',
      certFile: 'localhost.pem',
      keyFile: 'localhost-key.pem',
    });
    const half = readThreadsConfig({ ...ENV, tlsCertFile: 'a.pem' });
    assert.match(half.ok ? '' : half.error, /Give both/);
    const remote = readThreadsConfig({
      ...ENV,
      ...files,
      redirectUri: 'https://shop.example.com/cb',
    });
    assert.match(remote.ok ? '' : remote.error, /not localhost/);
  });

  void it('reads the certificate files and checks they are PEM', async () => {
    const files: Record<string, string> = {
      'c.pem': '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----',
      'k.pem': '-----BEGIN PRIVATE KEY-----\ny\n-----END PRIVATE KEY-----',
    };
    const read = async (path: string): Promise<string> => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT ${path}`);
      return text;
    };
    assert.equal((await readTlsFiles('c.pem', 'k.pem', read)).ok, true);
    files['k.pem'] = 'not a key';
    const bad = await readTlsFiles('c.pem', 'k.pem', read);
    assert.match(
      bad.ok ? '' : bad.error,
      /The key file \(k\.pem\) isn't a PEM private key/
    );
  });
});

void describe('ThreadsClient', () => {
  void it('builds the threads.net consent page with only the posting permissions', () => {
    const url = new URL(new ThreadsClient(config()).authorizationUrl('st8'));
    assert.equal(
      url.origin + url.pathname,
      'https://threads.net/oauth/authorize'
    );
    assert.equal(
      url.searchParams.get('scope'),
      'threads_basic,threads_content_publish'
    );
    assert.equal(url.searchParams.get('redirect_uri'), REDIRECT);
    assert.equal(url.searchParams.get('state'), 'st8');
    assert.equal(checkThreadsAuthorizationUrl(url.toString()).ok, true);
    assert.equal(
      checkThreadsAuthorizationUrl('https://evil.example/oauth').ok,
      false
    );
  });

  void it('explains an expired token', () => {
    assert.match(
      describeThreadsError('the account', 400, {
        error: { message: 'Session expired', code: 190 },
      }),
      /Threads refused the account \(HTTP 400, code 190\): Session expired\. The Threads login has expired/
    );
  });
});

void describe('Threads login', () => {
  void it('reads the code and state from a pasted address, and refuses others', () => {
    assert.deepEqual(
      parseRedirectAddress(`${REDIRECT}?code=abc123&state=st8#_`, REDIRECT),
      ok({ code: 'abc123', state: 'st8' })
    );
    const cases: [string, RegExp][] = [
      ['hello', /isn't a web address/],
      [
        'https://elsewhere.example/oauth/threads/callback?code=a&state=b',
        /doesn't start with/,
      ],
      [
        `${REDIRECT}?error=access_denied&error_description=Permissions+error`,
        /access_denied \(Permissions error\)/,
      ],
      [`${REDIRECT}?state=b`, /no code or state/],
    ];
    for (const [address, expected] of cases) {
      const result = parseRedirectAddress(address, REDIRECT);
      assert.match(result.ok ? '' : result.error, expected);
    }
  });

  void it('completes a pasted login: long-lived token and account saved', async () => {
    const api = fakeThreads(LOGIN_ROUTES);
    const store = new MemoryStore();
    const session = new ThreadsLoginSession(
      config(),
      new ThreadsClient(config(), api.fetch, () => NOW),
      store,
      {
        listen: NO_LISTENER,
        readTls: async () => ok({ cert: '', key: '' }),
        now: () => NOW,
      }
    );
    const begun = await session.begin();
    assert.ok(begun.ok);
    assert.equal(begun.value.listening, false);
    const state: string =
      new URL(begun.value.authorizationUrl).searchParams.get('state') ?? '';
    assert.equal(session.progress().inProgress, true);

    const wrong = await session.submitRedirect(
      `${REDIRECT}?code=abc&state=other`
    );
    assert.match(wrong.ok ? '' : wrong.error, /different login attempt/);

    const done = await session.submitRedirect(
      `${REDIRECT}?code=abc&state=${state}#_`
    );
    assert.ok(done.ok);
    assert.deepEqual(store.value, {
      accessToken: 'long-token',
      userId: '77',
      username: 'exampleshop',
      expiresAt: new Date(NOW.getTime() + 60 * DAY).toISOString(),
      tokenIssuedAt: NOW.toISOString(),
      savedAt: NOW.toISOString(),
    });
    assert.match(
      api.calls[0]?.body ?? '',
      /client_secret=threads-secret.*code=abc/
    );
    assert.equal(session.progress().inProgress, false);
    assert.notEqual(session.progress().lastConnectedAt, null);
    const again = await session.submitRedirect(
      `${REDIRECT}?code=abc&state=${state}`
    );
    assert.match(again.ok ? '' : again.error, /No Threads login is waiting/);
  });

  void it('refuses a paste once the login is too old', async () => {
    let now: Date = NOW;
    const session = new ThreadsLoginSession(
      config(),
      new ThreadsClient(config(), fakeThreads(LOGIN_ROUTES).fetch),
      new MemoryStore(),
      {
        listen: NO_LISTENER,
        readTls: async () => ok({ cert: '', key: '' }),
        now: () => now,
      }
    );
    const begun = await session.begin();
    assert.ok(begun.ok);
    const state: string =
      new URL(begun.value.authorizationUrl).searchParams.get('state') ?? '';
    now = new Date(NOW.getTime() + 16 * 60 * 1000);
    const late = await session.submitRedirect(
      `${REDIRECT}?code=abc&state=${state}`
    );
    assert.match(late.ok ? '' : late.error, /more than 15 minutes ago/);
  });

  void it('refreshes a token when due, never one under a day old, and stops at expiry', async () => {
    assert.equal(threadsTokenDueForRefresh(savedLogin(), NOW), false);
    const due = savedLogin({
      expiresAt: new Date(NOW.getTime() + 20 * DAY).toISOString(),
    });
    assert.equal(threadsTokenDueForRefresh(due, NOW), true);
    assert.equal(
      threadsTokenDueForRefresh(
        {
          ...due,
          tokenIssuedAt: new Date(NOW.getTime() - 3600_000).toISOString(),
        },
        NOW
      ),
      false
    );

    const api = fakeThreads({
      'GET /refresh_access_token': {
        json: { access_token: 'fresh', expires_in: 5184000 },
      },
    });
    const store = new MemoryStore(due);
    const refreshed = await refreshThreadsLoginIfDue(
      new ThreadsClient(config(), api.fetch, () => NOW),
      store,
      NOW
    );
    assert.equal(refreshed.ok && refreshed.value?.accessToken, 'fresh');
    assert.equal(store.value?.tokenIssuedAt, NOW.toISOString());
    assert.match(
      api.calls[0]?.url ?? '',
      /grant_type=th_refresh_token&access_token=long-token/
    );

    const expired = new MemoryStore(
      savedLogin({ expiresAt: new Date(NOW.getTime() - DAY).toISOString() })
    );
    const result = await refreshThreadsLoginIfDue(
      new ThreadsClient(config()),
      expired,
      NOW
    );
    assert.match(
      result.ok ? '' : result.error,
      /expired on .*connect Threads again/
    );
  });

  void it('reads a saved login and refuses a broken one', () => {
    assert.deepEqual(
      parseThreadsLogin(JSON.stringify(savedLogin())),
      ok(savedLogin())
    );
    const broken = parseThreadsLogin(JSON.stringify({ accessToken: 'x' }));
    assert.match(broken.ok ? '' : broken.error, /no userId/);
  });
});

void describe('ThreadsPublisher', () => {
  const request = {
    bytes: jpegOfSize(1080, 1350),
    mimeType: 'image/jpeg' as const,
    fileName: 't.jpg',
    caption: 'Ink pad holder https://www.etsy.com/listing/1 #Example Shop',
    expectedAccountId: '77',
  };

  void it('uploads, waits for the container, publishes, and deletes the temporary copy', async () => {
    const api = fakeThreads({
      'POST /v1.0/77/threads': { json: { id: 'c1' } },
      'GET /v1.0/c1': [
        { json: { status: 'IN_PROGRESS' } },
        { json: { status: 'FINISHED' } },
      ],
      'POST /v1.0/77/threads_publish': { json: { id: 'p1' } },
      'GET /v1.0/p1': {
        json: { permalink: 'https://www.threads.net/@exampleshop/post/abc' },
      },
    });
    const temp = new FakeTempStore();
    const publisher = new ThreadsPublisher(
      new ThreadsClient(config(), api.fetch),
      new MemoryStore(savedLogin()),
      temp,
      { pollIntervalMs: 5, sleep: async () => undefined, now: () => NOW }
    );
    const result = await publisher.publishImage(request);
    assert.deepEqual(
      result,
      ok({
        externalPostId: 'p1',
        permalink: 'https://www.threads.net/@exampleshop/post/abc',
        accountName: '@exampleshop',
      })
    );
    assert.deepEqual(temp.deletes, ['etsy-dashboard/social-temp/t.jpg']);
    const create = api.calls[0]?.body ?? '';
    assert.match(create, /media_type=IMAGE/);
    assert.match(create, /image_url=https%3A%2F%2Fbucket\.example%2Ft\.jpg/);
    assert.match(create, /text=Ink\+pad\+holder/);
  });

  void it('reports a failed container and still deletes the temporary copy', async () => {
    const api = fakeThreads({
      'POST /v1.0/77/threads': { json: { id: 'c1' } },
      'GET /v1.0/c1': {
        json: { status: 'ERROR', error_message: 'FAILED_DOWNLOADING_IMAGE' },
      },
    });
    const temp = new FakeTempStore();
    const publisher = new ThreadsPublisher(
      new ThreadsClient(config(), api.fetch),
      new MemoryStore(savedLogin()),
      temp,
      { sleep: async () => undefined, now: () => NOW }
    );
    const result = await publisher.publishImage(request);
    assert.match(
      result.ok ? '' : result.error,
      /container c1 is ERROR: FAILED_DOWNLOADING_IMAGE/
    );
    assert.equal(temp.deletes.length, 1);
    assert.equal(
      api.calls.some((call) => call.url.includes('threads_publish')),
      false
    );
  });

  void it('refuses another account or no login before uploading anything', async () => {
    const temp = new FakeTempStore();
    const client = new ThreadsClient(config(), fakeThreads({}).fetch);
    const other = await new ThreadsPublisher(
      client,
      new MemoryStore(savedLogin()),
      temp,
      {
        now: () => NOW,
      }
    ).publishImage({ ...request, expectedAccountId: '55' });
    assert.match(
      other.ok ? '' : other.error,
      /Threads account 55 was confirmed.*@exampleshop \(77\)/
    );
    const none = await new ThreadsPublisher(
      client,
      new MemoryStore(),
      temp
    ).publishImage(request);
    assert.match(none.ok ? '' : none.error, /connect Threads first/);
    assert.equal(temp.puts.length, 0);
  });
});

void describe('Threads image checks', () => {
  void it('takes images at least 320 px wide and no more lopsided than 10:1', () => {
    assert.equal(findThreadsImageProblem(1080, 1350), null);
    assert.match(findThreadsImageProblem(300, 300) ?? '', /at least 320/);
    assert.match(findThreadsImageProblem(4000, 300) ?? '', /10:1/);
  });
});
