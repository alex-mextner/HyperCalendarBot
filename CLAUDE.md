---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

## Linting

- **Biome** for linting and formatting. Config in `biome.jsonc`.
- `bun run lint` — check, `bun run lint:fix` — auto-fix, `bun run format` — format.
- Run `biome` directly (from `node_modules/.bin`), not via `bunx biome`.
- **Zero warnings policy**: lint warnings are NOT acceptable. Fix before committing.

## Coding Guidelines

- Principles: YAGNI, KISS, DRY, SOLID. Before creating type/component/util — check if similar exists.
- **Smallest reasonable changes**: make the minimum change to achieve the outcome.
  Don't refactor surroundings "while you're at it".
- **No `any`/`as any`/`Function`** — proper typing only. Avoid `Record<string, unknown>` as a lazy escape.
  `as unknown as ConcreteType` is acceptable only at framework boundaries (e.g. GramIO context casts).
- No commented-out code. No template literals without variables. `Number.parseInt`. `T[]` not `Array<T>`.
- Unused parameters: remove entirely (parameter + argument at call sites), don't prefix with `_`.
- **Always handle `.catch()`** on fire-and-forget promises — at minimum log the error. Silent promise
  rejections hide bugs and make debugging impossible.
- **Security checks fail-closed**: when a guard function is injected/optional, the absent-function default is `false` (deny), never `true` (allow).
- **Multi-step DB operations are atomic**: SELECT followed by UPDATE on the same rows must be wrapped in `db.transaction(...)`. Without it, concurrent writes can cause notifications to fire for rows that changed state between the two queries.
- **Never throw away implementations**: never rewrite working code without explicit permission.
- **Fix broken things immediately** when you find them.
- **Never add temporal context comments**: "improved", "better", "new", "refactored from".
  Comments must be evergreen — describe the code as it is now.
- **Never add instructional comments**: "copy this pattern", "use this instead", "prefer X over Y".
- **Naming**: describe WHAT the code does, not HOW. No implementation details in names
  (`Validator` not `ZodValidator`). No temporal names (`NewAPI`, `LegacyHandler`).

## Testing Guidelines

- **Always write tests**: new functionality must include unit tests; bug fixes must include
  regression tests that reproduce the bug before the fix.
- **TDD workflow** (mandatory for new features and bugfixes):
  1. Write a failing test that validates the desired behavior
  2. Run the test — confirm it fails for the RIGHT reason (not a syntax error or wrong import)
  3. Write ONLY enough code to make the test pass
  4. Run the test — confirm it passes
  5. Refactor while keeping tests green
- **Tests must exercise production code**: never reimplement logic in tests.
- **Never delete a failing test**. Investigate and fix the root cause.
- **Changing tests to match code is a red flag**: always analyze WHY.
- **Every commit must have tests**: no committing code without corresponding test coverage.
  New tool handlers, new utilities, new AI tools, bug fixes — all need tests in the same commit.
- **Regression tests for every bugfix**: reproduce the exact bug scenario in a test BEFORE fixing.
- **Maintain ~80% test coverage**: run `bun test --coverage` regularly. Currently at ~93% lines.
  New files must have corresponding test files. No shipping untested code.
- **Commit atomically and often**: after each logical unit of work (feature, bugfix, refactor), commit immediately.
  Don't accumulate 30+ changed files across multiple features.
- **Before every commit**: run `codex exec review --uncommitted` and address any issues found.
- **Always restart the bot** after code changes to src/. Kill by exact PID, verify 1 process running.

## MTProto / Pyrogram

All MTProto userbot functionality uses **one pyrogram session**: `data/voice_caller.session`.
Auth: `venv/bin/python scripts/pyrogram-auth.py` (one-time, interactive).

- **Voice calls**: `scripts/voice-call-bridge.py <user_id> <audio_file> [duration]` — spawned per call
- **Message delivery** (users who haven't started the bot): `scripts/send-message.py <user_id> <text> [username]` — spawned per message

Both scripts are called from TS via `Bun.spawn(['venv/bin/python', ...])`.
No `@mtcute/bun` — pyrogram handles everything.

## Debugging

- Read error messages carefully — they often contain the exact solution.
- Find similar working code in the same codebase. Compare working vs broken.
- State a single hypothesis, make the smallest possible change to test it.
- NEVER add multiple fixes at once. ALWAYS test after each change.

## Documentation

- Specs: `docs/specs/` — design documents and feature specifications
- Plans: `docs/plans/` — implementation plans with task breakdowns
- Original specs (sub-projects 00-08): `docs/specs/00-08`
- Do NOT use `docs/superpowers/` — all docs go directly in `docs/specs/` or `docs/plans/`
