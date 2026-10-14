import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { escapeHtml, listenForCallback } from '../src/node.js';

/** A port unlikely to be busy on a dev machine or CI runner. */
function randomPort(): number {
  return 40_000 + Math.floor(Math.random() * 20_000);
}

void describe('listenForCallback', () => {
  void it("hands back the code from the provider's redirect, on its own path only", async () => {
    const port: number = randomPort();
    const listening = await listenForCallback({
      port,
      pathPrefix: '/oauth/meta/callback',
      providerName: 'Facebook',
      expectedState: 'st',
    });
    assert.ok(listening.ok);
    const other = await fetch(`http://127.0.0.1:${port}/elsewhere`);
    assert.equal(other.status, 404);
    const page = await fetch(
      `http://127.0.0.1:${port}/oauth/meta/callback?code=abc&state=st`
    );
    assert.match(await page.text(), /Connected to Facebook/);
    assert.deepEqual(await listening.value.callback, {
      ok: true,
      value: { code: 'abc', state: 'st' },
    });
  });

  void it("reports the provider's error and description", async () => {
    const port: number = randomPort();
    const listening = await listenForCallback({
      port,
      pathPrefix: '/cb',
      providerName: 'Facebook',
      expectedState: 'st',
    });
    assert.ok(listening.ok);
    await fetch(
      `http://127.0.0.1:${port}/cb?error=access_denied&error_description=Permissions+error`
    );
    const result = await listening.value.callback;
    assert.ok(!result.ok);
    assert.equal(
      result.error,
      'Facebook returned an OAuth error: access_denied (Permissions error).'
    );
  });

  void it('refuses a redirect from another login attempt', async () => {
    const port: number = randomPort();
    const listening = await listenForCallback({
      port,
      pathPrefix: '/cb',
      providerName: 'Etsy',
      expectedState: 'mine',
    });
    assert.ok(listening.ok);
    await fetch(`http://127.0.0.1:${port}/cb?code=abc&state=theirs`);
    const result = await listening.value.callback;
    assert.ok(!result.ok);
    assert.match(result.error, /state mismatch/);
  });
});

void describe('escapeHtml', () => {
  void it('escapes what an OAuth error could carry into the page', () => {
    assert.equal(
      escapeHtml('<script>"x"&\'y\'</script>'),
      '&#60;script&#62;&#34;x&#34;&#38;&#39;y&#39;&#60;/script&#62;'
    );
  });
});
