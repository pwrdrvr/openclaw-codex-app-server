# configure-nodejs action

Sets up Node.js, restores a lockfile-keyed `node_modules` cache, and only runs `pnpm install --frozen-lockfile` on cache misses.

## Required workflow usage pattern

Use this action in a dedicated `install-deps` job first, then make all build/test jobs depend on that job with `needs: install-deps`.

Why:

- Cache key is based on `package.json` and `pnpm-lock.yaml`.
- When the dependency graph changes, parallel jobs can all miss cache, run full installs, and race to save the same key.
- The `install-deps` job should pass `lookup-only: "true"` so it only checks whether the cache key already exists.
- On a cache hit in `install-deps`, the action returns immediately without restoring `node_modules` and without setting up Node.js or pnpm.
- On a cache miss in `install-deps`, the action runs `pnpm install --frozen-lockfile` once and saves the cache; dependent jobs then restore `node_modules` and skip reinstalling.
- In dependent jobs, the action always sets up Node.js and pnpm first because those jobs need `pnpm` to run `typecheck`, `test`, and `pack:smoke` even when the cache restore succeeds.

## Example

```yaml
jobs:
  install-deps:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: ./.github/actions/configure-nodejs
        with:
          lookup-only: "true"

  typecheck:
    runs-on: ubuntu-latest
    needs: install-deps
    steps:
      - uses: actions/checkout@v6
      - uses: ./.github/actions/configure-nodejs
      - run: pnpm typecheck

  test:
    runs-on: ubuntu-latest
    needs: install-deps
    steps:
      - uses: actions/checkout@v6
      - uses: ./.github/actions/configure-nodejs
      - run: pnpm test
```
