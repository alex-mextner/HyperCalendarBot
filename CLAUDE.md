# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
- `Bun.redis` (singleton, default localhost) or `new Bun.RedisClient(url)` (custom URL) for Redis. Don't use `ioredis`. Note: `Bun.Redis` does not exist — use `Bun.RedisClient`.
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

## Commands

```sh
bun run src/index.ts                        # start the bot
bun test                                    # run all tests
bun test test/services/intent/intent-learner.test.ts  # run a single test file
bun test --coverage                         # coverage report
bun run lint                                # check linting
bun run lint:fix                            # auto-fix lint issues
bun run format                              # format with Biome
```

## Architecture

### Message Pipeline

Every user message flows through a layered pipeline (`src/bot/pipeline/`):

1. **FeedbackRouterLayer** — checks if the message is a reply inside an admin feedback thread; if so, routes it and stops.
2. **IntentMatcherLayer** — tries to match against pre-approved intents (regex/keyword patterns). On match, executes the intent workflow directly — no AI call. Handles suspended workflows (ask_user mid-workflow) via an in-memory `workflowSessions` map with 5-min TTL.
3. **AiAgentLayer** — falls through to `CalendarBotAgent` for everything else. After the agent completes, passes the interaction to `IntentLearner.analyze()` for potential intent extraction.

Each layer returns `{ handled: true }` to stop propagation, or `{ handled: false }` to continue.

### AI Agent (`src/services/ai/`)

- `agent.ts` — `CalendarBotAgent`: Anthropic SDK streaming, max 15 rounds, 90s timeout, 2 retries.
- `tools.ts` — 40+ tool definitions (the Claude API schema).
- `tool-executor.ts` — dispatches tool name → handler function.
- `tool-handlers/` — one file per domain: `events`, `reminders`, `sharing`, `secretary`, `proposals`, `slots`, `settings`, `meta`, `feedback`, `history`.
- `system-prompt.ts` — builds dynamic system prompt with user context (timezone, secretary access, group mode).
- `telegram-sender.ts` — abstracts all Telegram API calls; injected as `AgentContext.sender`.

### Intent Learning System (`src/services/intent/`)

After every AI interaction (no `ask_user` calls, no contextual pronouns), `IntentLearner.analyze()` calls a secondary Haiku model to generate a candidate intent. Candidates are sent to the admin (`BOT_ADMIN_ID`) as inline-keyboard messages (Accept / Edit / Reject). Approved intents are stored in the `intents` table and matched by `IntentMatcher` in future requests, bypassing the AI entirely.

### Workers (`src/worker/`)

For periodic/scheduled tasks always use BullMQ repeating jobs — never `setInterval` or `setTimeout`. Repeating jobs survive restarts and are observable in the queue.

BullMQ on Redis, three queues:
- **image-render** — Playwright renders weekly/monthly calendar images.
- **call-reminders** — schedules voice call reminders via the Python bridge.
- **bot-tasks** — periodic jobs: secretary expiry (daily), sharing cleanup (10min), proposal expiry (hourly).

### GramIO Scenes (`src/bot/scenes/`)

Multi-step wizards: `add-event`, `edit-value`, `import`, `timezone`, `onboarding`. Scene state is persisted in SQLite (not in-memory) so restarts don't break active flows.

### Database

`bun:sqlite` WAL mode. All access goes through repositories in `src/database/repositories/`. Schema defined as sequential migrations in `src/database/migrations.ts`. Key tables: `users`, `events`, `reminders`, `invitations`, `intents`, `chat_history`, `calendar_secretaries`, `calendar_proposals`, `contacts`, `event_participants`.

**When removing or repurposing DB columns**: never leave dead columns in the schema without a migration. Always ask whether to run a destructive migration (DROP COLUMN — data lost, safe when no real users yet) or a preserving migration (rename, backfill, keep for rollback). Then write the appropriate migration. No silent schema drift.

### MTProto Bridge

For users who haven't started the bot (can't receive bot API messages), delivery falls back to Pyrogram (`scripts/send-message.py`). Voice calls use `scripts/voice-call-bridge.py`. Both are spawned via `Bun.spawn(['venv/bin/python', ...])`.

## Logging

- Use **pino** for all logging. The `err` key triggers pino's error serializer (stack trace included).
- Always pass errors as `{ err: error }`, never `{ error: String(error) }` or `{ error: err.message }`.
- `String(error)` and `.message` lose the stack trace and are not acceptable.

## Linting

- **Biome** for linting and formatting. Config in `biome.jsonc`.
- `bun run lint` — check, `bun run lint:fix` — auto-fix, `bun run format` — format.
- Run `biome` directly (from `node_modules/.bin`), not via `bunx biome`.
- **Zero warnings policy**: lint warnings are NOT acceptable. Fix before committing.

## Russian Pluralization

Use `ruPlural(n, one, few, many)` from `src/services/event/formatters.ts` for all Russian word forms with numbers.

```ts
import { ruPlural } from '../../services/event/formatters.ts';

`${n} ${ruPlural(n, 'событие', 'события', 'событий')}`
// 1 → событие, 2-4 → события, 5+ → событий
// Teens (11-19) always → many. Works correctly for 21, 22, etc.
```

Never hardcode a single word form next to a variable number.

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

## ntgcalls — Deploy Setup

ntgcalls has a bug in v2.1.0: P2P calls connect but audio is silent.
Fix: `NativeNetworkInterface::UpdateAggregateStates_n()` never calls `OnNetworkAvailability(true)`.
Patch: `scripts/ntgcalls-fix-network-state.patch`.

**The compiled `.so` is NOT in git (venv/ is gitignored). Must rebuild on each server.**

On every new Linux server:

```bash
# 1. Create Python venv and install deps
python3.12 -m venv venv
venv/bin/pip install py-tgcalls pyrofork

# 2. Build patched ntgcalls from source (~5 min, needs ~5GB RAM, ~2GB disk)
./scripts/build-patched-ntgcalls.sh python3.12 venv

# 3. Authenticate Pyrogram session (one-time interactive)
venv/bin/python scripts/pyrogram-auth.py
```

- macOS arm64 `.dylib` ≠ Linux x86_64 `.so` — binaries are platform-specific, not portable
- `scripts/download-ntgcalls.sh` downloads the UNPATCHED binary — do NOT use it, audio will be silent
- Build deps: CMake 3.20+, git, Python 3.12, 5GB RAM min

## Backward Compatibility

When renaming variables, constants, config keys, or any other interface:
- **Ask immediately**: is backward compatibility needed, or can we migrate everything and remove the old names?
- **Default recommendation**: full migration — no aliases, no legacy shims. Aliases are technical debt.
- **Exceptions** worth keeping old names: public API with external consumers, stable library interface, or explicit user decision.
- If migration is feasible (internal code, DB rows can be updated, tests can be rewritten), propose full migration as the primary option. Final call is the programmer's.

## Debugging

- Read error messages carefully — they often contain the exact solution.
- Find similar working code in the same codebase. Compare working vs broken.
- State a single hypothesis, make the smallest possible change to test it.
- NEVER add multiple fixes at once. ALWAYS test after each change.

## Session Wrap-Up

When summarising completed work or suggesting next steps, always scan the conversation history and memory
for items that were explicitly deferred, noted as "pending", or silently dropped mid-discussion.
Surface them as concrete suggestions — not vague hints. If something was discussed but not implemented,
name it and ask whether to pick it up.

## Documentation

- Specs: `docs/specs/` — design documents and feature specifications
- Plans: `docs/plans/` — implementation plans with task breakdowns
- Original specs (sub-projects 00-08): `docs/specs/00-08`
- Do NOT use `docs/superpowers/` — all docs go directly in `docs/specs/` or `docs/plans/`
