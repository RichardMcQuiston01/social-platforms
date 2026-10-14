# CLAUDE.md

Project memory for Claude Code. Read this before changing anything.

## What this is

`@richardmcquiston01/social-platforms`: posting the owner's own images to
the owner's own social accounts (Facebook Pages, linked Instagram Business
accounts, Threads, Pinterest boards) behind one interface,
`SocialPublisherPort` (`src/port.ts`). Extracted from etsy-dashboard's
`src/social/`, where it was built and used first. Consumers: etsy-dashboard,
and later Maker Toolkit and other apps. `ROADMAP.md` has what comes next.

## Layout

```
src/
  index.ts        barrel: the shared, runtime-neutral core
  result.ts       Result<T>, ok, err, describeUnknownError
  port.ts         SocialPublisherPort, PublishImageRequest (+ PinDetails), PublishedPost
  http.ts         FetchLike, expiryFromSeconds, readBody
  encoding.ts     bytesToBase64, textToBase64, randomState, hmacSha256Hex (Web Crypto)
  oauth.ts        CallbackResult/Listener, ListenForCallback, LoginAttempt, LoginProgress,
                  LoginStore<T>, LoginSession (one login at a time), redirect checks,
                  parseRedirectAddress, checkAuthorizationUrl
  logger.ts       SocialLogger, silentLogger
  temp-image.ts   TempImageStore / StoredTempImage (Instagram and Threads fetch images by link)
  meta/           subpath ./meta: config, graph (MetaGraphClient, appsecret_proof), login,
                  token (MetaLogin), facebook-publisher, instagram-publisher
  threads/        subpath ./threads: config, graph (ThreadsClient), login
                  (ThreadsLoginSession: https listener or pasted redirect), token, publisher
  pinterest/      subpath ./pinterest: config (sandbox | production), api (PinterestClient),
                  login (+ PinterestRefresher, one refresh at a time), token, publisher
  s3.ts           subpath ./s3: S3TempImageStore over aws4fetch (SigV4, presigned GET)
  node.ts         subpath ./node: listenForCallback (node:http/https), readTlsFiles
test/             node:test + node:assert, run by bun test; fake fetch, no network
```

Adding a network: `src/<network>/` with config, client, login, token and
publisher files and an `index.ts`, then the entry in `tsup.config.ts`,
`package.json` `exports` and `typesVersions`, tests against a fake `fetch`,
and a changeset.

## Rules

- **Own accounts, one post per call.** Publishers post one image to the
  Page, account or board the caller confirmed (`expectedAccountId`) and
  refuse anything else. No scheduling, bulk posting, messaging, replying,
  commenting or tagging, ever. `FORBIDDEN_META_SCOPES` refuses messaging
  and comment permissions; Threads asks only for `threads_basic` and
  `threads_content_publish`; Pinterest only for `user_accounts:read` and
  boards/Pins read and write. Don't widen these.
- **No app policy here.** Caption rules (which links are allowed, buyer
  details) belong to the consumer; the package offers hooks instead (e.g.
  `PinterestPublisherOptions.checkLink`). No consumer-specific wording
  (Etsy, shop names, an app's settings screens) in code or messages.
- **Results, not throws.** Every public function returns `Result<T>`.
  Errors name the network, what was being done, the HTTP status and the
  network's message, plus the fix for common cases.
- **No credentials in code, logs or errors.** Secrets and logins come in
  through the caller (`LoginStore`, config inputs); never read
  `process.env` (ESLint blocks `process`). Logger messages never carry a
  token.
- **Runtime-neutral core.** `src/` except `node.ts` has no `node:*`
  imports, `Buffer`, `process` or `Bun` (ESLint enforces it): Web Crypto,
  `fetch`, `btoa`. `tsconfig.json` checks the neutral files without Node
  types; `tsconfig.node.json` adds `node.ts`.
- **Dual ESM and CommonJS** with `.d.ts`/`.d.cts` for every entry. Check
  `require()` and `import()` of every subpath before releasing.
- Node ≥ 20.3 (global `crypto`, `AbortSignal.any`).

## Commands (Bun only)

Never `npm`/`npx`/`tsx` locally; the release workflow's `npm publish` is
the one exception (provenance).

```bash
bun install
bun run typecheck
bun run lint
bun run format        # format:check in CI
bun run test
bun run build
bun run changeset
```

TypeScript stays on 5.x: tsup's declaration build needs the JavaScript
compiler API.

## Conventions

TypeScript strict, plus `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitReturns`, `noImplicitOverride`,
`verbatimModuleSyntax`, `useUnknownInCatchVariables`. Google TypeScript
Style Guide; descriptive camelCase; typed locals where they help.
Prettier (`.prettierrc.json`). `README.md` is in `.prettierignore` so its
fixed Author, Buy Me a Coffee, License and Copyright sections stay as
written.

## Git and releases

- `dev` is the integration branch. Branch features off `dev`
  (`feature/...`) and open PRs into `dev`, never `main`.
- Each user-facing change gets a changeset.
- Release: on `dev`, `bun run version-packages` (bumps `package.json`,
  writes `CHANGELOG.md`); merge `dev` → `main`; tag `main` with `vX.Y.Z`
  and push the tag. `.github/workflows/release.yml` checks the tag matches
  `package.json` and that the tagged commit is on `main`, then typechecks,
  lints, tests, builds and runs `npm publish --provenance --access public`
  with the `NPM_TOKEN` secret.
- `package.json` starts at 0.0.0; the initial `minor` changeset makes the
  first release 0.1.0.
- CI (`.github/workflows/ci.yml`): PRs and pushes to dev/main.

Never commit secrets or tokens.
