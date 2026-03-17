# Repository Guidelines

## Project Structure & Module Organization
`index.ts` is the plugin entrypoint and registers commands, services, and interactive handlers. Core implementation lives in [`src/`](./src): controller flow in `controller.ts`, API/client integration in `client.ts`, configuration in `config.ts`, state and thread helpers in `state.ts`, `thread-picker.ts`, and `thread-selection.ts`, and user-facing text formatting in `format.ts`. Tests are colocated with source files as `src/*.test.ts`. Plugin metadata lives in `openclaw.plugin.json`; package and TypeScript settings are in `package.json` and `tsconfig.json`.

Design notes and upstream behavior captures live under [`docs/specs/`](./docs/specs). Before changing approval, trust, sandbox, file-edit, or media-handling behavior, review [`docs/specs/PERMISSIONS.md`](./docs/specs/PERMISSIONS.md) and [`docs/specs/MEDIA.md`](./docs/specs/MEDIA.md).

## Build, Test, and Development Commands
Use `pnpm` for local work.

- `pnpm test`: run the Vitest suite once.
- `pnpm typecheck`: run strict TypeScript checking with `tsc --noEmit`.
- `pnpm openclaw plugins install --link /path/to/openclaw-codex-app-server`: link this package into a local OpenClaw checkout for manual integration testing.

There is no separate build step in this repository; correctness is gated by tests and typechecking.

## Coding Style & Naming Conventions
Write TypeScript targeting Node ESM (`"module": "NodeNext"`). Match the existing style: 2-space indentation, double quotes, semicolons, and small focused helpers. Use `PascalCase` for classes and types, `camelCase` for functions and variables, and `SCREAMING_SNAKE_CASE` for shared constants such as command lists or namespace identifiers. Keep command and plugin-facing strings explicit and near the registration code when possible.

## Testing Guidelines
Tests use Vitest and should stay next to the code they cover, named `*.test.ts`. Prefer narrow unit tests over broad fixtures; most existing tests assert exact payloads and formatting behavior. Run `pnpm test` and `pnpm typecheck` before opening a PR. Add or update tests for any command handling, thread-selection logic, formatting branch, or protocol-shape change.

## Commit & Pull Request Guidelines
Follow the repository’s existing commit style: short imperative subjects, often with a `Plugin:` prefix, for example `Plugin: restore Codex interactive workflows`. Keep commits scoped to one behavior change. PRs should include a concise summary, linked issue or context, and the exact validation performed (`pnpm test`, `pnpm typecheck`, manual OpenClaw plugin exercise). Include screenshots or message transcripts when changing interactive Telegram or Discord flows.
