# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Shell Commands

Never use absolute paths for common tools — they are on the shell PATH:
- `git` not `/usr/bin/git`
- `biome` not `node_modules/.bin/biome` (use `node_modules/.bin/biome` only as fallback if `biome` is not globally installed)
- `tsc` not `node_modules/.bin/tsc`
- `bun` not `/Users/ultra/.bun/bin/bun`

## Bun

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
- **Anthropic client**: never use `new Anthropic()` directly — it ignores `AI_BASE_URL` and will fail when a proxy is configured. Always use `createAnthropicClient()` from `src/services/ai/anthropic-client.ts`. Pass `{ apiKey, baseURL }` to override env defaults, or call without args to use `process.env.ANTHROPIC_API_KEY` / `process.env.AI_BASE_URL`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` (singleton, default localhost) or `new Bun.RedisClient(url)` (custom URL) for Redis. Don't use `ioredis`. Note: `Bun.Redis` does not exist — use `Bun.RedisClient`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

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

### Feature Usage Tracking (`src/services/feature-tracking.ts`)

When adding a new command, callback, scene, AI tool, or abstract user action — update the corresponding
feature tracking map so tip filtering and re-engagement work correctly:

- `COMMAND_FEATURE_MAP` — `/command` → `FeatureKey` (21 entries)
- `CALLBACK_FEATURE_MAP` — callback prefix → `FeatureKey` (17 entries)
- `SCENE_FEATURE_MAP` — scene name → `FeatureKey` (4 entries)
- `ACTION_FEATURE_MAP` — abstract action → `FeatureKey` (3 entries: `voice_message`, `ics_file`, `geolocation`)
- `TOOL_FEATURE_MAP` in `src/services/ai/tool-executor.ts` — AI tool name → `FeatureKey` (43 entries)
- `BOT_TIP_FEATURE_MAP` in `src/services/notification/tip-tags.ts` — tip key → `FeatureKey` (54 entries, keys must match `botTips` keys in constants.ts)

If you add a new `FeatureKey`, add it to `FEATURE_KEYS` in `src/database/repositories/feature-usage.repository.ts`.

### Workers (`src/worker/`)

For periodic/scheduled tasks always use BullMQ repeating jobs — never `setInterval` or `setTimeout`. Repeating jobs survive restarts and are observable in the queue.

BullMQ on Redis, three queues:
- **image-render** — Playwright renders weekly/monthly calendar images.
- **call-reminders** — schedules voice call reminders via the Python bridge.
- **bot-tasks** — periodic jobs: secretary expiry (daily), sharing cleanup (10min), proposal expiry (hourly).

### GramIO Scenes (`src/bot/scenes/`)

Multi-step wizards: `add-event`, `edit-value`, `import`, `timezone`, `onboarding`. Scene state is persisted in SQLite (not in-memory) so restarts don't break active flows.

**Scene context typing** uses `Composer.derive()` + `scene.extend(composer)` to propagate
`dbUser`, `lang`, `userTimezone` into step handler context without casts. Key details:

- `Plugin.derive()` widens return type to `Record<string, unknown>` (Hooks.Derive constraint).
  `Composer.derive()` uses `DeriveHandler<T, D>` with proper generic inference — use Composer.
- **`extend()` MUST come AFTER `params()` and `state()`**. `params()` uses `Modify<Derives>`
  which replaces `Derives.global`; `state()` uses `Derives &` (intersection, preserves).
  If `extend()` is before `params()`, the derived props disappear from the type.
  ```ts
  // Correct order:
  new Scene('name').params<P>().state<S>().extend(userComposer).step(...)
  // Wrong — params() replaces global, losing extend:
  new Scene('name').extend(userComposer).params<P>().step(...)
  ```
- Scene shared types (`AddEventState`, `OnboardingState`, `TimezoneState`, `SceneKvStorage`)
  live in `src/bot/scenes/types.ts`.

### Database

`bun:sqlite` WAL mode. All access goes through repositories in `src/database/repositories/`. Schema defined as sequential migrations in `src/database/migrations.ts`. Key tables: `users`, `events`, `reminders`, `invitations`, `intents`, `chat_history`, `calendar_secretaries`, `calendar_proposals`, `contacts`, `event_participants`.

**When removing or repurposing DB columns**: never leave dead columns in the schema without a migration. Always ask whether to run a destructive migration (DROP COLUMN — data lost, safe when no real users yet) or a preserving migration (rename, backfill, keep for rollback). Then write the appropriate migration. No silent schema drift.

**No unbounded queries in hot paths** (scheduler tick, webhook handler, middleware):
- Never `SELECT * FROM table` — select only the columns you need. `SELECT *` fetches tokens, blobs,
  and other heavy columns the caller ignores. Use `Pick<Entity, 'col1' | 'col2'>` as the return type.
- Never load an entire table into memory in one query. Use cursor-based batching
  (`WHERE id > ? ORDER BY id LIMIT ?`) via a generator that yields batches. This keeps peak memory
  bounded regardless of table size.
- `findAll()` is acceptable only in admin/debug endpoints and tests, never in per-tick loops.

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
Never inline pluralization logic (`if (n === 1) … if (n >= 2 && n <= 4) …`) — always use `ruPlural`.

## Environment Variables

All `process.env.*` reads go through `src/config/env.ts` → `loadConfig()` and are accessed via the `config` object. Never read `process.env.*` directly in feature code, bot handlers, services, or commands.

**Exceptions** (infrastructure layer where config object is not injected):
- `src/utils/logger.ts` — reads `NODE_ENV` at module load time, before config is available
- `src/services/ai/anthropic-client.ts` — reads `ANTHROPIC_API_KEY`/`AI_BASE_URL` as fallbacks, by design

When adding a new env var: (1) add it to `EnvConfig` interface in `env.ts`, (2) read and validate in `loadConfig()`, (3) use via `config.VAR_NAME` everywhere else.

Optional features that depend on an env var must deactivate gracefully when the var is absent — never throw at startup. Validate at the point of use, not at startup.

## Coding Guidelines

- **Dependency versions always use `^`** (e.g. `"marked": "^15.0.12"`). Never pin exact versions — it makes routine upgrades a chore and diverges from ecosystem norms. Range `^` is mandatory; `~` and bare exact versions are not acceptable.
  **Exception**: `electron` in `packages/agent-macos/` must be pinned to an exact version (e.g. `"34.5.8"`). `electron-builder` rejects range versions (`^`) at build time and fails CI.
- Principles: YAGNI, KISS, DRY, SOLID. Before creating type/component/util — check if similar exists.
- **Smallest reasonable changes**: make the minimum change to achieve the outcome.
  Don't refactor surroundings "while you're at it".
- **No `.ts` extensions in imports inside `packages/agent-macos/`** — that package compiles with tsc, which rejects `.ts` import extensions. Bun (main `src/`) supports them; tsc does not.
- **No `any`/`as any`/`Function`** — proper typing only.
- **No bare `object` type** — use `{ [key: string]: unknown }` or a specific interface. `object`
  accepts any non-primitive but gives no information about shape — nearly as bad as `any`.
- **No `Record<string, unknown>`** — this utility type alias is entirely banned:
  - Known shape at compile time → specific interface or Zod-inferred type
  - Parse boundary (DB JSON, external API) → `unknown`, then validate before use
  - Truly dynamic runtime accumulator → explicit index signature `{ [key: string]: unknown }`
  - Opaque external data → `unknown`
- **No `as SomeType` casts** — fix the types, don't paper over them. If a library produces a poor type,
  fix the code that feeds it (e.g. return consistent shapes from derive functions) rather than casting.
  The only acceptable cast is `as Parameters<typeof apiMethod>[0]` at the GramIO bot API call site
  where the runtime accepts objects the static type rejects (InlineKeyboard vs raw TelegramMarkup).
- **No `as unknown as ConcreteType`** — absolute ban, no exceptions. This double cast bypasses all
  TypeScript checks. If you think you need it, the types are wrong — fix them. GramIO `.derive()`
  types flow through `.on()` handlers; `Bun.serve()` accepts split branches without casts.
- **No `as never`** — this cast silences any type error by pretending a value is the bottom type.
  It's worse than `as any` because it hides the mismatch completely. Fix the actual type instead.
- **Test-only cast exceptions** — the three rules above apply to production code (`src/`). In test
  files (`test/`), partial mocks that implement a subset of an interface are allowed to use
  `as unknown as RealType` under these conditions:
  1. The cast is inside a **centralized factory function** (`makeCtx`, `makeDeps`, `mockWs`),
     never inline at the test call site
  2. The factory parameter is typed as `Partial<RealInterface>`, not `Record<string, unknown>`
  3. `as never` remains banned everywhere — use `as unknown as X` in test factories
  4. `mock.calls` tuple access may use a single cast: `mock.calls[0] as unknown as [string, number]`
     (bun:test types `calls` as `unknown[][]` — no way around it)
- **`JSON.parse` and `Response.json()` must always go through Zod** — never use the raw return
  value, never cast with `as`. Always `z.schema().parse(JSON.parse(...))` or
  `z.schema().parse(await res.json())`. No `(await res.json()) as SomeType` — define a Zod schema
  and `.parse()` it. For DB-stored JSON columns with simple types (`number[]`, `string[]`), use the
  matching Zod array schema. For complex DB types, validate the structural shape with Zod.
- **`z.unknown()` is banned** — always use a concrete schema. If data is polymorphic, define a union
  of known shapes. `z.unknown()` provides zero runtime validation and is equivalent to no schema.
  No exceptions — workflow DSL inputs use `z.string()`, tool outputs use typed unions.
- **`ToolResult.data` is typed** — never return `unknown` from tool handlers. Use `ToolResultData`
  union type from `src/services/ai/types.ts`. Add new variants when adding tools that return
  structured data.
- **Tool output schemas must be concrete** — `parseToolOutput` in intent-executor validates JSON
  against known shapes (event lists, free slots, settings maps, etc.). When adding a new response
  format, add its schema to `ToolOutputSchema`.
- **Never parse structured data from text output** — tool handlers that create or modify entities
  (events, contacts, proposals) MUST return the entity ID in `ToolResult.data`, not only embed
  it in the `output` string. Consumers (action log, intent executor, event mention tracker) read
  `result.data.id` — never regex-parse `output`. If you need an ID downstream, make the handler
  return it in `data`.
- **Type co-location**: interfaces and type aliases must live in the same file as the code that owns
  them. Do not create a single global `types.ts` dumping ground. One exception: types shared across
  multiple layers without a clear owner may live in a small domain-level `types.ts`
  (e.g. `src/services/ai/types.ts`). Avoid circular deps — a type that is imported by many files
  should not itself import from those files.
- **No `export type { Foo }` re-exports from repository/service files** — consumers must import
  types directly from their canonical source (`database/types.ts`, domain `types.ts`). A re-export
  creates two valid import paths for the same type, making the canonical location ambiguous and
  imports harder to audit.
- No commented-out code. No template literals without variables. `Number.parseInt`. `T[]` not `Array<T>`.
- Unused parameters: remove entirely (parameter + argument at call sites), don't prefix with `_`.
- **No silent fallbacks for missing required values** — `ctx.message?.id ?? 0` and similar patterns
  hide bugs: downstream code receives a meaningless sentinel and fails in an unrelated place with a
  confusing error. When a value is required, guard and return early:
  ```ts
  // Bad — messageId: 0 causes editMessageText to fail later with a cryptic API error
  const messageId = ctx.message?.id ?? 0;
  // Good — fail immediately, log the context
  if (!ctx.message) {
    logger.warn({ chatId: ctx.chatId }, 'callback has no message');
    return;
  }
  const messageId = ctx.message.id;
  ```
- **No silent optional-dependency guards** — `if (ctx.something) { doWork() }` that silently skips
  when the dependency is missing is a bug factory. When a tool handler or service depends on an
  injected capability (`sendMessageToChat`, `sender`, etc.):
  1. If the feature CANNOT work without it → return `{ success: false, error: '...' }` with a clear message
  2. If the feature CAN partially work → log a warning (`logger.warn`) and include an `agentHint` in
     the result so the AI knows something is degraded
  3. NEVER silently skip and return success — the caller (AI agent, admin, user) must know the action
     was not fully performed
  The same applies to `deps.*` in handlers: if a dep is required for a code path, log when absent.
- **Always handle `.catch()`** on fire-and-forget promises — at minimum log the error. Silent promise
  rejections hide bugs and make debugging impossible.
- **No silent `catch` blocks** — every `catch` must either log the error or have a comment explaining
  WHY swallowing is safe. Acceptable patterns: JSON.parse with fallback (invalid input expected),
  WebSocket keepalive (non-JSON packets expected), cleanup on shutdown (resource already gone).
  Unacceptable: `catch { return; }` or `catch { return null; }` without logging or explanation.
  When in doubt, `logger.warn({ err }, 'context')` — a warn is cheap, a hidden bug is not.
- **Security checks fail-closed**: when a guard function is injected/optional, the absent-function default is `false` (deny), never `true` (allow).
- **Multi-step DB operations are atomic**: SELECT followed by UPDATE on the same rows must be wrapped in `db.transaction(...)`. Without it, concurrent writes can cause notifications to fire for rows that changed state between the two queries.
- **Never throw away implementations**: never rewrite working code without explicit permission.
- **Fix broken things immediately** when you find them.
- **Comments hygiene**: when refactoring, verify no useful comments were accidentally deleted.
  Check: `git diff | grep "^-.*\/\/"`. Never silently drop comments.
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
- **No hardcoded future dates in tests** — absolute ISO timestamps become past dates and break
  validation that guards against past input (e.g. `run_at must be in the future`). Always use
  relative expressions: `new Date(Date.now() + 60 * 60 * 1000).toISOString()` or
  `new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()`. This applies to any value
  validated against `Date.now()` at runtime: scheduled calls, reminders, event start times.
- **Tests must exercise production code**: never reimplement logic in tests.
  Import helpers/utilities from `src/` — don't copy-paste them into test files.
- **Never delete a failing test**. Investigate and fix the root cause.
- **NEVER ignore test/system output** — logs and messages often contain CRITICAL information.
  Read test output, don't just check pass/fail. Warnings in logs point to real bugs.
- **Changing tests to match code is a red flag**: always analyze WHY.
- **Every commit must have tests**: no committing code without corresponding test coverage.
  New tool handlers, new utilities, new AI tools, bug fixes — all need tests in the same commit.
- **Regression tests for every bugfix**: reproduce the exact bug scenario in a test BEFORE fixing.
- **Maintain ~80% test coverage**: run `bun test --coverage` regularly. Currently at ~93% lines.
  New files must have corresponding test files. No shipping untested code.
- **Centralize test casts in factory functions** — see "Test-only cast exceptions" in Coding Guidelines.
- **Tests must assert behavior, not mock wiring** — "mock was called with X" is a weak assertion.
  Prefer asserting the observable outcome (return value, DB state, sent message content).
  Mock-call assertions are acceptable only when the side effect IS the behavior (e.g., verifying
  a Telegram message was sent with specific text).
- **No stub tests** — `test.todo()`, `expect(true).toBe(true)`, empty test bodies, tests that
  assert only that a function doesn't throw. Every test must assert something meaningful about
  the code's behavior. If you can't write a meaningful assertion, the test shouldn't exist.
- **Deleting a stub/broken test requires replacement** — when removing a low-quality test, write
  at least 2-3 proper tests covering the same production code. Never reduce total coverage.
- **Commit atomically and often**: after each logical unit of work (feature, bugfix, refactor), commit immediately.
  Don't accumulate 30+ changed files across multiple features.
- **NEVER use `git add -A`** without checking `git status` first.
- **Deferred findings**: when skipping a review finding (out of scope, pre-existing), create a GitHub
  issue for it. Don't silently drop known issues.
- **Before every commit** (3-stage review, mandatory even if the user just says "commit"):
  1. Run `bunx knip` — fix unused exports, dependencies, and files.
  2. Self-review your own changes.
  3. Run `codex exec review --uncommitted` — address any issues it finds.
- **Always restart the bot** after code changes to src/. Kill by exact PID, verify 1 process running.

## MTProto / Pyrogram

All MTProto userbot functionality uses **one pyrogram session**: `data/voice_caller.session`.
Auth: `venv/bin/python scripts/pyrogram-auth.py` (one-time, interactive).

- **Voice calls**: `scripts/voice-call-bridge.py <user_id> <session_id> <language>` — spawned per call
- **Message delivery** (users who haven't started the bot): `scripts/send-message.py <user_id> <text> [username]` — spawned per message

Both scripts are called from TS via `Bun.spawn(['venv/bin/python', ...])`.
No `@mtcute/bun` — pyrogram handles everything.

## Python / uv

Python deps in `pyproject.toml`. Use `uv` — never `pip` directly.
Commands: `uv pip install -r pyproject.toml --python venv/bin/python`, `uv venv --python 3.12 venv`.

ntgcalls must be built from source with a patch — see `docs/reference/deploy-runbook.md`.

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
- **Library type limitations — clone and investigate**: when a dependency produces poor types,
  clone the library source into `~/xp/` and read the actual code before guessing or casting.

## Session Wrap-Up

When summarising completed work or suggesting next steps, always scan the conversation history and memory
for items that were explicitly deferred, noted as "pending", or silently dropped mid-discussion.
Surface them as concrete suggestions — not vague hints. If something was discussed but not implemented,
name it and ask whether to pick it up.

After completing any task, answer these two questions out loud:

1. **Всё ли сделано из того, что просили?** — go through the original request point by point.
   Did any sub-task get quietly skipped? Was anything promised but not delivered?
2. **Есть ли что улучшить, исправить или убрать?** — name specific things, not vague hints.
   Open PRs not yet merged? Known limitations introduced? Stale comments or dead code noticed?

## Tone of Voice (bot messages)

All user-facing bot messages must follow these rules:

- Address the user as **"ты"** (informal singular), never "вы", never "пользователь".
- Speak directly to the person: "Ты получишь звонок", not "The user will receive a call".
- `ToolResult.output` strings have **two consumers**: the AI agent (which reformulates them) AND the
  intent engine (`IntentMatcherLayer`), which sends `output` **directly to the user** via `ctx.send()`
  when bypassing the AI. Write them as if they will be shown verbatim.
- **All user-facing strings must go through `t(lang)`** from `src/config/constants.ts`. Never use
  inline `lang === 'ru' ? ... : ...` ternaries or `if (lang === 'ru')` branches for string selection.
  Add new strings to `MSG.en` and `MSG.ru` in the appropriate namespace.
  ```ts
  import { t } from '../../../config/constants.ts';
  // static string:
  output: t(ctx.user.language).aiTools.history.notFound
  // dynamic string (function):
  output: t(ctx.user.language).aiTools.events.eventDeleted(event.title, event.id)
  ```
- **Frame features as user benefit, not technical capability.** Never describe bot actions as surveillance
  or tracking ("отслеживать кто вышел"). Instead explain what the user gains:
  "автоматически обновлять групповой календарь когда участники приходят и уходят" (benefit)
  vs "отслеживать кто присоединился или вышел" (creepy).
  Same in English: "keep the group calendar up to date" (benefit)
  vs "track who joins or leaves" (surveillance).

## Telegram Bot API Limits

Key limits (full reference: `docs/reference/telegram-limits.md`):
- **Message**: 4 096 chars. Use `splitMessage()` from `src/utils/telegram.ts` when may exceed.
- **Caption**: 1 024 chars (silently fails for non-Premium). Never exceed.
- **callback_data**: 64 bytes. Store state server-side, pass a short key.
- **Rate**: ~30 msg/sec global, ~1/sec per chat. HTTP 429 blocks ALL API calls — global backoff.
- **Entities**: max 100 per message. Don't generate unbounded bold/italic/code spans.

## Deployment

Full runbook: `docs/reference/deploy-runbook.md` (Docker, Dockerfile, bun lockfile, volume ownership, migration hazard, shared server rules).

### Server

- **Host**: 104.248.84.190 (Digital Ocean, 1 CPU, shared with other projects)
- **SSH**: `root@` for docker/sudo, `www-data@` for files.
- **Deploy path**: `/opt/hypercal`. Container mounts `/opt/hypercal/data`, reads `/opt/hypercal/.env`.
- **Domain**: `hypercal.invntrm.ru` (Caddy auto-TLS)
- **Caddy config**: CI deploys repo's `Caddyfile` to `/opt/hypercal/Caddyfile` and runs `caddy reload`.
- **Cron**: `0 3 * * *` backup, `*/2 * * * *` healthcheck (both log to `/opt/hypercal/logs/`).
- **Alerts**: `healthcheck-alert.sh` posts to `/admin/alerts` on DOWN. CI `notify-failure` does the same.
- **Never renumber existing migrations** — only append new ones at the end.
- **Shared server**: never `pm2 delete all`, `docker system prune`, or kill PIDs without checking. Port 3001 = HyperCalendarBot.

## MCP Tools

Use these MCP servers proactively whenever they can help:

- **serena** — semantic code navigation and editing. Use `find_symbol`, `get_symbols_overview`,
  `find_referencing_symbols` over reading entire files.
- **context7** — up-to-date library documentation. Use when working with external libraries
  (GramIO, Anthropic SDK, Bun APIs, etc.) to get current docs instead of guessing from memory.

## Memory

- **Actively save to memory**: every significant user instruction, decision, finding, or project state change.
- **Regularly update CLAUDE.md**: when recurring patterns, new rules, or important conventions emerge from work sessions — add them here so they persist across all conversations.
- When the user gives an instruction that applies beyond the current session, save it to memory AND consider whether it belongs in CLAUDE.md.
- Check memory at the start of each session for context on ongoing work.

## Documentation

- Specs: `docs/specs/` — design documents and feature specifications
- Plans: `docs/plans/` — implementation plans with task breakdowns
- Original specs (sub-projects 00-08): `docs/specs/00-08`
- Do NOT use `docs/superpowers/` — all docs go directly in `docs/specs/` or `docs/plans/`
