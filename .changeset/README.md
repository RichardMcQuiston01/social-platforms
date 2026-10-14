# Changesets

Run `bun run changeset` on a feature branch to describe a user-facing change
and pick a semver bump. `bunx changeset version` (run on `dev` before merging
to `main`) consumes these files, bumps `package.json` and updates
`CHANGELOG.md`. Publishing happens from a `vX.Y.Z` tag on `main`; see
`CLAUDE.md`.
