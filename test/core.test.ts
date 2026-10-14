import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  bytesToBase64,
  checkAuthorizationUrl,
  checkHttpsRedirectUri,
  checkLoopbackRedirectUri,
  err,
  expiryFromSeconds,
  hmacSha256Hex,
  LoginSession,
  ok,
  parseRedirectAddress,
  parseScopeList,
  randomState,
  readBody,
  textToBase64,
  type LoginAttempt,
  type Result,
} from '../src/index.js';

const REDIRECT = 'https://localhost:3005/oauth/callback';

void describe('encoding', () => {
  void it('base64 without Buffer, for large inputs too', () => {
    const bytes = new Uint8Array(100_000).map((_, index) => index % 256);
    assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
    assert.equal(
      textToBase64('id:sécret'),
      Buffer.from('id:sécret').toString('base64')
    );
  });

  void it('makes url-safe random states', () => {
    const states = new Set(Array.from({ length: 50 }, () => randomState()));
    assert.equal(states.size, 50);
    for (const state of states) assert.match(state, /^[A-Za-z0-9_-]{22}$/);
  });

  void it('computes HMAC-SHA256 like Node does', async () => {
    assert.equal(
      await hmacSha256Hex('secret', 'token'),
      createHmac('sha256', 'secret').update('token').digest('hex')
    );
  });
});

void describe('http helpers', () => {
  void it('turns expires_in into a date, and ignores nonsense', () => {
    const now = new Date('2026-10-14T00:00:00Z');
    assert.equal(
      expiryFromSeconds(60, now)?.toISOString(),
      '2026-10-14T00:01:00.000Z'
    );
    assert.equal(expiryFromSeconds('60', now), null);
    assert.equal(expiryFromSeconds(-1, now), null);
  });

  void it('reads JSON, text or nothing', async () => {
    assert.deepEqual(await readBody(new Response('{"a":1}')), { a: 1 });
    assert.equal(await readBody(new Response('oops')), 'oops');
    assert.deepEqual(await readBody(new Response('')), {});
  });
});

void describe('redirect checks', () => {
  void it('loopback http redirects need a port and a path', () => {
    assert.deepEqual(
      checkLoopbackRedirectUri('http://localhost:3006/oauth/cb'),
      ok({ port: 3006, path: '/oauth/cb' })
    );
    assert.equal(
      checkLoopbackRedirectUri('https://localhost:3006/cb').ok,
      false
    );
    assert.equal(
      checkLoopbackRedirectUri('http://example.com:3006/cb').ok,
      false
    );
    assert.equal(checkLoopbackRedirectUri('http://localhost/cb').ok, false);
  });

  void it('https redirects say whether they point at this machine', () => {
    assert.deepEqual(
      checkHttpsRedirectUri(REDIRECT),
      ok({ loopback: true, port: 3005, path: '/oauth/callback' })
    );
    const remote = checkHttpsRedirectUri('https://shop.example.com/cb');
    assert.ok(remote.ok);
    assert.equal(remote.value.loopback, false);
    assert.equal(remote.value.port, 443);
    assert.equal(checkHttpsRedirectUri('http://localhost:3005/cb').ok, false);
  });

  void it('splits scope lists without duplicates', () => {
    assert.deepEqual(parseScopeList(' a, b  c,a '), ['a', 'b', 'c']);
  });

  void it('reads a pasted redirect address, and refuses others', () => {
    assert.deepEqual(
      parseRedirectAddress(
        `${REDIRECT}?code=abc&state=st#_`,
        REDIRECT,
        'Threads'
      ),
      ok({ code: 'abc', state: 'st' })
    );
    const cases: [string, RegExp][] = [
      ['hello', /isn't a web address/],
      [
        'https://elsewhere.example/oauth/callback?code=a&state=b',
        /doesn't start with/,
      ],
      [
        `${REDIRECT}?error=access_denied`,
        /Threads returned an OAuth error: access_denied/,
      ],
      [`${REDIRECT}?state=b`, /no code or state/],
    ];
    for (const [address, expected] of cases) {
      const result = parseRedirectAddress(address, REDIRECT, 'Threads');
      assert.match(result.ok ? '' : result.error, expected);
    }
  });

  void it('only hands out https consent pages on the expected hosts', () => {
    const hosts = ['www.pinterest.com'];
    assert.ok(
      checkAuthorizationUrl(
        'https://www.pinterest.com/oauth/',
        hosts,
        'Pinterest'
      ).ok
    );
    assert.equal(
      checkAuthorizationUrl(
        'http://www.pinterest.com/oauth/',
        hosts,
        'Pinterest'
      ).ok,
      false
    );
    assert.equal(
      checkAuthorizationUrl('https://evil.example/', hosts, 'Pinterest').ok,
      false
    );
  });
});

void describe('LoginSession', () => {
  void it('runs one login at a time and records how it ended', async () => {
    let finish: (result: Result<void>) => void = () => undefined;
    let starts = 0;
    const session = new LoginSession(
      async (): Promise<Result<LoginAttempt>> => {
        starts += 1;
        return ok({
          authorizationUrl: `https://example.com/consent/${starts}`,
          completion: new Promise((resolve) => {
            finish = resolve;
          }),
        });
      },
      'Example'
    );
    const first = await session.begin();
    const second = await session.begin();
    assert.deepEqual(first, second);
    assert.equal(starts, 1);
    assert.equal(session.progress().inProgress, true);

    finish(err('The user said no.'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(session.progress().inProgress, false);
    assert.equal(session.progress().lastError, 'The user said no.');

    await session.begin();
    assert.equal(starts, 2);
    assert.equal(session.progress().lastError, null);
    finish(ok(undefined));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.notEqual(session.progress().lastConnectedAt, null);
  });

  void it('reports a start that fails', async () => {
    const session = new LoginSession(
      async () => err('Port 3006 is busy.'),
      'Example'
    );
    assert.deepEqual(await session.begin(), err('Port 3006 is busy.'));
    assert.equal(session.progress().lastError, 'Port 3006 is busy.');
  });
});
