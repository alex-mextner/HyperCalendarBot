# GH-334 Scope 3: server-owned intent learning jobs

Status: draft for review (2026-09-28). Task: GH-334. Implemented by PR-2 (service, sidecar store,
HTTP API, admin CLI; not wired to live traffic) and PR-4 (live sample capture, startup, Telegram
admin commands). Consumes PR-0 (simulator) and PR-1 (revision service). The Mac worker is
`docs/specs/2026-09-28-intent-recovery-334-mac-worker.md`.

Prior design: `intent-evolution-release-20260919/docs/intents/learning-service.md` and
`src/services/intent-learning/*` (unmerged, never tested by its authors; preserved in the recovery
bundle 2026-10-07 at `d3e9275a`, see the plan's global constraints). This spec keeps its queue,
lease, rate, backoff and validation ideas and changes what is listed under "Deviations".

## Goal

The server accumulates samples of requests the intent layer did not handle, turns them into jobs,
and hands one stage at a time to a Mac Claude Code worker. The server owns every state transition,
retry, round count and rate budget. A learned proposal becomes a PR-1 `learned` revision draft; only
an authenticated administrator can activate it.

## Deviations from the 2026-09-19 design

1. No sidecar ledger, no `applyRegistryRevision`: activation is `IntentRevisionService.approve` (PR-1).
2. `intentResponse` is not model judgment. The server computes it by running the proposed rule set
   through the PR-0 simulator (real matcher, executor and tool handlers on an in-memory database,
   fake transport, external effects blocked).
3. `idealResponse` comes from a separate `assess` stage in its own fresh session that sees the request
   and minimised context only, never the proposal or the historical answer.
4. Queue fairness is added (round-robin by pseudonymous scope key; live before corpus; corpus cap).
5. A privacy minimisation boundary is specified (below); the 2026-09-19 samples carried the last 12
   chat messages with credential-only redaction.
6. The worker's "any 2xx is acceptance" rule is replaced by an explicit `{accepted: true, outcome}`.

## Storage: sidecar `<DATABASE_PATH>.intent-learning.sqlite`

Mode 0600, WAL, `busy_timeout` 3000, same pattern as `provider-state.sqlite`. Tables: `samples`,
`jobs`, `job_samples`, `stage_runs`, `artifacts`, `meta` (rate bucket, pause), `outbox` (admin
notices), `audit`. **Not backed up by design**: samples are derived copies of user text that already
exist in `chat_history` (backed up); fewer copies is the point. Losing the file loses queued learning
work only; active rules are unaffected (they live in the main database). Proposals that reached the
administrator exist as PR-1 revision rows in the main database.

Retention: a sample is deleted 30 days after `last_seen` unless an open job or an awaiting proposal
references it; artifacts of finished jobs are deleted after 30 days, keeping only the revision row.
`purgeActor(actorId)` deletes every sample and job-sample link for that actor's scope key and is
exposed through the admin CLI.

## Privacy boundary (what a sample may contain)

A sample is built by `minimiseSample(interaction)` before it is persisted:

| Field | Rule |
| --- | --- |
| scope key | `HMAC-SHA256(INTENT_LEARNING_PSEUDONYM_KEY, actorId:chatKind)`; no Telegram id, username, phone or chat id is stored |
| request | at most 500 chars, masked by `redactText`, ported from the 2026-09-19 `redaction.ts` (which masks only credential-shaped values) and **extended** in PR-2 to also mask emails, phone numbers, card-like digit runs and URL query strings |
| previous AI answer | at most 1000 chars, masked the same way |
| tool calls | tool name plus inputs filtered to the keys of that tool's schema; string values masked; contact names and @handles replaced by stable placeholders per sample (`{{person_1}}`) |
| tool results | `success` plus at most 500 chars of masked output |
| recent context | at most 4 previous turns, 300 chars each, masked |
| language, timezone, local time | kept (needed for correct simulation) |

Not captured at all: group chats where the bot is not directly addressed, messages the NLI group
filter dropped, interactions with any tool in the sensitive set (`SENSITIVE_LEARNING_TOOLS` =
`manage_secretaries`, `list_calendar_access`, `set_event_visibility`, `share_agenda`, `share_event`,
`connect_telegram_status`, `dismiss_connect_telegram_prompt`, `remember_user_fact`, `get_user_info`,
`find_user`, `lookup_stress`, `make_call`, `end_call`, `schedule_ai_call`, `schedule_ai_call_cancel`,
`schedule_ai_calls_list`, `send_feedback`), and requests the `assess` stage labels `sensitive` (the sample is
then deleted and never reused). The Mac worker sees only this minimised form.

## Model

- **Sample**: dedup by `sha256(normalised request)` within a scope key; repeated requests increment
  `occurrences` and refresh `last_seen` (accumulation). A sample is `eligible` when the AI path used at
  least one tool (`toolCalls.length > 0`, the guard the 2026-09-19 wiring dropped) and made no
  `ask_user` call; otherwise it is kept as evidence-only context.
- **Job**: one learning attempt over 1..25 required samples, `source` = `live` or `corpus`, formed when
  a scope has 3 eligible samples, or daily for any scope with at least 1, or by an admin enqueue.
- **Stages**: `assess` (once per job) -> `generate` (round r) -> `simulate` (server-native, no Claude)
  -> `verify` (round r). `verify` pass -> PR-1 `propose(body, { kind: 'learned', jobId })` and one admin
  notice (the service derives and stores `author = 'learner:<jobId>'` itself; no authority-bearing
  string is passed). `verify` revise with r < 3 -> `generate` r+1 with the review findings. After round 3
  -> job `needs_admin_revision`; the last draft is still stored as a revision draft for manual editing.
- **Three-way comparison**: for every required sample, the `verify` artifact compares
  `previousAiResponse` (stored), `intentResponse` (simulated, server-filled; worker values ignored) and
  `idealResponse` (from `assess`), with verdict `better | equivalent | worse | needs_context` and
  per-criterion scores for friendliness, informativeness and grounding (rubric in
  `src/services/intent-learning/response-quality.ts`; grounding = every fact in the answer comes from a
  tool result of the same run). Pass requires: no findings, every required sample compared exactly
  once, no `worse`, native validation of the proposal (PR-1 `validateRevision`), and a simulation
  with write outcome `none` for read samples and "asked confirmation" for write samples.

## Sessions

Each stage run records `session_id` (UUID supplied by the worker). The server refuses a result whose
`session_id` already appears in `stage_runs` for a different stage run (`409 session_reused`), and
refuses a `verify` whose session equals any `assess` or `generate` session of the same job. A retried
identical body (same job, lease, session, artifact hash) returns the recorded outcome (idempotent).

## Leases, retries, backoff, rate limits

- Claim is a transaction: pick the next due job (fairness below), create a lease token (32 random
  bytes, base64url, stored hashed), lease 15 min, extended by heartbeat. Expired lease -> job returns
  to `queued` with `attempts + 1`; not a round.
- Failure classes from the worker: `quota`, `auth`, `token`, `rate_limit` pause every claim
  (global pause); `network`, `timeout`, `transient`, `server`, `model_unavailable` defer only the job;
  none consumes a round. Delay = `min(12 h, max(15 min * 2^(failures-1) * jitter(0.8..1.2), retryAfterMs))`.
  `invalid_artifact`, `refusal`, `max_turns` consume a round.
- Rate bucket persisted in `meta`: 1 concurrent lease, 2 starts/minute, 12/hour, 48/day.
- Fairness: among due jobs, prefer `live` over `corpus`; within a source, the scope key whose last
  claimed job is oldest goes first (round-robin); corpus jobs limited to 4 starts per hour.
- Reclassification: the admin can mark a job `retry_now` (clears due time, not the global pause).

## HTTP API `/admin/intent-learning/v1`

Ported from the 2026-09-19 table with these rules: two bearer tokens `INTENT_WORKER_TOKEN` and
`INTENT_ADMIN_TOKEN`, each at least 32 chars, distinct from each other and from
`ADMIN_ALERT_TOKEN`, compared in constant time; if the feature is enabled but tokens are invalid,
every route answers 503 and startup logs one error (the bot still starts). JSON only, body at most
1 MiB, `Cache-Control: no-store`, no CORS.

| Route | Role |
| --- | --- |
| `POST /claim`, `/heartbeat`, `/result`, `/failure`, `/evidence`; `GET /schema` | worker |
| `POST /enqueue`, `/proposals` (list/get/create manual), `/approve`, `/reject`, `/retry`, `/purge`; `GET /status` | admin |

A worker token on any admin route gets 403 and an audit row. `/evidence` kinds are fixed
(`samples`, `catalog`, `operations`, `log-summary`), job-scoped by lease, limit 1..100; no path,
SQL or command parameter exists. `/result` answers `{accepted: true, outcome}`; any other body is a
failure for the worker.

## Configuration (`src/config/env.ts`)

`INTENT_LEARNING_ENABLED` (default false), `INTENT_WORKER_TOKEN`, `INTENT_ADMIN_TOKEN`,
`INTENT_LEARNING_PSEUDONYM_KEY` (at least 32 chars). Nothing here throws at startup. Truth table:
`INTENT_LEARNING_ENABLED` false or unset -> routes not registered (404), no samples recorded;
enabled with any token or key missing, too short or equal to another token -> routes registered, every
route answers 503, no samples recorded, one startup error log; enabled and valid -> normal operation.

## Wiring (PR-4)

- `ai-agent-layer.ts`: after the agent completes, `learning.recordInteraction(...)` fire-and-forget
  with `.catch` logging; the existing `toolCalls.length > 0` and no-`ask_user` guards are kept.
- `src/index.ts` / `src/bot/index.ts`: construct the service when enabled; call
  `revisionService.ensureSourceBaselineDraft(seedIntents)` at startup; register routes.
- Telegram admin commands (only when `BOT_ADMIN_ID` is configured; guard with an early return, no
  non-null assertion, no role cast): `/intents` (active revision, drafts awaiting approval, queue
  state), `/intent_review <id>` (summary, operations, three-way comparison excerpt, full body hash),
  `/intent_approve <id> <hash>`, `/intent_reject <id> [reason]`. All strings through `t(lang)` in
  `constants.ts`; commands added to `COMMAND_FEATURE_MAP`.
- The legacy `IntentLearner` and its callbacks stay as they are (disabled on a managed basis); their
  future is a separate tracking issue, not a deletion here.

## Acceptance

PR-2 (real sidecar SQLite, fake clock, fake worker over the real HTTP handler registered by the
production `src/web/server.ts` route table, not a test-only router):
1. Worker/admin separation (`test/web/intent-learning-auth.test.ts`): the worker token on `/approve`,
   `/reject`, `/proposals` (create), `/enqueue`, `/retry`, `/purge` -> 403, audit row, no revision or
   job change; no route exists that replaces the registry or resets it to source (any such path ->
   404 for both tokens); with `INTENT_ADMIN_TOKEN` unset, too short or equal to another token, every
   admin route -> 503 and nothing changes; both bearer checks compare SHA-256 digests of the
   header and the expected value with `timingSafeEqual` (a local helper in
   `src/web/intent-learning.ts`; the existing `isValidAlertToken` in `server.ts` is not changed), and
   a unit test covers equal-length and different-length wrong tokens; admin approve with a
   wrong id, wrong hash or stale base -> refusal code from PR-1 and no mutation; a body carrying
   `author: "admin"` or `decided_by` from the worker token changes nothing and is ignored from the
   admin token (server sets both from the principal).
2. Same `session_id` for `generate` and `verify` -> 409; fresh ids -> accepted.
3. `quota` failure: job keeps stage and round, `dueAt` >= 15 min, global pause set; a second `quota`
   doubles the delay; `retryAfterMs` larger than the backoff wins; 12 h cap holds.
4. Lease expiry mid-stage returns the job to the queue without consuming a round; a late `/result`
   with the old lease -> 409.
5. Fairness: scope A enqueues 10 jobs, scope B 1 -> B is claimed second, not eleventh; a live job is
   claimed before an older corpus job.
6. A verified job reaches the real PR-1 `IntentRevisionService.propose` (integration test on a real
   main database): the draft row has `kind='learned'` and `author='learner:<jobId>'`.
7. Three rounds of `revise` -> `needs_admin_revision`, the draft exists as a revision row, nothing
   is activated.
8. A `pass` whose simulation shows a write without confirmation is downgraded to `revise` natively.
9. Minimisation: `redactText` masks each of the added classes (unit test per class); a sample built from an interaction containing a phone number, an email, an @handle
   and a Telegram id contains none of them; the scope key does not contain the actor id.
10. Idempotent `/result` retry returns the recorded outcome and does not advance twice.
11. Logs: the pino output of a full job contains no request text, no token and no lease token.

PR-4 (real handlers with fake Telegram transport):
1. A non-admin sending `/intent_approve` gets the standard unknown-command behavior; nothing changes.
2. Admin approve with a wrong hash refuses; with the full hash activates and replies with it.
3. A tool-less AI answer records no eligible sample; a tool-using one records one.
4. Feature disabled: no route answers 200, no sample is written, startup succeeds.
