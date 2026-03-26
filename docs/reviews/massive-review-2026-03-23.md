# Massive Code Review -- HyperCalendarBot

**Date**: 2026-03-23
**Scope**: Full codebase audit across 11 domains (10 parallel agents + Google Calendar deep-dive)
**Method**: 10 parallel AI agents with web research + codebase analysis + separate Google Calendar review
**Codebase**: 232 source files, ~35K LoC production, ~38.6K LoC tests, 2807 tests passing

---

## Executive Summary

The project is architecturally sound with clean layer separation, strong typing discipline (zero `any`), 2807 passing tests, and proper Bun-native adoption. The main structural problems are: god objects in the wiring layer (`AgentContext` 113 fields, `createCallbackHandler` 28 params), a GramIO type system fight (120+ `as unknown as` casts), and localization gaps in the settings UI. Security has 2 critical findings (intent callback auth bypass, missing column allowlists). Performance needs SQLite PRAGMAs and N+1 fixes. Google Calendar integration has 3 critical architecture bugs (non-atomic sync, race conditions, missing per-user locking).

---

## Table of Contents

1. [Critical Findings](#1-critical-findings)
2. [Security Audit](#2-security-audit)
3. [Performance](#3-performance)
4. [UX & Telegram Bot UX](#4-ux--telegram-bot-ux)
5. [GramIO Framework](#5-gramio-framework)
6. [Bun Runtime](#6-bun-runtime)
7. [Backend Architecture](#7-backend-architecture)
8. [DevOps & Deployment](#8-devops--deployment)
9. [Node.js/Backend Patterns](#9-nodejsbackend-patterns)
10. [Testing & Quality](#10-testing--quality)
11. [Code Quality & Patterns](#11-code-quality--patterns)
12. [Google Calendar Integration](#12-google-calendar-integration)
13. [Prioritized Action Plan](#13-prioritized-action-plan)

---

## 1. Critical Findings

Cross-cutting issues that appeared across multiple agent reports:

### 1.1 Intent callback auth bypass [SECURITY CRITICAL]
**`src/bot/handlers/callback.handler.ts:1188-1224`**
`intent_accept`, `intent_reject`, `intent_edit` callbacks have NO admin authorization check. Any Telegram user can approve/reject intents. The `fb_close`/`fb_reply` handlers nearby correctly check `adminId`. Fix: add the same guard.

### 1.2 Missing SQLite PRAGMAs [PERFORMANCE + RELIABILITY CRITICAL]
**`src/database/index.ts:72-73`**
Only `WAL` and `foreign_keys` set. Missing:
- `busy_timeout = 5000` -- without it, concurrent writes return `SQLITE_BUSY` immediately
- `synchronous = NORMAL` -- safe with WAL, ~2x write throughput
- `cache_size = -16000` -- 64MB page cache (default 8MB)
- `mmap_size = 268435456` -- memory-mapped I/O for reads

Found by: Performance, Bun, Node.js agents independently.

### 1.3 No `uncaughtException`/`unhandledRejection` handlers [RELIABILITY CRITICAL]
**`src/index.ts`** -- missing entirely. Process crashes produce unstructured stderr, not pino logs. Docker restarts but the cause disappears. Found by: Node.js, DevOps agents.

### 1.4 Container runs as root [SECURITY + DEVOPS]
**`Dockerfile`** -- no `USER` directive. Found by: Security, DevOps agents independently.

### 1.5 Settings UI hardcoded in Russian [UX CRITICAL]
**`src/bot/commands/settings.ts`** -- all button labels and view text are Russian-only. English users see Russian in `/settings`.

---

## 2. Security Audit

### Critical
| ID | Finding | File |
|----|---------|------|
| C-1 | Intent verification callbacks lack admin auth check | `callback.handler.ts:1188-1224` |
| C-2 | `updateSyncFields` + `NotificationPreferencesRepository.update` have no column allowlist | `event.repository.ts:317-339`, `notification-preferences.repository.ts:33-41` |

### High
| ID | Finding | File |
|----|---------|------|
| H-1 | Redis has no `--requirepass` | `docker-compose.yml:6` |
| H-2 | Google Calendar webhook has no signature verification (`x-goog-channel-token`) | `server.ts:82-108` |
| H-3 | Docker container runs as root | `Dockerfile` |
| H-4 | `tar`/`electron` vulnerabilities in agent-macos workspace | `package.json` (agent-macos) |
| H-5 | User-controlled text passed as `Bun.spawn()` args instead of stdin | `index.ts:498`, `silero-tts-service.ts:22` |

### Medium
| ID | Finding | File |
|----|---------|------|
| M-1 | OAuth state payload deserialization lacks type validation | `oauth-callback.ts:50` |
| M-2 | `NODE_ENV` cast without validation against allowed set | `env.ts:87` |
| M-3 | No security headers (CSP, X-Content-Type-Options, X-Frame-Options) | `server.ts` |
| M-4 | Rate limiter is in-memory only; no rate limiting on web endpoints | `rate-limiter.ts` |
| M-5 | AI debug logs contain full system prompt + user data | `debug-logger.ts` |

### Positive
- Zero SQL injection risk -- all queries parameterized
- OAuth with AES-256-GCM encrypted refresh tokens
- Telegram webhook secret via `crypto.randomUUID()`
- Authorization checks on most callback operations
- Sensitive files properly gitignored

---

## 3. Performance

### High Impact
| Finding | File | Fix |
|---------|------|-----|
| Missing SQLite PRAGMAs (busy_timeout, synchronous, cache_size) | `database/index.ts:72` | Add 4 PRAGMA statements |
| N+1 in notification scheduler tick (1 + N queries per tick) | `scheduler.ts:251-427` | Batch queries by timezone group |
| `chat_history` grows without cleanup | `chat-history.repository.ts` | Add periodic cleanup job (90 days) |
| `getVisibleRecurringTemplates` loads ALL recurring events | `event.repository.ts:89-108` | Add `recurrence_end_at` filter |

### Medium Impact
| Finding | File | Fix |
|---------|------|-----|
| 68 tool definitions (~15-20K tokens) sent every AI round | `tools.ts` | Investigate Anthropic tool caching |
| `appendFileSync` blocks event loop in debug logger | `debug-logger.ts:138` | Use `Bun.file().writer()` |
| `removeDelayed` scans ALL delayed jobs linearly | `ai-messages-queue.ts:61-68` | Store BullMQ job ID, use `getJob()` |
| No prepared statement caching in repositories | All repositories | Cache as class properties |

### Already Good
- SQLite WAL mode, comprehensive indexes, partial indexes
- Playwright page pooling (4 pages, 50 uses, 5 min age)
- BullMQ rate limiters on notifications and calls
- AI streaming with progressive flush
- Anthropic `cache_control: 'ephemeral'` on system prompt
- TTS cache with LRU eviction
- Binary search in stress dictionary

---

## 4. UX & Telegram Bot UX

### Critical
| Finding | File |
|---------|------|
| Settings UI entirely in Russian for English users | `settings.ts:18-29` + all build*View functions |
| `/help` advertises `/timezone`, `/notify`, `/export` -- none registered as commands | `help.ts` |

### High
| Finding | File |
|---------|------|
| Mixed languages in keyboard buttons (some EN, some RU) | `keyboards.ts:125,303-378` |
| Unlocalized error toasts in callbacks ("Event not found") | `delete.ts:73`, `edit.ts:68` |
| Country picker shows Russian names for all users | `keyboards.ts:43-74` |
| No event pagination (cap at 10, no "Next") | `keyboards.ts:120` |

### Medium
| Finding | File |
|---------|------|
| No Cancel/Back button in add-event wizard steps 0-1 | `add-event.scene.ts` |
| No Undo after delete | `delete.ts:109-141` |
| `/share` references non-existent `/privacy` command | `share.ts:143-144` |
| Rate limit message doesn't say how long to wait | `constants.ts:89,398` |
| Empty "No events" messages lack guidance ("/add") | `edit.ts:45`, `delete.ts:43` |

### Already Good
- Progressive disclosure in onboarding
- AI fallback for natural language (3-layer pipeline)
- Callback fallback middleware (no hanging spinners)
- Scene command escape (`/cancel` + any command)
- Typing indicator during AI processing
- Feature tour with pagination
- Delete confirmation with scope selection
- Calendar image generation alongside text

---

## 5. GramIO Framework

### Critical
- **121 `as unknown as` / `as never` casts** -- GramIO type system not leveraged. Root cause: `const bot = new Bot(token)` without type parameterization; derive chain types not captured.

### Major
| Finding | Fix |
|---------|-----|
| 1547-line callback handler with 30+ `if` branches | Use `.callbackQuery(pattern, handler)` with `CallbackData` |
| `.callbackQuery()` not used at all -- manual `data.split(':')` | Adopt GramIO's pattern matching |
| `format`/`bold`/`italic` template tags not used -- raw HTML | Adopt `format` for safe escaping |
| Handler factories called per-request instead of once | Pre-create closures at setup |

### Unused GramIO Features
- `.callbackQuery()` with regex/`CallbackData`
- `.hears()` for pattern matching
- `format` template tags for safe formatting
- `preRequest` hook for default `parse_mode: 'HTML'`
- `@gramio/auto-answer-callback-query` plugin
- Plugin system for derive chain typing

---

## 6. Bun Runtime

### Issues
| Finding | File | Fix |
|---------|------|-----|
| ioredis for OAuth state store (Bun.RedisClient suffices) | `index.ts:64-77` | Replace with `Bun.RedisClient` |
| `appendFileSync` instead of `Bun.file().writer()` | `debug-logger.ts:6,138` | Use Bun native writer |
| `existsSync` instead of `Bun.file().exists()` | `index.ts:200,496` | Use Bun native |
| `setTimeout` promise instead of `Bun.sleep()` | `agent.ts:279`, `playwright-pool.ts:78` | Use `Bun.sleep()` |
| `edge-tts` in deps -- zero imports | `package.json:39` | Remove |
| `@mtcute/bun`+`@mtcute/tl` in prod deps (scripts only) | `package.json:33-34` | Move to devDependencies |
| 9 packages pinned without `^` | `package.json` | Add `^` per policy |
| WebSocket `idleTimeout` not set (default 120s kills calls) | `call-session-manager.ts:85` | Set `idleTimeout: 0` or 1800 |

### Already Good
- `bun:sqlite`, `Bun.serve()`, `Bun.spawn()`, `Bun.file()`, `Bun.write()`, `Bun.RedisClient`, `bun:ffi`, `bun:test` -- all used correctly
- No `express`, `ws`, `better-sqlite3`, `dotenv`, `node-fetch`, `axios`
- In-memory SQLite for tests
- Correct tsconfig for Bun

---

## 7. Backend Architecture

### High
| Finding | File |
|---------|------|
| `AgentContext` -- 113 optional fields, god object | `types.ts:32-113` |
| `createBot()` -- 17+ positional params, 913 lines | `bot/index.ts:102-136` |
| `createCallbackHandler()` -- 28+ positional params | `callback.handler.ts:80-144` |

### Medium
| Finding | File |
|---------|------|
| `MessageHandlerDeps` -- 76 fields, duplicates AgentContext | `message.handler.ts:81-157` |
| `index.ts` -- 847 lines, duplicated shutdown logic | `index.ts` |
| 2 layer violations: database imports from services/bot | `database/index.ts:5`, `workflow-session.repository.ts:3` |
| 34+ `.catch(() => {})` silently swallow errors | Multiple files |
| `meta.ts` tool handler -- 786 lines, 21 unrelated handlers | `tool-handlers/meta.ts` |

### Already Good
- Clean layer separation (repo -> service -> handler)
- Manual DI without framework overhead
- 3-layer message pipeline
- Domain event bus with typed events
- BullMQ worker architecture with proper retry/rate limiting
- Centralized env config with validation
- Graceful feature degradation

---

## 8. DevOps & Deployment

### High
| Finding | File | Fix |
|---------|------|-----|
| Container runs as root | `Dockerfile` | Add `USER` directive |
| No multi-stage build (dev deps in prod) | `Dockerfile` | Two-stage build |
| Only `:latest` tag, no SHA versioning | `deploy.yml:44` | Add `${{ github.sha }}` tag |
| No lint/typecheck in CI | `deploy.yml:12-24` | Add `bun run lint` + `tsc --noEmit` |
| No `concurrency:` on deploy workflow | `deploy.yml` | Add concurrency group |

### Medium
| Finding | File | Fix |
|---------|------|-----|
| No Docker log rotation | `docker-compose.yml` | Add `logging:` config |
| No SQLite backup strategy | -- | Add daily backup cron |
| Redis without `maxmemory` | `docker-compose.yml:6` | Add `--maxmemory 200mb --maxmemory-policy allkeys-lru` |
| GH Actions not pinned to SHA | `deploy.yml` | Pin to commit SHAs |

### Already Good
- Redis healthcheck + `service_healthy` dependency
- Resource limits on both containers
- Redis AOF persistence with named volume
- Bot healthcheck with `start_period`
- Redis not exposed to host
- Dependency layer caching in Dockerfile
- Good `.dockerignore`
- BuildKit cache in CI
- Minimal CI permissions per job
- Graceful shutdown (SIGINT + SIGTERM)
- Caddy with auto-TLS, log rotation, minimal route matching

---

## 9. Node.js/Backend Patterns

### High
| Finding | File | Fix |
|---------|------|-----|
| No `uncaughtException`/`unhandledRejection` handlers | `index.ts` | Add handlers with `process.exit(1)` |
| Shutdown has no timeout -- hangs if worker stalls | `index.ts:799-826` | Wrap in `Promise.race` with 8s timeout |
| `parseRedisUrl()` ignores password/username | `utils/redis.ts:1-7` | Parse full URL including auth |

### Medium
| Finding | File | Fix |
|---------|------|-----|
| Duplicated SIGINT/SIGTERM shutdown logic | `index.ts:799-826` | Extract `shutdown()` function |
| Silent `.catch(() => {})` on token revocation + re-queue | `sync-queue.ts:178,183` | Log at warn level |
| `Bun.RedisClient` not closed on shutdown | `index.ts:545` | Add to cleanup chain |
| Health check is trivially simple (no DB/Redis check) | `server.ts:56-58` | Verify DB + Redis |

### Low
| Finding | File | Fix |
|---------|------|-----|
| AI agent retry lacks jitter (thundering herd) | `agent.ts:273-279` | Add random jitter |
| `CallSessionManager.pendingSessions` never cleaned on timeout | `call-session-manager.ts:25` | Add TTL cleanup |
| Pino `{ error: string }` in 4 locations (loses stacks) | Various | Use `{ err: error }` |

### Already Good
- BullMQ exponential backoff on all queues
- Telegram 429 handling with `moveToDelayed`
- Google token revocation detection
- Playwright pool with lifecycle management
- Structured pino logging with child loggers
- Worker `.on('failed')` handlers

---

## 10. Testing & Quality

**Stats**: 2807 tests, 0 failing, 12.03s runtime, 5516 expect() calls, 222 test files

### Critical
| Finding | File |
|---------|------|
| Placeholder "existence tests" for worker queues (0% coverage) | `bot-tasks-queue.test.ts`, `call-queue.test.ts` |

### High
| Finding | File |
|---------|------|
| `scheduler.test.ts` manually duplicates schema instead of `runMigrations` | `scheduler.test.ts:11-68` |
| `setTimeout` waits for async (flaky) -- 15+ occurrences | `sharing.test.ts`, `secretary.test.ts`, etc. |
| Scenes almost untested: add-event 9.9%, timezone 8%, others 0% | `src/bot/scenes/` |

### Coverage Gaps (below 50% line coverage)
| File | Function% | Line% |
|------|-----------|-------|
| `conflict-schedule.ts` (template) | 0 | 4.57 |
| `timezone.scene.ts` | 33 | 8.02 |
| `feature-tour.ts` | 0 | 8.70 |
| `add-event.scene.ts` | 15 | 9.91 |
| `bot-tasks-queue.ts` | 0 | 10.59 |
| `call-queue.ts` | 0 | 10.81 |
| `notify-callback.ts` | 37 | 11.56 |
| `ai-messages-queue.ts` | 60 | 18.82 |
| `birthdays.ts` | 75 | 25.00 |
| `tool-executor.ts` | 100 | 49.76 |

### Untested Source Files (no test file at all)
- `src/bot/scenes/edit-value.scene.ts`, `onboarding.scene.ts`, `import.scene.ts`
- `src/bot/commands/feature-tour.ts`
- `src/bot/handlers/notify-callback.ts`
- `src/bot/middleware/user-resolver.ts`, `timezone-context.ts`
- `src/services/google/` (calendar-api, oauth, sync-cron, sync-queue, cleanup-cron, watch-renewal-cron)
- `src/services/notification/queue.ts`
- `src/services/voice/silero-tts-service.ts`
- `src/worker/image-render.queue.ts`

### Already Good
- Real DB testing with in-memory SQLite + migrations
- Tests exercise production code (no logic reimplementation)
- Good error path coverage
- Time-critical tests use injectable time
- Integration test for full pipeline
- Fast execution (12s for 2800 tests)
- Clean test infrastructure (no `.only()` leftovers)

---

## 11. Code Quality & Patterns

### Strengths
- **Zero `any`/`as any`** in entire `src/`
- **Biome clean**: 0 warnings across 471 files
- Only 1 `@ts-expect-error`, zero `@ts-ignore`
- Consistent `process.env` discipline (only via `config.*`)
- No `console.log` -- all pino
- Proper `db.transaction()` usage
- 1.1:1 test-to-production code ratio

### Issues
| Priority | Finding | File |
|----------|---------|------|
| HIGH | `createCallbackHandler` -- 30 positional params | `callback.handler.ts:80-145` |
| HIGH | `{ error: errStr }` instead of `{ err: error }` -- loses stacks | `callback.handler.ts:1277` |
| MEDIUM | 120+ `as unknown as` casts (systemic GramIO typing issue) | `bot/index.ts`, scenes, handlers |
| MEDIUM | 80+ `Record<string, unknown>` lazy escape hatches | `types.ts`, `intent-executor.ts`, `settings.ts` |
| MEDIUM | `String(error)` in 10 places losing stack traces | Various |
| MEDIUM | Hardcoded Russian strings bypassing i18n | `callback.handler.ts:1326-1350` |
| LOW | `_language`/`_timezone` unused params (should remove per CLAUDE.md) | `response-formatter.ts`, `conflict-service.ts` |

---

## 12. Google Calendar Integration

**Scope:** Spec compliance, security, architecture, best practices, test coverage
**Source:** Separate deep-dive review of the Google Calendar sync subsystem

### 12.1 Spec Compliance

| Aspect | Spec | Code | Verdict |
|--------|------|------|---------|
| **BullMQ queues** | 2 queues: `google-sync` + `google-watch` | 1 queue: `google-sync` (all job types) | Acceptable simplification |
| **`resolve-conflict` job** | Separate job type | Conflict resolved inline in `handleUpdatedOrNewEvent` | Acceptable, simpler |
| **Redis lock for refresh** | §1.6: concurrent refresh with Redis lock | No Redis lock -- `googleapis` handles refresh internally | **Potential issue** at concurrency=3 |
| **Batch insert in initialSync** | `db.transaction(...)` for batch | Per-event `insertSyncedEvent` without transaction | **Bug**: violates atomicity + slower |
| **`color` mapping** | §3.1: `colorId` 1-11 -> hex | Color not mapped at all | Feature not implemented |
| **Access token in sync state** | Unencrypted, acceptable tradeoff | Stored in `google_sync_state.access_token` | Matches spec, see Security |

### 12.2 Security

**Well Implemented:**
- Refresh token: AES-256-GCM with random IV + auth tag, stored encrypted
- ENCRYPTION_KEY validation: 64 hex chars, validated at startup
- OAuth state: UUID + Redis TTL 5 min + one-time use (deleted after read)
- `prompt: 'consent'` in `generateAuthUrl` -- guarantees refresh token

**Issues:**

| Severity | Finding | File |
|----------|---------|------|
| CRITICAL | Access token stored in plaintext in SQLite (1-hour window if file leaks) | `google-sync.repository.ts:34` |
| CRITICAL | Webhook endpoint does not validate origin (channel_id + resource_id known = false syncs) | `server.ts:86-98` |
| CRITICAL | No rate limiting on OAuth callback (`/oauth/google/callback`) | `server.ts:60-73` |
| MEDIUM | `JSON.parse(reminder_overrides)` without try-catch -- worker crash | `event-mapper.ts:90` |
| MEDIUM | Non-null assertions on Google API data (`cal.id!`, `res.data.resourceId!`) | `calendar-api.ts:31,98` |
| MEDIUM | `err as { code?: number }` unsafe type assertion | `sync-service.ts:89`, `sync-queue.ts:181` |

### 12.3 Architecture Issues

| Severity | Finding | File |
|----------|---------|------|
| CRITICAL | `initialSync` not in transaction -- partial insert on failure | `sync-service.ts:24-52` |
| CRITICAL | `handleUpdatedOrNewEvent` -- two SQL queries without transaction (race condition) | `sync-service.ts:198-212` |
| CRITICAL | Worker concurrency=3 without per-user locking -- parallel jobs for same user | `sync-queue.ts:157` |
| MEDIUM | All-day event end date bug (Google expects end = day AFTER last day) | `event-mapper.ts:77` |
| MEDIUM | EXDATE/RDATE lost in round-trip (only first recurrence rule preserved) | `event-mapper.ts:86-88,112` |
| MEDIUM | Silent `.catch(() => {})` on re-queue failure -- job lost forever | `sync-queue.ts:183` |
| MEDIUM | No deduplication for cron-triggered pull-sync jobs | `sync-cron.ts:35-46` |

### 12.4 Test Coverage

| File | Tests | Rating |
|------|-------|--------|
| sync-service.test.ts | 5 | 3/5 (happy path only) |
| sync-service-extended.test.ts | 19 | 4/5 (includes 410, conflicts) |
| event-mapper.test.ts | 9 | 3/5 (basic mappings) |
| connect-google.test.ts | 3 | **1/5** (only group guard) |
| disconnect-google.test.ts | 10 | 4/5 |
| oauth-callback.test.ts | 5 | 3/5 |
| webhook-handler.test.ts | 4 | **2/5** (minimal) |
| google-calendar.repo.test.ts | 10 | 4/5 |
| google-sync.repo.test.ts | 9 | 3/5 |

**Critical test gaps:** sync-queue worker (zero tests), full cycle integration test, EXDATE/multi-rule recurrence, retry logic under API instability.

### 12.5 Google Calendar Action Items

| Priority | # | Issue | File | Fix |
|----------|---|-------|------|-----|
| P1 | 1 | `initialSync` not in transaction | `sync-service.ts:24-52` | Wrap in `db.transaction()` |
| P1 | 2 | `handleUpdatedOrNewEvent` non-atomic | `sync-service.ts:198-212` | Atomic transaction |
| P1 | 3 | Worker concurrency without per-user lock | `sync-queue.ts:157` | Per-user lock or concurrency=1 |
| P1 | 4 | `JSON.parse(reminder_overrides)` unguarded | `event-mapper.ts:90` | try-catch |
| P2 | 5 | All-day event end date | `event-mapper.ts:77` | end = start + 1 day |
| P2 | 6 | EXDATE/RDATE lost in round-trip | `event-mapper.ts:86-88` | Preserve during round-trip |
| P2 | 7 | Silent catch on re-queue | `sync-queue.ts:183` | Add logging |
| P2 | 8 | Tests for sync-queue worker | (missing) | Add worker error handling tests |
| P3 | 9 | Rate limit on OAuth callback | `server.ts:60-73` | Add rate limiter |
| P3 | 10 | Non-null assertions on API data | `calendar-api.ts:31,98` | Check + throw descriptive errors |
| P3 | 11 | Color mapping not implemented | `event-mapper.ts` | Map colorId 1-11 -> hex |
| P3 | 12 | Redis lock for concurrent token refresh | `oauth.ts` | Add lock per spec §1.6 |

---

## 13. Prioritized Action Plan

### Tier 1: Do This Week (Critical + Quick Wins)

| # | Action | Effort | Impact |
|---|--------|--------|--------|
| 1 | Add admin auth check to intent callbacks | 10 min | Security critical |
| 2 | Add column allowlists to `updateSyncFields` + `NotificationPreferencesRepository.update` | 15 min | Security critical |
| 3 | Add SQLite PRAGMAs (busy_timeout, synchronous, cache_size, mmap_size) | 5 min | Performance + reliability |
| 4 | Add `uncaughtException`/`unhandledRejection` handlers | 10 min | Reliability |
| 5 | Add non-root `USER` to Dockerfile | 10 min | Security |
| 6 | Add lint + typecheck to CI (`bun run lint` + `tsc --noEmit`) | 5 min | Quality gate |
| 7 | Add `concurrency:` to deploy workflow | 2 min | DevOps safety |
| 8 | Add SHA tag to Docker images | 5 min | Rollback capability |
| 9 | Fix `{ error: errStr }` -> `{ err: error }` in callback handler | 2 min | Debugging |
| 10 | Add shutdown timeout (Promise.race 8s) | 15 min | Reliability |
| 11 | Wrap `initialSync` in `db.transaction()` | 15 min | GCal data integrity |
| 12 | Wrap `handleUpdatedOrNewEvent` in transaction | 15 min | GCal race condition |
| 13 | Add per-user locking or reduce concurrency to 1 in sync-queue | 30 min | GCal data safety |
| 14 | Guard `JSON.parse(reminder_overrides)` with try-catch | 5 min | GCal crash prevention |

### Tier 2: Do This Sprint (High Priority)

| # | Action | Effort | Impact |
|---|--------|--------|--------|
| 15 | Localize settings UI (pass `lang` to all views) | 2-3 hrs | UX critical for EN users |
| 16 | Fix/remove ghost commands in `/help` | 30 min | UX discoverability |
| 17 | Localize all keyboard buttons in `keyboards.ts` | 2 hrs | UX consistency |
| 18 | Replace 30 positional params with options object in `createCallbackHandler` | 1-2 hrs | Code quality |
| 19 | Replace 17+ positional params with options object in `createBot` | 1 hr | Code quality |
| 20 | Multi-stage Dockerfile (strip dev deps) | 30 min | Image size + security |
| 21 | Fix `parseRedisUrl()` to include password | 15 min | Security (future Redis auth) |
| 22 | Add Docker log rotation | 5 min | Ops stability |
| 23 | Add Redis `--requirepass` + `maxmemory` | 15 min | Security + stability |
| 24 | Deduplicate shutdown logic (extract function) | 15 min | Code quality |
| 25 | Fix all-day event end date in GCal mapper | 30 min | GCal correctness |
| 26 | Preserve EXDATE/RDATE in GCal round-trip | 1 hr | GCal data loss |

### Tier 3: Do Next Sprint (Medium Priority)

| # | Action | Effort | Impact |
|---|--------|--------|--------|
| 27 | Split `AgentContext` into core + capability groups | 2-3 hrs | Architecture |
| 28 | Decompose callback handler into dispatch map | 3-4 hrs | Maintainability |
| 29 | Add Google Calendar webhook token verification | 1 hr | Security |
| 30 | Add chat_history cleanup job (90 days) | 30 min | DB growth |
| 31 | Batch notification scheduler queries (fix N+1) | 2 hrs | Performance |
| 32 | Add Cancel/Back buttons to add-event wizard | 1 hr | UX |
| 33 | Fix `scheduler.test.ts` to use `runMigrations` | 5 min | Test correctness |
| 34 | Replace `setTimeout` waits in tests with flush | 1-2 hrs | Test reliability |
| 35 | Add tests for scenes (add-event, onboarding, timezone) | 4-6 hrs | Coverage |
| 36 | Add SQLite backup cron | 1 hr | Data safety |
| 37 | Add tests for sync-queue worker | 2-3 hrs | GCal test coverage |
| 38 | Add Redis lock for concurrent GCal token refresh | 1 hr | GCal reliability |

### Tier 4: Backlog (Nice to Have)

| # | Action | Effort | Impact |
|---|--------|--------|--------|
| 39 | Adopt GramIO `CallbackData` + `.callbackQuery()` | 4-6 hrs | Framework alignment |
| 40 | Adopt GramIO `format` template tags | 2-3 hrs | XSS safety |
| 41 | Use `preRequest` hook for `parse_mode: 'HTML'` | 30 min | DRY |
| 42 | Replace `Record<string, unknown>` with proper types | 2-3 hrs | Type safety |
| 43 | Remove `edge-tts`, move `@mtcute/*` to devDeps | 10 min | Cleanup |
| 44 | Fix all `^` version pins | 10 min | Policy compliance |
| 45 | Add security headers to web responses | 30 min | Hardening |
| 46 | Pin GH Actions to SHA | 15 min | Supply chain |
| 47 | Fix layer violations (database importing from services) | 1 hr | Architecture |
| 48 | Split `meta.ts` tool handler (786 lines) | 1-2 hrs | Organization |
| 49 | Add event pagination to picker keyboard | 1 hr | UX |
| 50 | Replace real worker queue placeholder tests | 2 hrs | Test quality |
| 51 | Set WebSocket `idleTimeout` for voice calls | 5 min | Reliability |
| 52 | Replace `ioredis` OAuth store with `Bun.RedisClient` | 30 min | Consistency |
| 53 | Add jitter to AI agent retry | 5 min | Resilience |
| 54 | Map GCal `colorId` 1-11 to hex | 1 hr | GCal feature |
| 55 | Rate limit on OAuth callback | 30 min | GCal security |

---

## Statistics

| Metric | Value |
|--------|-------|
| Total findings | 110+ |
| Critical | 8 (5 general + 3 Google Calendar) |
| High | 27 |
| Medium | 45 |
| Low | 30+ |
| Quick wins (<15 min) | 18 |
| Positive findings | 45+ |
| Domains reviewed | 11 |

## Methodology

10 parallel agents + 1 separate Google Calendar deep-dive:
1. Searched the web for current best practices (2024-2026)
2. Analyzed the full codebase structure
3. Read key files in their domain
4. Ran tools where applicable (lint, tests, coverage)
5. Produced findings with file:line references

Cross-validation: SQLite PRAGMAs found by 3 agents independently. Container-as-root found by 2. `uncaughtException` missing found by 2. Google Calendar webhook auth found by both Security and GCal agents. This convergence increases confidence in these findings.
