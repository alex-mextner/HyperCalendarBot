# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Universal mandatory behavior is NOT restated here.** Cross-project mandates — atomic
> commits, TDD red-first, AI-review-before-commit, delegating non-trivial work to subagents,
> the visual-proof cycle, dead-code investigation, secret-scanning, the green-CI-gated `gh ship`
> merge gate — are installed machine-wide via the agent skills/hooks layer and the repo's
> `rig.yaml` (CI gates in `.github/workflows/`). This file holds only **HyperCalendarBot-specific**
> guidance (the bot pipeline, the strict TS/type rules, bot tone-of-voice, the two MTProto tiers
> (service account + per-user `/connect_telegram`, Pyrogram), deployment). Don't duplicate universal rules into this file.

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
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`; to reproduce CI use `bun install --frozen-lockfile` (see the deploy runbook, "bun lockfile and --frozen-lockfile")
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

## Commands

```sh
bun run src/index.ts                        # start the bot
bun test test/services/intent/intent-learner.test.ts  # run a single test file (the local limit)
# ALL tests / coverage: on a Runpod pod, never locally — the exact runpod-run line is in AGENTS.md § Heavy work runs on Runpod
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
- `agent/` — what `agent.ts` composes: `round-loop` (model round → answer or tool calls), `tool-round` (one round's tool calls, dedup, ledger), `response-validation` + `validation-retry` (final-prose check and its one corrective retry), `turn-finish` (evidence guard, history writes, delivery), `measured-stream` (request deadline, late-producer guard, metrics), `failure-notices` / `failure-announcement` / `retry-store` (what the user is told after a failed run and the bounded retry store), `message-sanitizer` / `history-rows` / `conversation` (history repair and parsing).
- `streaming.ts` — `aiStreamRound`, the public import path of the provider chain; its pieces (types, errors, stream reader, slots, chains, failure handling, round budget) live in `streaming/`.
- `tools.ts` — 40+ tool definitions (the Claude API schema).
- `tool-executor.ts` — dispatches tool name → handler function.
- `tool-handlers/` — one file per domain: `events`, `reminders`, `sharing`, `secretary`, `proposals`, `slots`, `settings`, `meta`, `feedback`, `history`.
- `system-prompt.ts` — builds the system prompt as `SystemPromptParts` in prefix-cache order. Providers cache by leading bytes (z.ai implicit cache, Anthropic `cache_control`), so a per-request value must never be added ahead of static text; `test/services/ai/prompt-prefix-stability.test.ts` enforces it and `scripts/measure-ai-payload.ts` reports the shared-prefix tokens.
  - `stable` — identical for every request (role, Context, static Rules, Proactive, Shared Events, Stall).
  - `modeRules` — static text that depends only on the mode (group chat rules, voice/live-call instructions), never on user data.
  - `dynamic` — everything carrying a per-user or per-moment value: User Info and clock, the rules that quote the timezone/language/default duration/dated example, memory, schedule, group identity, secretary, supplement/scene state.
  - `assembleSystemPrompt(parts, toolIndex?)` joins them; the lazy tool index goes before `dynamic`.
- `telegram-sender.ts` — abstracts all Telegram API calls; injected as `AgentContext.sender`.

### Intent Learning System (`src/services/intent/`)

After every AI interaction (no `ask_user` calls, no contextual pronouns), `IntentLearner.analyze()` calls a secondary Haiku model to generate a candidate intent. Candidates are sent to the admin (`BOT_ADMIN_ID`) as inline-keyboard messages (Accept / Edit / Reject). Approved intents are stored in the `intents` table and matched by `IntentMatcher` in future requests, bypassing the AI entirely.

### Feature Usage Tracking (`src/services/feature-tracking.ts`)

When adding a new command, callback, scene, AI tool, or abstract user action — update the corresponding
feature tracking map so tip filtering and re-engagement work correctly:

- `COMMAND_FEATURE_MAP` — `/command` → `FeatureKey` (21 entries)
- `CALLBACK_FEATURE_MAP` — callback prefix → `FeatureKey` (20 entries)
- `SCENE_FEATURE_MAP` — scene name → `FeatureKey` (4 entries)
- `ACTION_FEATURE_MAP` — abstract action → `FeatureKey` (3 entries: `voice_message`, `ics_file`, `geolocation`)
- `TOOL_FEATURE_MAP` in `src/services/ai/tool-executor.ts` — AI tool name → `FeatureKey` (43 entries)
- `BOT_TIP_FEATURE_MAP` in `src/services/notification/tip-tags.ts` — tip key → `FeatureKey` (54 entries, keys must match `botTips` keys in constants.ts)

If you add a new `FeatureKey`, add it to `FEATURE_KEYS` in `src/database/repositories/feature-usage.repository.ts`.

### Startup (`src/index.ts` + `src/bootstrap/`)

`src/index.ts` is a short orchestration script; each startup phase lives in `src/bootstrap/<phase>.ts` with its ordering invariants in the module header (crash handlers → core/config/DB → startup context + web server → service tier → Google sync → image render → broadcast queue → voice calls → weather → notifications → bot-tasks crons → speech services → event-mention store → domain event bus → location verification → `createBot()` → `patchBotRef` + broadcast worker → scheduled AI → freeze `msgDeps` → command menu → shutdown signals → launch). Shutdown order and the 8 s deadline live in `shutdown.ts`. Add a new startup step as a phase module that takes the `StartupContext` and registers what shutdown must close in `ctx.resources`; do not grow `src/index.ts`.

### Workers (`src/worker/`)

For periodic/scheduled tasks always use BullMQ repeating jobs — never `setInterval` or `setTimeout`. Repeating jobs survive restarts and are observable in the queue.

BullMQ on Redis; the main queues:
- **image-render** — Playwright renders weekly/monthly calendar images.
- **call-reminders** — voice call reminders via the Python bridge; created only when the MTProto service tier is enabled.
- **bot-tasks** — periodic jobs: secretary expiry (daily), sharing cleanup (10min), proposal expiry (hourly), per-user session keepalive (14 days), AI usage ledger cleanup (daily), birthday sync (daily, only when the service tier is enabled).

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
- **`step.next()` re-processes the current message** — `@gramio/scenes` `step.next()` (and `step.go()`)
  immediately invokes the next step handler with the **same context/message**, not just advances the
  counter for the next incoming message. This means if step N calls `step.next()`, step N+1 runs on
  the same user input (phone number interpreted as OTP code, OTP code interpreted as 2FA password, etc.).
  **Do NOT use `firstTime` guards** — `firstTime` is reset via `onNext` in Koa-compose, but step
  handlers don't call `next()`, so `onNext` never fires and `firstTime` stays `true` forever.
  **Do NOT use scene state flags** — `context.scene.update()` writes to storage but doesn't update
  the in-memory `storageData` that `go()` passes to `scene.run()`, so the receiving step never sees it.
  **Use in-memory `pendingStepTransitions` Set** (defined in `connect-telegram.scene.ts`):
  `pendingStepTransitions.add(userId)` before `step.next()`, then
  `if (pendingStepTransitions.delete(context.from.id)) return;` at the top of the receiving step.
  Works because `step.next()` re-invokes synchronously in the same event loop tick.
  Exception: steps that listen to a different event type (e.g. `callback_query` after a `message` step)
  are safe because the event type filter prevents execution — no guard needed.

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

### MTProto: service tier and per-user sessions

Two separate Pyrogram tiers; neither is ever used for the other's job.

**Service tier** — an optional, operator-designated service Telegram account
(`data/voice_caller.session`). `src/services/telegram-session/service-tier.ts` is the only port:
it owns the env guard (`MTPROTO_API_ID`/`MTPROTO_API_HASH`, `MTPROTO_SERVICE_USER_ID` a positive
integer, the session file present) and the fail-closed identity probe (`scripts/check-session.py` must
report exactly `MTPROTO_SERVICE_USER_ID`). Startup logs one line, `MTProto service tier enabled` or
`MTProto service tier disabled` with the reason (`service_user_id_unset`, `service_user_id_invalid`,
`api_credentials_missing`, `session_missing`, `probe_failed`, `identity_mismatch`). When enabled it
only reads: resolve an @username (`resolve-username.py`), look a profile up by ID (`get-user-info.py`),
list group members (`get-chat-members.py`), fetch birthdays (`fetch-birthdays.py`), and places voice-call
reminders (`voice-call-bridge.py`). It has **no send operation**: a service account never messages
anyone. Consumers receive the tier (or functions bound from it); they never read the env, check the
session file or name a service script — all service script paths live in `service-tier.ts`.
With the tier disabled: `find_user`/`send_invitation` use the local `users` table and otherwise the
picker; group members come from `group_members`; birthday auto-sync and voice calls are off
(`make_call` is hidden). Prod never set `MTPROTO_SERVICE_USER_ID`, so the tier is off there; Telegram
may block such accounts.

**Per-user tier** — an invitation to someone who never started the bot goes
Bot API → the **inviter's own** connected session (`scripts/send-as-user.py`, spawned per send with a
decrypted temp copy of that user's row in `user_telegram_sessions`) → a deep link sent to the inviter to
forward. A user's session is only ever used for that user's own sends; never for anyone else and never
copied into the shared service file.

**`voice_caller.session` fragility**: the service scripts share one Pyrogram SQLite session file
(journal mode DELETE, not WAL) and serialize on `scripts/mtproto_lock.py`. Concurrent `app.stop()` →
`save()` writes without the lock can corrupt session fields (`user_id`, `is_bot` set to NULL), making
Pyrogram think the session is empty. Symptom: `Enter phone number or bot token:` + EOFError. Telegram can
also revoke auth keys (error 404) for long-inactive sessions; the probe then fails and the tier stays off.
Reauthorize the service account with `scripts/pyrogram-auth.py`, never from an end-user session.

### Database file naming

The production SQLite database is `data/calendar.db` (NOT `bot.db`, NOT `data.db`). The path is
set in `src/database/db.ts`. Never assume the filename — always check the code or logs
(`"path":"./data/calendar.db"` at startup). Creating a wrong-name file pollutes the data directory.

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

When adding a new env var: (1) add it to `EnvConfig` interface in `env.ts`, (2) read and validate in `loadConfig()`, (3) use via `config.VAR_NAME` everywhere else.

**Model ids are env values, refreshed against the live catalogs** (2026-10-24; `ZAI_*`/`HF_*` are required env, `CLAUDE_*` optional). z.ai coding endpoint `/models`: newest are `glm-5.3` (smart) and `glm-5.3-flash` (fast; `glm-5.3-flashx` is not in the Max plan, code 1311). Both answer 429 code 1310 while the weekly premium quota is exhausted (an unknown id would be 400 code 1211), so a 429 does not mean a bad id; the chain falls through to Claude. `glm-5.1` and `glm-4.7-flash` still exist but are superseded. Anthropic `/v1/models`: `claude-sonnet-5-5` and `claude-haiku-5-5` are the newest Sonnet and Haiku (nothing above 5.5 in those tiers). HF router: `meta-llama/Llama-3.3-70B-Instruct` and `Qwen/Qwen3-235B-A22B` are still listed live; HF has no credits (402), so a replacement cannot be probed and the ids are kept until they disappear from `/models`.

**Provider order is configuration, not code**: `AI_SMART_CHAIN` and `AI_FAST_CHAIN` list provider ids (`zai`, `claude`, `hf`, optional `openrouter`); the default for both is z.ai → Claude → HF (the owner's order, identical in ExpenseSyncBot); providers without key/model are skipped. The ids come from `PROVIDER_IDS` in
`src/services/ai/provider-ids.ts` — a leaf module that imports nothing, so both the config
layer and the AI layer can derive from it without a cycle. Add a provider there and it is
nameable at once. Gemini was removed in full (2026-10): no id, no `GEMINI_*` variable is read, and a
leftover one in `.env` is ignored. Groq as a chat provider was removed in 2026-10 because gpt-oss tested badly
and there is no replacement Groq model: no `groq` id, no `GROQ_MODEL`/`GROQ_FAST_MODEL`/`GROQ_TPM_LIMITS`
(leftovers in `.env` are ignored, and `groq` in a chain variable is dropped as an unknown id). `GROQ_API_KEY`
remains ONLY for Whisper voice transcription (`src/services/voice/transcription-service.ts`, initialised in
`src/index.ts` when the key is set); it is not an AI chat key.
A provider whose model or key is missing is skipped and the skip is logged — in practice
that means Claude, since `loadConfig()` requires the z.ai and Hugging Face credentials
and refuses to start without them. An unknown name is ignored with a warning, an order
naming nothing known falls back to the default order, and an order whose providers are all
unconfigured falls back to the default order over whatever IS configured (logged as an
error). Reordering during an incident is an `.env` edit and a restart — do not hardcode
a new order in `streaming.ts`.

**Optional OpenRouter provider** (id `openrouter`, 2026-10-23): one key that serves DeepSeek and GLM Flash.
`OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` (default `https://openrouter.ai/api/v1`), `OPENROUTER_MODEL` (smart
chain) and `OPENROUTER_FAST_MODEL` (fast chain); no model default. It is in neither default chain: it runs only
when `AI_SMART_CHAIN` / `AI_FAST_CHAIN` name it AND both the key and that chain's model are set, otherwise its slot
is skipped like any unconfigured provider. Live-verified ids (2026-10-23, `/models`): `deepseek/deepseek-v4.1-flash`
and `z-ai/glm-5.3-flash`. Claude-specific request rules (no `temperature`, the 128k `max_tokens`, the visible-token
cap) apply only to the `claude` provider, so do not route Claude models through OpenRouter in a chain without
measuring. Live-model replacement is off for it (it lists hundreds of
differently priced models), and OpenRouter accepts the `content: null` assistant turn that carries tool calls,
so the transcript is sent unchanged. Never reintroduce gpt-oss, Groq chat or Gemini through it. Its circuit is
scoped to the model (`openrouterCircuitScope`) for rate limits and outages, because OpenRouter routes each model to a different
upstream: a limit on one model must not bench the other. A rejected or spent key (401, 402, a non-moderation 403) opens one circuit for the
whole key instead (`CircuitContext.accountKey`, one notice), and any answer closes both.

**Model presets** (`src/services/ai/model-presets.ts`, 2026-10-23): one table of presets — a model plus the settings it was
measured with (`deepseek41-flash`, `glm53-flash-low`, `glm53-low`, `haiku`). `models` maps a provider id to the model id
that serves the preset there, `prices` states USD per million tokens with date and source per provider (absent = unknown, never
0), `roles` lists the roles it may be measured for and `qualifications` holds, per provider, the measurement that admitted it
(`{}` for every seeded preset: nothing is qualified yet). `isQualifiedFor(preset, role, provider)` is the gate: own-role
correctness >= 95% AND 100% of the full labelled history. The excluded list (`excludedModelReason`: GPT-OSS, the small
Qwen 3.8 27B) is enforced twice: `buildChain` skips a configured model on it with an error log, and live-model
replacement (`selectReplacementModel`) never picks one — so a dead model cannot be swapped for a banned one. A slot given
a preset (`streamingSlot(..., preset)`) sends the preset's temperature, an output floor and — on OpenRouter only, the one
provider whose control was verified — `reasoning.effort`. Chains still name plain providers, so behaviour is unchanged.

**Role routing** (`src/services/ai/role-routing.ts`, 2026-10-23): `AI_ROUTING=legacy|roles` (default `legacy`: nothing below applies),
`AI_ROUTING_USER_IDS` (comma-separated positive ints, at most 100, the canary: roles apply to those Telegram users only; unset = everyone once
`roles` is on) and one chain per role, `AI_PLANNER_CHAIN` / `AI_EXECUTOR_CHAIN` / `AI_REPAIR_CHAIN`, entries `provider` or `provider:preset`
(same names in ExpenseSyncBot). Only agent rounds are roles: purpose `agent` is the executor, `retry` (the round after the answer validator
rejected a draft) is the repair; the planner has no caller yet. Summaries, validators, intent learning etc. stay on the legacy fast chain. A preset
entry loads only if the preset names a model for that provider, the model is not excluded, the provider has a key and `isQualifiedFor(preset, role, provider)`
holds; every refused entry is logged at error level, and a role chain with nothing loadable falls back to the legacy chain. A plain `provider`
entry is NOT gated, so `roles` mode with only unqualified presets leaves the plain entries (e.g. Claude) serving agent rounds: do not turn it on
without a qualified preset or a deliberate plain chain. Rollback is `AI_ROUTING=legacy`. Known limit: only OpenRouter has a per-model circuit, so a model-specific 429 on a z.ai preset slot opens the shared z.ai account circuit for every user's legacy rounds too (it was always so; recorded on #808). Four things keep a canary from touching anyone else through the bench, the ledger, qualification and replacement
(#808, fixed in B4): a role slot's provider bench is keyed by `role:<role>:<model>` (`BenchChain` in `provider-eligibility.ts`), never the
legacy `smart`/`fast` bench, and its ledger `chain` reads `role:<role>`; the gate is per provider (`isQualifiedFor(preset, role, provider)`
reads `preset.qualifications[provider]`, so a preset measured through OpenRouter does not load on z.ai); a preset slot never runs a
live-model replacement (neither a cached nor a fresh heuristic one) because that would serve the role unmeasured; and a role chain is
followed by the legacy chain (minus models the role chain already asked), so a role chain whose slots all fail, are benched or sit behind an
open circuit at runtime hands the round to the legacy chain instead of answering nobody.

**A depleted or rejected provider account is skipped, not retried**: `src/services/ai/provider-circuit.ts`
keeps one durable circuit per provider account for every provider in the chain (key = fingerprint
of provider id, endpoint and credential, so it covers the smart and the fast chain and resets when
a key is rotated). 402, non-request-specific 429 and 401/403 open it at once; 5xx/connection faults open it
after 3 in a row. While open the account is skipped silently (recorded as `skippedProviders`, never
counted as an attempt) and it is NEVER forced: a chain whose accounts are all open fails with
`AllProvidersFailedError` of skipped diagnostics. After the provider's `Retry-After` or a reset
timestamp that names its zone (otherwise bounded exponential backoff, 5 min to 6 h) exactly one
caller holds a 2-minute half-open lease across all processes; only a real provider answer closes the
circuit, a passing deadline never does. The admin gets ONE notice per incident, through the generic
alert layer, built from class, status and the quoted reset — never the provider's error body; the
notice stays `pending` until that layer confirms it was sent. State is the sidecar file
`<DATABASE_PATH>.provider-state.sqlite` (mode 0600, no calendar migration; in memory when not
configured, so scripts never touch it). Storage errors fail open.
A caller abort, a 400, a size rejection and a vague 429 say nothing about the account and never open it.
`src/services/ai/provider-eligibility.ts` keeps the per-chain, in-memory memory of those last two:
a rate limit with no stated reset (two minutes) and a request rejected for its size (413, only when
the request carried the tool catalog; blocks are keyed by provider AND chain). That memory
suppresses calls, never observations: the outage records the readiness endpoint and the admin
alerting read are written exactly as before, and a chain where every provider is only
eligibility-benched is still attempted rather than answering nobody.

**Every provider attempt leaves one row in `ai_usage_events`** (migration 066, `src/services/ai/usage-recorder.ts`):
`aiStreamRound` records the attempt of each slot as `ok`, `error` (with a class from `usage-classification.ts`
and the HTTP status, never the provider's error body) or `skipped` before any request (`circuit_open`,
`eligibility_bench`, `round_deadline`; historical rows may still carry the retired `local_budget` and `preflight_size`, which the report keeps showing). Token columns are NULL when the provider
reported no usage — unknown is never written as 0. The row holds no prompt, completion, user or chat id. Rows
are buffered, written in one batch on the next event-loop turn, and a failed write is logged with
`dbLogger.warn({ err })` and dropped: the answer never waits on it. Callers say what a round is for with
`StreamRoundOptions.purpose`. The `cron-ai-usage-cleanup` job of the bot-tasks queue prunes rows older than
180 days (`AI_USAGE_RETENTION_DAYS`). **Role, preset and cost** (migration 067, stage B4, same column names and meaning as
ExpenseSyncBot's ledger): `role` (`planner`/`executor`/`repair`) and `preset` are set on the attempts of a role-routed slot and NULL on
legacy-chain rows; such a row's `chain` reads `role:<role>` instead of `smart`/`fast`. `cost_micro_usd` (micro-USD, `>= 0`) is the cost
OpenRouter reported in the response usage (`usage.cost`, trusted from OpenRouter only), else the dated list price of the preset that
names that provider and model times the reported tokens (`estimateCostMicroUsd`, an upper bound: no cache discount), else NULL — unknown
is never written as 0 and a failed attempt that was billed carries its cost. Reading: `bun scripts/report-ai-usage.ts [--days N] [--json]` (read-only, per
provider:model counts, errors by class, token sums with the answers that reported none counted apart, cost (`—` when unknown, with a
count of answers without a cost next to a partial sum), p50/p95, a Roles section of cost and latency per role and provider once any
row has a role (role-less rows are `legacy`), and one verdict per provider that says `no traffic in window` for a provider that served nothing; it refuses a database that has not run 067) and the
admin-only Telegram command `/ai_stats [days]` (same report, `t(lang).aiStats`, fail closed). Claude is second in the
default order and gets no traffic while z.ai answers, so prove it alive with the real code path:
`AI_SMART_CHAIN=claude AI_FAST_CHAIN=claude bun scripts/probe-ai-chain.ts --usage-database <temp.db> --expect-provider claude [--smart]`
prints the probe result and the `ai_usage_events` row it wrote (never point it at the live database).
Rows (and the report) of retired providers such as `gemini` and `groq` stay readable: the report lists any provider id
found in the rows after the configured ones. The retired `gemini_usage` table lives only in the sidecar
`<DATABASE_PATH>.gemini-quota.sqlite`, which no code opens any more; it is left on disk untouched (delete the file by hand when convenient).

**Cost risk of the order**: while z.ai is out of quota (its circuit is open, skipped silently) Claude is the de-facto
primary and every request is paid for. Claude keeps its `CLAUDE_MAX_OUTPUT_TOKENS` (128000) `max_tokens` and its thinking
behaviour unchanged. Watch `bun scripts/report-ai-usage.ts` and set `AI_SMART_CHAIN`/`AI_FAST_CHAIN` (e.g. `zai,hf`, or `hf` alone) if the cost
is not acceptable; the ExpenseSyncBot OCR chain is separate and stays Claude vision → HF vision.
Both fallbacks have run dry before: z.ai's quota ran out on 2026-09-24 (its circuit has been open since), and Hugging Face
answered 402 "no credits" in ExpenseSyncBot on 2026-10-12. With z.ai depleted and HF the only provider behind Claude,
Claude carries the traffic; keep an eye on its spend and on HF credit.
z.ai is first in both chains, so a slow-but-not-failing z.ai delays every call before Claude is tried: up to 8 s per provider on the
fast chain (validators, city resolver), up to 15 s on the smart chain; an open circuit costs nothing. The chain order is the owner's choice — shorten
`ZAI_TIMEOUT_MS` in `clients.ts` or reorder via `AI_FAST_CHAIN` if that latency shows up in `/ai_stats`.

Optional features that depend on an env var must deactivate gracefully when the var is absent — never throw at startup. Validate at the point of use, not at startup.

## Coding Guidelines

- **Dependency versions always use `^`** (e.g. `"marked": "^15.0.12"`). Never pin exact versions — it makes routine upgrades a chore and diverges from ecosystem norms. Range `^` is mandatory; `~` and bare exact versions are not acceptable.
- Principles: YAGNI, KISS, DRY, SOLID. Before creating type/component/util — check if similar exists.
- **Smallest reasonable changes**: make the minimum change to achieve the outcome.
  Don't refactor surroundings "while you're at it".
- **No `any`/`as any`/`Function`** — proper typing only.
- **No `object` type** — neither as a standalone type nor as a generic parameter (e.g. `Bun.Server<object>`).
  Use a specific interface, `{ [key: string]: unknown }`, or the correct generic argument.
  `object` accepts any non-primitive but gives no information about shape — nearly as bad as `any`.
- **No `Record<string, unknown>`** — this utility type alias is entirely banned:
  - Known shape at compile time → specific interface or Zod-inferred type
  - Parse boundary (DB JSON, external API) → `unknown`, then validate before use
  - Truly dynamic runtime accumulator → explicit index signature `{ [key: string]: unknown }`
  - Opaque external data → `unknown`
- **No `as SomeType` casts** — fix the types, don't paper over them. If a library produces a poor type,
  fix the code that feeds it (e.g. return consistent shapes from derive functions) rather than casting.
  The only acceptable cast is `as Parameters<typeof apiMethod>[0]` at the GramIO bot API call site
  where the runtime accepts objects the static type rejects (InlineKeyboard vs raw TelegramMarkup).
- **The bans below are enforced on added lines** by `ci/type-bans/type-bans.sh` (the
  `type-bans` workflow), for the ones Biome cannot express: `as unknown as` in `src/`,
  `as never`, `Record<string, unknown>` and `z.unknown()`. Biome covers `any`
  (`noExplicitAny`) and `object` (`noRestrictedTypes`). Pre-existing occurrences are not
  scanned — the gate exists to stop new ones.
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
- **Never call `JSON.parse` directly — use a zod codec.** Bare `JSON.parse(str)` can throw
  `SyntaxError` on malformed input, which every caller would otherwise have to wrap in `try/catch`.
  Use `z.codec(z.string(), Schema, { decode, encode })` from zod v4 — the `decode` callback runs
  `JSON.parse` inside and pushes an issue on failure, so `safeParse` returns `{ success: false }`
  instead of throwing.

  ```ts
  import { z } from 'zod';

  function jsonStringCodec<T extends z.ZodTypeAny>(inner: T) {
    return z.codec(z.string(), inner, {
      decode: (raw, ctx) => {
        try { return JSON.parse(raw); }
        catch { ctx.issues.push({ code: 'custom', message: 'Invalid JSON', input: raw }); return {} as z.input<T>; }
      },
      encode: (value) => JSON.stringify(value),
    });
  }

  const Parsed = jsonStringCodec(MySchema).safeParse(rawString);
  if (!Parsed.success) { /* handle error */ }
  ```

  The same rule applies to `Response.json()` — wrap with `await res.text()` + codec, or keep using
  `z.schema().safeParse(await res.json())` **only** where you are sure the response is well-formed
  JSON (framework-level, not external API). Never `(await res.json()) as SomeType` — define a Zod
  schema and run it through a codec.

  **Grandfathered exceptions** (do not propagate to new code):
  - DB-stored JSON columns with simple types (`number[]`, `string[]`) where `JSON.parse` is inside
    a repository method that already guards with try/catch. New repositories must use a codec.
  - `feedback_json_parse_safeParse.md` memory entry documents the previous pattern; it stays
    valid for those grandfathered call sites only.
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
- **Atomic commits are mandatory**: every logical unit of work (one task, one refactor, one bugfix)
  is its own commit. Never batch multiple unrelated changes into a single commit. When executing a
  multi-step plan, each step/task gets its own commit — not one mega-commit at the end.
- **Before every commit** (4-stage review, mandatory even if the user just says "commit"):
  1. Run `bunx knip` — fix unused exports, dependencies, and files.
  2. Self-review your own changes (read the diff, question each line).
  3. Run `codex exec review --uncommitted` — address every issue it finds that isn't a false positive.
  4. Run `codex exec "security review --uncommitted"` — address every security issue it finds that
     isn't a false positive.
  `codex` is the Codex CLI (Google DeepMind) — an AI code review tool installed globally.
  If `codex` is not found, skip steps 3-4 but do NOT skip the self-review in step 2.
- **Commits must NEVER break the tree**: before `git commit`, all of the following must pass clean:
  - `tsc --noEmit` — zero type errors
  - `bun run lint` — zero lint errors AND zero warnings
  - `bun test` — all tests green: one file locally when the change is truly local; the full
    suite on Runpod (AGENTS.md § Heavy work runs on Runpod) before the final commit of a
    multi-commit series
  If any of these are red, fix the root cause before committing. Never commit on top of a broken tree
  with a "will fix in next commit" note.
- **Always restart the bot** after code changes to src/. Kill by exact PID, verify 1 process running.

## MTProto / Pyrogram

- **Service tier** (optional; see "MTProto: service tier and per-user sessions"): session
  `data/voice_caller.session`, created once by the operator with `venv/bin/python scripts/pyrogram-auth.py`
  (interactive) for the designated service account, whose numeric ID goes in `MTPROTO_SERVICE_USER_ID`.
  Voice calls: `scripts/voice-call-bridge.py <user_id> <session_id> <language>`, spawned per call by
  `CallManager` with the path from the tier.
- **Per-user tier**: `/connect_telegram` (`src/bot/scenes/connect-telegram.scene.ts`) signs the user in
  with `scripts/connect-session.py`; sessions are stored encrypted with `TELEGRAM_SESSION_MASTER_KEY`
  (AES-256-GCM) in `user_telegram_sessions`. `scripts/send-as-user.py` sends as that user
  (`src/services/telegram-session/session-bridge.ts`). The bot-tasks `session-keepalive` cron keeps
  connected sessions alive.

All scripts read `MTPROTO_API_ID` / `MTPROTO_API_HASH` from the environment and are spawned from TS via
`Bun.spawn(['venv/bin/python', ...])`. No `@mtcute/bun` — pyrogram handles everything.

## Python / uv

Python deps in `pyproject.toml`. Use `uv` — never `pip` directly.
Commands: `uv pip install -r pyproject.toml --python venv/bin/python`, `uv venv --python 3.12 venv`.

Voice calls (service tier only) need ntgcalls built from source with a patch — see `docs/reference/deploy-runbook.md`.

## Backward Compatibility

When renaming variables, constants, config keys, or any other interface:
- **Ask immediately**: is backward compatibility needed, or can we migrate everything and remove the old names?
- **Default recommendation**: full migration — no aliases, no legacy shims. Aliases are technical debt.
- **Exceptions** worth keeping old names: public API with external consumers, stable library interface, or explicit user decision.
- If migration is feasible (internal code, DB rows can be updated, tests can be rewritten), propose full migration as the primary option. Final call is the programmer's.

## Debugging

Follow the universal `systematic-debugging` skill (reproduce, read the actual error, one
hypothesis, smallest change, test after each). Project-specific tip:

- **Library type limitations — clone and investigate**: when a dependency produces poor types,
  clone the library source into `~/xp/` and read the actual code before guessing or casting.

## Session Wrap-Up

Covered by the universal `task-completion-selfcheck` and `deferred-findings-tracking` skills:
before reporting a task done, walk the original request point by point for silently-skipped
sub-tasks, and file a tracking issue for any deferred finding rather than dropping it.

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
- **Front-load the essence — first two words must be the most informative.** Phone notification
  previews show only the first few words before the user taps. Never waste them on generic labels
  like "Напоминание:", "Reminder:", "Напоминания:", "Reminders:", "Сегодня ночью", "Tomorrow is a".
  Lead with the specific content: event title, holiday name, clock direction, count. The ⏰/🎉/🕐
  emoji is fine at the start — it's a glyph, not a word — but the FIRST real token after it must
  carry information.
  ```
  Bad:  ⏰ Напоминание: Лазер — завтра
  Good: ⏰ Лазер — завтра

  Bad:  🎉 Завтра праздник: День Конституции
  Good: 🎉 День Конституции завтра

  Bad:  ⏰ Напоминания:            (batch header is generic)
  Good: ⏰ Лазер + ещё 2           (first title front-loaded)

  Bad:  🕐 Сегодня ночью часы перевели на 1 час вперёд. Double-check your alarms…
  Good: 🕐 Часы переведены на +1 час
  ```
  Drop filler words ("is a", "moved", "Сегодня ночью", "Напоминание:") — they push the real
  content out of the preview. Prefer short dashes/separators over prepositions when they convey
  the same meaning. This applies to every push-style message: reminders, agenda headers, holiday
  notices, clock-change notices, birthday reminders, proposal/invitation notifications.
- **Don't instruct the user to do what the system does automatically.** Phones and OS auto-adjust
  alarms for DST; calendars auto-recalculate event times. Informational notifications should
  inform, not nag. Don't tack on "проверь будильник", "double-check your meetings", "не забудь"
  unless the user genuinely must take manual action. Shorter is better: the fewer words, the
  higher the chance the whole message is visible in the preview.

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

- **Host**: `root@odroidn2` (home ODROID-N2+, Tailscale MagicDNS name; aarch64, Armbian trixie, 6 cores, 3.7 GB RAM, root on microSD) since 2026-10-09 22:30 UTC (#784). Shared with ExpenseSyncBot, HyperSummaryBot, mextner.com and three self-hosted GitHub runners.
- **Images**: linux/arm64 only, built by CI on `ubuntu-24.04-arm` or by the local fallback.
- **Image store**: the odroid's Docker 29 uses the containerd image store (other projects' containers live there; do not switch it). An image's `.Id` and a container's `.Image` are its manifest digest there, not the config digest. The release keeps `config_digest` as its identity; the activator compares loaded and running images with the archive's indexed `manifest_digest` on containerd (the config digest on a classic store). The first odroid release (run 38018033717, 2026-10-10) failed on this. Runbook "Image identity".
- **Deploy path**: `/opt/hypercal`. Container mounts `/opt/hypercal/data`, reads `/opt/hypercal/.env`.
- **Domain**: `hypercal.mextner.com` (`PUBLIC_DOMAIN` in `/opt/hypercal/.env`; the Telegram webhook, Google OAuth redirect and Calendar watch-channel addresses are all built from it by `src/config/public-url.ts`). Since 2026-10-25 (#828) TLS and ingress are Cloudflare's: the proxied CNAME `hypercal` points at the tunnel `odroid-home` (cloudflared on the odroid, remotely managed, one hostname rule per name), whose rule sends `hypercal.mextner.com` to `http://localhost:3001`, the bot's published port. Every path reaches the bot; its own routes decide (admin endpoints need the bearer token). The old name `hypercal.invntrm.ru` (DigitalOcean droplet `104.248.84.190`, tailnet node `do-edge`, Caddy proxy to `100.116.57.66:3001`) is being retired together with the droplet and nothing registered with Telegram or Google uses it any more. Tunnel rules, the rollback and the move record: runbook "Public ingress".
- **Caddy config**: the repo `Caddyfile` is the retired DO ingress config for `hypercal.invntrm.ru` (applied by hand on DO, never loaded on the odroid). It stays only because the release artifact still carries it; it goes with the droplet.
- **CI deploy**: the `deploy` job runs on the odroid's self-hosted runner `odroid-hcb` (user `hcb-runner`, no docker group) and only pipes its `GITHUB_TOKEN` on stdin to `sudo -n /usr/local/sbin/hypercal-activate-release <sha>` (`scripts/odroid-activate-release.sh`). Root checks main and deploys only the `release-<sha>` artifact named by the `release-artifact` commit status, which the GitHub-hosted build job posts (it alone has `statuses: write`). Root trusts nothing else from the runner. No SSH secrets. Runner setup and trust model: runbook "Odroid runner".
- **Cron**: odroid: `0 3 * * *` backup. DO (until the droplet is retired): `*/2 * * * *` external watchdog, an older copy of `scripts/healthcheck-alert.sh` that probes the retired `hypercal.invntrm.ru` (log `/opt/hypercal/logs/healthcheck.log`; sends Telegram straight through the Bot API); the current script builds its probe and alert URLs from `PUBLIC_DOMAIN` in the `.env` it reads. It was commented out from 2026-10-10 to 2026-10-24 and is re-enabled; the stale `/tmp/hypercal-down` left from the first period had to be removed first (runbook "Shared Server"). The odroid has no watchdog cron.
- **Alerts**: the queue is the bot's own SQLite table `alerts`: the bot (crashes, worker failures), CI `notify-failure` and `healthcheck-alert.sh` POST to `/admin/alerts`, and `GET /admin/alerts/next` pops one (destructive). A bot that is down cannot store its own DOWN alert, so the consumer probes `/ready` itself. The consumer is the systemd user service `hcb-alert-watcher` on the owner's Ubuntu PC (`scripts/hcb-alert-watcher.ts`, installed by `scripts/install-alert-watcher.sh`; token in the keychain as `hcb-alert-watcher/admin-alert-token`): three failed readiness probes or a fresh queued alert start one detached omp investigation through `rig-detached-omp` (tmux window `hcb-alert-<utc stamp>` in the `main` session), at most one per 30 minutes, one per alert id. The session is read-only first, never restarts/rolls back/merges without the owner, and reports with `tg report`. It probes `hypercal.mextner.com`, the public host since #828 (override with `HCB_BASE_URL`; the old `hypercal.invntrm.ru` is being retired). The macOS LaunchAgent that used to do this was removed with the Mac. Runbook "Alert watcher".
- **Never renumber existing migrations** — only append new ones at the end.
- **Every new migration ships `docs/reference/migrations/<name>.md`** starting with the front matter from the runbook's "Schema gate" section (`rollback-compatible`, `data-deletion`). Without it the deploy refuses the release; `rollback-compatible: no` or `data-deletion: yes` needs a reviewed migration procedure. `test/python/test_migration_gate.py` checks every checked-in doc.
- **Shared server**: never `pm2 delete all`, `docker system prune`, or kill PIDs without checking ownership. Port 3001 = HyperCalendarBot.
- **Image retention**: a verified deploy keeps the five newest `rollback-*` tags plus the current and previous release images and removes other hypercalendarbot tags; a release that does not fit twice on the Docker root is refused before `docker load` (runbook "Disk space").

## MCP Tools

Use these MCP servers proactively whenever they can help (also surfaced via the universal
`serena` / `semantic-code-search` skills):

- **serena** — semantic code navigation and editing. Use `find_symbol`, `get_symbols_overview`,
  `find_referencing_symbols` over reading entire files.
- **context7** — up-to-date library documentation. Use when working with external libraries
  (GramIO, Anthropic SDK, Bun APIs, etc.) to get current docs instead of guessing from memory.

## Memory

- **Regularly update CLAUDE.md**: when recurring HyperCalendarBot patterns, new rules, or
  conventions emerge — add them here so they persist across sessions. Agent memory itself lives
  in the agent-tools MEMORY.md layer.

## ralphex — Autonomous Plan Executor

ralphex (`/opt/homebrew/bin/ralphex`) is an autonomous orchestrator that executes implementation plans
via Claude Code, running checkboxes sequentially with tests/lint after each step and auto-commits.

**Running a plan:**
```bash
ralphex docs/plans/YYYY-MM-DD-feature-name.md
```

**Key flags:**
- `--tasks-only` — run tasks only, skip review phases
- `--review` — skip tasks, run full multi-agent review pipeline
- `--worktree` — run in isolated git worktree (safe for risky changes)
- `--serve` — start web dashboard at localhost:8080 for real-time streaming
- `--plan "description"` — interactively create a plan file
- `--session-timeout=30m` — per Claude session timeout (default unlimited)
- `--idle-timeout=5m` — kill session after N minutes of no output

**Plan format:** standard markdown with `- [ ]` checkbox steps, same as writing-plans skill output.
Plans live in `docs/plans/`. Do NOT use `docs/superpowers/plans/`.

**Monitoring while ralphex runs:**
```
/loop 20 min — check ralphex progress
```
In the loop, check: `git log --oneline -5`, `git diff --stat`, and the test file(s) the
current task touches (`bun test test/<one>.test.ts`; the full suite only on Runpod,
AGENTS.md § Heavy work runs on Runpod).

**Important:** ralphex manages its own Claude sessions. Don't run it while actively editing the same
files in another terminal. Use `--worktree` if you need isolation.

## Documentation

- Specs: `docs/specs/` — design documents and feature specifications
- Plans: `docs/plans/` — implementation plans with task breakdowns
- Original specs (sub-projects 00-08): `docs/specs/00-08`
- Do NOT use `docs/superpowers/` — all docs go directly in `docs/specs/` or `docs/plans/`

## Retired desktop agent

Computer-control tools, pairing endpoints and the macOS app are removed. Restore from Git history only as an explicit new feature; Telegram account connection is unrelated and remains supported.

Migration `062_retire_desktop_agent` destructively drops `users.assistant_enabled`.
Rolling back the application binary alone is incompatible with older user-repository
queries. The flag values cannot be recovered from the migrated database. Calendar
and user data are retained; rollback restores the legacy flag disabled for every
user, so it does not silently reactivate desktop access.

Before applying 062, take a consistent SQLite backup (including committed WAL data)
and verify that it opens. For an application rollback after 062, stop all database
writers and back up the current database first. On a copy, confirm that migration
062 is recorded and `PRAGMA table_info(users)` has no `assistant_enabled` column.
Run the following transaction once, then verify legacy user reads/writes and
`PRAGMA foreign_key_check` / `PRAGMA integrity_check` before using that database
with the older binary. Keep retired desktop endpoints and downloads disabled.
This procedure targets the immediately preceding schema through migration 061;
other downgrades need their own compatibility review.

<!-- desktop-retirement-rollback -->
```sql
BEGIN IMMEDIATE;
ALTER TABLE users ADD COLUMN assistant_enabled INTEGER NOT NULL DEFAULT 0;
DELETE FROM migrations WHERE name = '062_retire_desktop_agent';
COMMIT;
```

If any statement fails, roll back the transaction and investigate before restarting.
Do not rerun it on a database where the column already exists. Removing only the
062 migration record lets a subsequent upgrade apply retirement again; retain all
other migration records. Prefer this schema repair to restoring the pre-062 backup,
which would discard subsequent bot writes. Historical capability values, if ever
needed, require the pre-062 backup and separate explicit authorization to restore
owned desktop-agent behavior. The regression test executes the SQL above against
an in-memory database, including post-retirement writes and re-upgrade.
