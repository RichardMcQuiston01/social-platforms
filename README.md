# @richardmcquiston01/social-platforms

- Author: [Richard McQuiston](mailto:richard.mcquiston@gmail.com)
- Website: https://richardmcquiston.com/

## Table of Contents

| [Overview](#overview) | [Getting Started](#getting-started) | [Buy Me a Coffee](#buy-me-a-coffee) | [License](#license) | [Copyright](#copyright) |

## Overview

Framework agnostic TypeScript based package for interacting with various social networking sites.  Sites include Facebook, Instagram, Threads, Pinterest, and more.

It posts **your own** images to **your own** accounts, one call per post:

- **Facebook Pages** and their linked **Instagram** Business accounts, through one Meta login (`./meta`).
- **Threads** (`./threads`), with its own login on threads.net.
- **Pinterest** boards (`./pinterest`), in Pinterest's sandbox while your app has Trial access, or production once it has Standard.

Each network has a thin API client, an OAuth login (code exchange, long-lived tokens, refresh), and a publisher behind one interface, `SocialPublisherPort`, so an app can post the same image anywhere.

Design:

- **Results, not exceptions.** Every call returns `{ ok: true, value } | { ok: false, error }`, and errors are specific: they name the network, what was being done, the HTTP status, the network's own message and, for the common cases, the fix.
- **Your storage, your keys.** Logins are saved through a `LoginStore` you provide (a file, a database row; encrypt it). Nothing reads `process.env`, and nothing logs a token.
- **The right place, only.** Publishers refuse to post unless the Page, account or board you confirmed is still the chosen one. Meta logins refuse messaging and comment permissions: this package never messages, replies or tags anyone.
- **Runtime-neutral.** The main entry and the network subpaths run in Node 20.3+, Bun and browsers (Web Crypto, `fetch`), and ship as ESM and CommonJS with types. The only Node-specific code, the local listener that catches an OAuth redirect, is in `./node`.

| Subpath | What's in it |
| --- | --- |
| `.` | `Result`, `SocialPublisherPort`, `LoginSession`, `LoginStore`, redirect checks, `SocialLogger`, `TempImageStore` |
| `./meta` | `readMetaConfig`, `MetaGraphClient`, `startMetaLogin`, `FacebookPagePublisher`, `InstagramPublisher` |
| `./threads` | `readThreadsConfig`, `ThreadsClient`, `ThreadsLoginSession`, `ThreadsPublisher` |
| `./pinterest` | `readPinterestConfig`, `PinterestClient`, `startPinterestLogin`, `PinterestRefresher`, `PinterestPublisher` |
| `./s3` | `S3TempImageStore`: Instagram and Threads fetch images from a link, so the image goes briefly to your private S3-compatible bucket |
| `./node` | `listenForCallback` (the OAuth redirect listener), `readTlsFiles` |

[Back to Top](#table-of-contents)

## Getting Started

### Prerequisites

- Node 20.3+ or Bun 1.3+ (or a browser for everything except `./node`).
- A developer app for each network you use, with your redirect URI registered:
  - **Meta** (Facebook and Instagram): the "Manage everything on your Page" use case, plus Instagram's, e.g. redirect `http://localhost:3004/oauth/meta/callback`.
  - **Threads**: the Meta app's Threads use case. Threads only redirects to https, e.g. `https://localhost:3005/oauth/threads/callback`.
  - **Pinterest**: an app at developers.pinterest.com, e.g. redirect `http://localhost:3006/oauth/pinterest/callback`. Use a Business account.
- For Instagram and Threads: an S3-compatible bucket (DigitalOcean Spaces, AWS S3...) for the temporary image link.

### Installation

```bash
bun add @richardmcquiston01/social-platforms
# or: npm install @richardmcquiston01/social-platforms
```

### Usage

Connect once, then post. Here with Pinterest; Meta and Threads follow the same shape.

```ts
import { LoginSession, type LoginStore } from '@richardmcquiston01/social-platforms';
import { listenForCallback } from '@richardmcquiston01/social-platforms/node';
import {
  PinterestClient,
  PinterestPublisher,
  PinterestRefresher,
  readPinterestConfig,
  startPinterestLogin,
  type PinterestLogin,
} from '@richardmcquiston01/social-platforms/pinterest';

const config = readPinterestConfig({
  appId: '1234567',
  appSecret: mySecret, // from your own secret storage
  redirectUri: 'http://localhost:3006/oauth/pinterest/callback',
  environment: 'sandbox', // 'production' once Pinterest grants Standard access
});
if (!config.ok) throw new Error(config.error);

const store: LoginStore<PinterestLogin> = myEncryptedStore; // load / save / clear
const client = new PinterestClient(config.value);

// 1. Connect: open the consent page; the listener catches the redirect.
const login = new LoginSession(
  () => startPinterestLogin(config.value, client, store, { listen: listenForCallback }),
  'Pinterest'
);
const started = await login.begin();
if (started.ok) openInBrowser(started.value.authorizationUrl);

// 2. Post: one image to the board the owner chose.
const publisher = new PinterestPublisher(client, new PinterestRefresher(client, store), {
  // Optional: only allow your own links.
  checkLink: (link) =>
    link.startsWith('https://www.example.com/') ? null : 'Pins link to example.com only.',
});
const pinned = await publisher.publishImage({
  bytes: jpegBytes,
  mimeType: 'image/jpeg',
  fileName: 'pin.jpg',
  caption: 'Hand-made, laser-cut and ready to ship.',
  expectedAccountId: boardId, // the board the owner confirmed
  pin: { title: 'Business card jig', link: 'https://www.example.com/p/1', altText: 'A wooden jig' },
});
if (!pinned.ok) console.error(pinned.error);
else console.log(pinned.value.permalink);
```

### Examples

**Facebook Page and Instagram**

```ts
import {
  FacebookPagePublisher,
  InstagramPublisher,
  MetaGraphClient,
  readMetaConfig,
  startMetaLogin,
} from '@richardmcquiston01/social-platforms/meta';
import { readTempStoreConfig, S3TempImageStore } from '@richardmcquiston01/social-platforms/s3';

const meta = readMetaConfig({ appId, appSecret, redirectUri: 'http://localhost:3004/oauth/meta/callback' });
if (!meta.ok) throw new Error(meta.error);
const graph = new MetaGraphClient(meta.value);
const facebook = new FacebookPagePublisher(graph, metaStore, meta.value.preferredPageId);

const bucket = readTempStoreConfig({ endpoint, bucket: 'my-space', accessKeyId, secretAccessKey, prefix: 'social-temp/' });
if (!bucket.ok) throw new Error(bucket.error);
const instagram = new InstagramPublisher(graph, metaStore, new S3TempImageStore(bucket.value), meta.value.preferredPageId);
```

**Threads, pasting the redirect address** (no local certificate)

```ts
import { ThreadsClient, ThreadsLoginSession, readThreadsConfig } from '@richardmcquiston01/social-platforms/threads';
import { listenForCallback, readTlsFiles } from '@richardmcquiston01/social-platforms/node';

const threads = readThreadsConfig({ appId, appSecret, redirectUri: 'https://localhost:3005/oauth/threads/callback' });
if (!threads.ok) throw new Error(threads.error);
const session = new ThreadsLoginSession(threads.value, new ThreadsClient(threads.value), threadsStore, {
  listen: listenForCallback,
  readTls: () => readTlsFiles('localhost.pem', 'localhost-key.pem'),
});
const started = await session.begin(); // open started.value.authorizationUrl
// ...then pass the address the browser ended on:
await session.submitRedirect(pastedAddress);
```

**Logging**

Pass a `SocialLogger` (`{ info, warn, error }`) to logins and publishers to hear about refreshed tokens or a post whose link couldn't be read. It's silent by default, and messages never contain a token.

[Back to Top](#table-of-contents)

## Buy Me a Coffee

If this app, code, or repository has helped you or someone you know, please consider donating. I appreciate any help to offset the costs of development and/or AI Credits.

[**Donate via Stripe**](https://donate.stripe.com/00w5kD3Gj1Xo9v7gVOcs800), or scan:

[![Donate via Stripe](./donate.svg)](https://donate.stripe.com/00w5kD3Gj1Xo9v7gVOcs800)

[Back to Top](#table-of-contents)

## License

Apache 2

[Back to Top](#table-of-contents)

## Copyright

(c)2026 Richard McQuiston. All rights reserved.

[Back to Top](#table-of-contents)
