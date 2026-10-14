import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ok,
  type FetchLike,
  type Result,
  type StoredTempImage,
  type TempImageStore,
} from '../src/index.js';
import {
  findInstagramAspectProblem,
  InstagramPublisher,
  MetaGraphClient,
  readMetaConfig,
  selectedInstagramAccount,
  type MetaConfig,
  type MetaLogin,
  type MetaLoginStore,
  type MetaPage,
} from '../src/meta/index.js';
import {
  parseListObjects,
  readTempStoreConfig,
  S3TempImageStore,
  type TempStoreConfig,
  type TempStoreInput,
} from '../src/s3.js';

const NOW = new Date('2026-10-11T12:00:00.000Z');

const TEMP_INPUT: TempStoreInput = {
  endpoint: 'https://nyc3.digitaloceanspaces.com',
  bucket: 'mcq-space',
  accessKeyId: 'DO00ACCESSKEYTEST',
  secretAccessKey: 'secret-key-not-real',
  prefix: 'etsy-dashboard/social-temp/',
};

function tempConfig(): TempStoreConfig {
  const result = readTempStoreConfig(TEMP_INPUT);
  assert.ok(result.ok);
  return result.value;
}

function metaConfig(): MetaConfig {
  const result = readMetaConfig({
    appId: '123456',
    appSecret: 'shh',
    redirectUri: 'http://localhost:3004/oauth/meta/callback',
    scopes: 'pages_show_list',
  });
  assert.ok(result.ok);
  return result.value;
}

const PAGE: MetaPage = {
  id: '111',
  name: 'Example Shop',
  accessToken: 'page-token',
  tasks: ['CREATE_CONTENT'],
  instagramAccountId: '999',
  instagramUsername: 'exampleshop',
};

const ALL_SCOPES: readonly string[] = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'instagram_basic',
  'instagram_content_publish',
];

function login(overrides: Partial<MetaLogin> = {}): MetaLogin {
  return {
    userAccessToken: 'user-token',
    userTokenExpiresAt: null,
    grantedScopes: ALL_SCOPES,
    pages: [PAGE],
    unavailablePages: [],
    selectedPageId: '111',
    savedAt: NOW.toISOString(),
    ...overrides,
  };
}

class MemoryStore implements MetaLoginStore {
  constructor(public value: MetaLogin | null) {}
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

class FakeTempStore implements TempImageStore {
  readonly puts: Uint8Array[] = [];
  readonly deletes: string[] = [];
  async put(bytes: Uint8Array): Promise<Result<StoredTempImage>> {
    this.puts.push(bytes);
    return ok({
      key: 'etsy-dashboard/social-temp/a.jpg',
      url: 'https://bucket.example/a.jpg?sig=1',
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

/** Graph routes by "METHOD pathname"; a list answers in turn (for polling). */
function fakeGraph(routes: Record<string, unknown[] | unknown>): {
  fetch: FetchLike;
  calls: { method: string; path: string; body: string }[];
} {
  const calls: { method: string; path: string; body: string }[] = [];
  const queues = new Map<string, unknown[]>();
  for (const [key, value] of Object.entries(routes)) {
    queues.set(key, Array.isArray(value) ? [...value] : [value]);
  }
  return {
    calls,
    fetch: async (input, init) => {
      const url = new URL(input);
      const method: string = init?.method ?? 'GET';
      calls.push({
        method,
        path: url.pathname,
        body: String(init?.body ?? url.search),
      });
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

/** A JPEG with just enough segments to carry its size. */
function jpegOfSize(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0,
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
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

void describe('temporary image bucket', () => {
  void it('names what a half setup is missing', () => {
    const half = readTempStoreConfig({ ...TEMP_INPUT, secretAccessKey: '' });
    assert.match(half.ok ? '' : half.error, /missing its secretAccessKey/);
  });

  void it('needs an https origin, and reads DigitalOcean regions from the endpoint', () => {
    const http = readTempStoreConfig({
      ...TEMP_INPUT,
      endpoint: 'http://x.com',
    });
    assert.match(http.ok ? '' : http.error, /https origin/);
    const config = tempConfig();
    assert.equal(config.region, 'nyc3');
    assert.equal(config.endpoint, 'https://nyc3.digitaloceanspaces.com');
    const prefix = readTempStoreConfig({ ...TEMP_INPUT, prefix: '../etc' });
    assert.match(prefix.ok ? '' : prefix.error, /prefix "\.\.\/etc"/);
  });

  void it('uploads signed, hands out a 10-minute presigned link, and only deletes under the prefix', async () => {
    const requests: Request[] = [];
    const store = new S3TempImageStore(tempConfig(), async (request) => {
      requests.push(request);
      return new Response('', { status: 200 });
    });
    const stored = await store.put(new Uint8Array([1, 2, 3]), 'image/jpeg');
    assert.ok(stored.ok);
    const upload = requests[0];
    assert.ok(upload);
    assert.equal(upload.method, 'PUT');
    assert.match(
      upload.url,
      /^https:\/\/nyc3\.digitaloceanspaces\.com\/mcq-space\/etsy-dashboard\/social-temp\/[0-9a-f-]+\.jpg$/
    );
    assert.match(
      upload.headers.get('authorization') ?? '',
      /^AWS4-HMAC-SHA256 Credential=DO00ACCESSKEYTEST\/\d+\/nyc3\/s3\/aws4_request/
    );
    const link = new URL(stored.value.url);
    assert.equal(link.searchParams.get('X-Amz-Expires'), '600');
    assert.ok((link.searchParams.get('X-Amz-Signature') ?? '').length === 64);
    assert.doesNotMatch(stored.value.url, /secret-key-not-real/);

    const outside = await store.delete('other/thing.jpg');
    assert.match(outside.ok ? '' : outside.error, /Refusing to delete/);
    assert.deepEqual(await store.delete(stored.value.key), ok(undefined));
    assert.equal(requests.at(-1)?.method, 'DELETE');
  });

  void it('explains a refused upload', async () => {
    const store = new S3TempImageStore(
      tempConfig(),
      async () =>
        new Response(
          '<Error><Code>AccessDenied</Code><Message>nope</Message></Error>',
          {
            status: 403,
          }
        )
    );
    const stored = await store.put(new Uint8Array([1]), 'image/jpeg');
    assert.match(
      stored.ok ? '' : stored.error,
      /HTTP 403, AccessDenied: nope.*access key and secret key/
    );
  });

  void it('sweeps only old objects under the prefix', async () => {
    const xml = `<ListBucketResult>
      <Contents><Key>etsy-dashboard/social-temp/old.jpg</Key><LastModified>2026-10-11T10:00:00.000Z</LastModified></Contents>
      <Contents><Key>etsy-dashboard/social-temp/new.jpg</Key><LastModified>2026-10-11T11:50:00.000Z</LastModified></Contents>
    </ListBucketResult>`;
    assert.equal(parseListObjects(xml).length, 2);
    const deleted: string[] = [];
    const store = new S3TempImageStore(
      tempConfig(),
      async (request) => {
        if (request.method === 'DELETE')
          deleted.push(new URL(request.url).pathname);
        return new Response(request.method === 'GET' ? xml : '', {
          status: 200,
        });
      },
      () => NOW
    );
    assert.deepEqual(await store.sweep(60 * 60 * 1000), ok(1));
    assert.deepEqual(deleted, [
      '/mcq-space/etsy-dashboard/social-temp/old.jpg',
    ]);
  });
});

void describe('Instagram account', () => {
  void it('is the account linked to the chosen Page, or says what is missing', () => {
    assert.deepEqual(
      selectedInstagramAccount(login()),
      ok({ accountId: '999', username: 'exampleshop', page: PAGE })
    );
    const scopes = selectedInstagramAccount(
      login({ grantedScopes: ALL_SCOPES.slice(0, 3) })
    );
    assert.match(
      scopes.ok ? '' : scopes.error,
      /doesn't grant instagram_basic, instagram_content_publish/
    );
    const unlinked = selectedInstagramAccount(
      login({
        pages: [{ ...PAGE, instagramAccountId: null, instagramUsername: null }],
      })
    );
    assert.match(
      unlinked.ok ? '' : unlinked.error,
      /has no Instagram account linked/
    );
    const noPage = selectedInstagramAccount(login({ selectedPageId: null }));
    assert.match(noPage.ok ? '' : noPage.error, /No Facebook Page is chosen/);
  });

  void it('takes 4:5 to 1.91:1', () => {
    assert.equal(findInstagramAspectProblem(1080, 1350), null);
    assert.equal(findInstagramAspectProblem(1080, 1080), null);
    assert.equal(findInstagramAspectProblem(2048, 1536), null);
    assert.match(
      findInstagramAspectProblem(1080, 1600) ?? '',
      /taller than Instagram allows/
    );
    assert.match(
      findInstagramAspectProblem(2000, 1000) ?? '',
      /wider than Instagram allows/
    );
  });
});

void describe('InstagramPublisher', () => {
  const request = {
    bytes: jpegOfSize(1080, 1080),
    mimeType: 'image/jpeg' as const,
    fileName: 'a.jpg',
    caption: 'Ink pad holder',
    expectedAccountId: '999',
  };

  void it('uploads, waits for the container, publishes, and deletes the temporary copy', async () => {
    const graph = fakeGraph({
      'POST /v23.0/999/media': { json: { id: 'c1' } },
      'GET /v23.0/c1': [
        { json: { status_code: 'IN_PROGRESS' } },
        { json: { status_code: 'FINISHED' } },
      ],
      'POST /v23.0/999/media_publish': { json: { id: 'm1' } },
      'GET /v23.0/m1': {
        json: { permalink: 'https://www.instagram.com/p/abc/' },
      },
    });
    const temp = new FakeTempStore();
    const sleeps: number[] = [];
    const publisher = new InstagramPublisher(
      new MetaGraphClient(metaConfig(), graph.fetch),
      new MemoryStore(login()),
      temp,
      null,
      { pollIntervalMs: 5, sleep: async (ms) => void sleeps.push(ms) }
    );
    const result = await publisher.publishImage(request);
    assert.deepEqual(
      result,
      ok({
        externalPostId: 'm1',
        permalink: 'https://www.instagram.com/p/abc/',
        accountName: '@exampleshop',
      })
    );
    assert.equal(temp.puts.length, 1);
    assert.deepEqual(temp.deletes, ['etsy-dashboard/social-temp/a.jpg']);
    assert.deepEqual(sleeps, [5]);
    const create = graph.calls[0];
    assert.match(
      create?.body ?? '',
      /image_url=https%3A%2F%2Fbucket\.example%2Fa\.jpg/
    );
    assert.match(create?.body ?? '', /caption=Ink\+pad\+holder/);
    assert.match(create?.body ?? '', /appsecret_proof=[0-9a-f]{64}/);
  });

  void it('reports a failed container and still deletes the temporary copy', async () => {
    const graph = fakeGraph({
      'POST /v23.0/999/media': { json: { id: 'c1' } },
      'GET /v23.0/c1': {
        json: { status_code: 'ERROR', status: 'Error: unsupported image' },
      },
    });
    const temp = new FakeTempStore();
    const publisher = new InstagramPublisher(
      new MetaGraphClient(metaConfig(), graph.fetch),
      new MemoryStore(login()),
      temp,
      null,
      { sleep: async () => undefined }
    );
    const result = await publisher.publishImage(request);
    assert.match(
      result.ok ? '' : result.error,
      /container c1 is ERROR: Error: unsupported image/
    );
    assert.equal(temp.deletes.length, 1);
    assert.equal(
      graph.calls.some((call) => call.path.endsWith('/media_publish')),
      false
    );
  });

  void it('gives up after the timeout without publishing', async () => {
    const graph = fakeGraph({
      'POST /v23.0/999/media': { json: { id: 'c1' } },
      'GET /v23.0/c1': { json: { status_code: 'IN_PROGRESS' } },
    });
    const temp = new FakeTempStore();
    const publisher = new InstagramPublisher(
      new MetaGraphClient(metaConfig(), graph.fetch),
      new MemoryStore(login()),
      temp,
      null,
      { pollIntervalMs: 10, pollTimeoutMs: 30, sleep: async () => undefined }
    );
    const result = await publisher.publishImage(request);
    assert.match(
      result.ok ? '' : result.error,
      /hadn't finished fetching the image.*nothing was posted/
    );
    assert.equal(temp.deletes.length, 1);
  });

  void it('refuses another account, or a PNG, before uploading anything', async () => {
    const temp = new FakeTempStore();
    const publisher = new InstagramPublisher(
      new MetaGraphClient(metaConfig(), fakeGraph({}).fetch),
      new MemoryStore(login()),
      temp
    );
    const other = await publisher.publishImage({
      ...request,
      expectedAccountId: '555',
    });
    assert.match(
      other.ok ? '' : other.error,
      /Instagram account 555 was confirmed.*@exampleshop \(999\)/
    );
    const png = await publisher.publishImage({
      ...request,
      mimeType: 'image/png',
    });
    assert.match(png.ok ? '' : png.error, /only takes JPG/);
    assert.equal(temp.puts.length, 0);
  });
});
