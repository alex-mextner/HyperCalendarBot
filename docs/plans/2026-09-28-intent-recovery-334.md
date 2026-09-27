# GH-334 intent recovery implementation plan

> For agentic workers: use subagent-driven development, one PR per slice below, each in its own
> worktree created with `rig worktree create` from current origin/main. Steps use `- [ ]`.

**Goal:** contextual event references with confirm-before-write, administrator-approved intent
revisions, server-owned Opus learning through a Mac worker, and an honest coverage measurement over
the retained 402-message corpus.

**Architecture:** the revision ledger (main database) becomes the only way the active intent registry
changes; learning runs in a sidecar-backed server service that hands single stages to a leased Mac
worker and produces revision drafts; contextual references live in a main-database table and only
nominate candidates that are re-read, shown and confirmed.

**Specs (authoritative):**
- Scope 1: `docs/specs/2026-09-28-intent-recovery-334-context-references.md`
- Scope 2: `docs/specs/2026-09-28-intent-recovery-334-revisions.md`
- Scope 3: `docs/specs/2026-09-28-intent-recovery-334-learning-service.md`
- Scope 4: `docs/specs/2026-09-28-intent-recovery-334-mac-worker.md`
- Scope 5: `docs/specs/2026-09-28-intent-recovery-334-coverage.md`

**Recon (private, not in git; lives only in the main checkout, not in any worktree):**
`/Users/ultra/xp/hypercalendarbot/logs/intent-resume-20260927-chatgpt-334/` —
`preservation/SUMMARY.md`, `state-map/REPORT.md`, `evidence-audit/REPORT.md`,
`revision-spec-review.md`, `orchestrator-verification.md`.

## Global constraints

- Priority order: data integrity and security, then reliability, then coverage and features.
- Port source is the dirty, never-tested `.worktrees/intent-evolution-release-20260919` (read-only);
  every port applies the fixes named in the specs. The 2026-09-19 code is not copied wholesale.
- Migrations: 064 is PR #464. Ours are `065_intent_revisions` (PR-1) and `066_event_references`
  (PR-5); recheck numbering against origin/main and open PRs at merge time; each needs
  `docs/reference/migrations/<name>.md` in the same PR (deploy schema gate).
- Seed-touching PRs (PR-6, PR-7) activate only through an approved source-baseline revision. They
  rebase after #548 for merge coordination only (`workflow-bindings.ts`, `seed-calendar.ts` notes);
  #548 does not change the catalogue fingerprint (notes are excluded from `seedFingerprint`) and is
  not blocked by PR-1.
- Not ours (do not edit their files except through rebase): `/add`; providers/routing/benchmarks;
  #509 delete-confirmation gate; #508; #493/#495/#498; #426 with PR #394; #548; #338/PR #337
  (separate session, worktree `friendly-agenda-338-20260928`; this plan only depends on its rubric).
  `src/utils/date.ts` belongs to #495/PR #523.
- Repository rules: Biome zero warnings, `tsc --noEmit`, no casts or `Record<string, unknown>`,
  zod codecs instead of `JSON.parse`, strings through `t(lang)`, `{ err }` logging, no unbounded
  hot-path queries, TDD RED first on real SQLite with real handlers and fake transport.
- Privacy: no corpus text, Telegram ids or session ids in git; fixtures are synthetic.
- Review: `review diff --staged --task <child task> -C <worktree>` before every commit; merge through
  `gh ship`.

## PR table and merge order

PR ids are stable slice names from the specs (PR-0 was drafted first as the measurement base); the
`Order` column is the merge order.


| Order | PR | Title | Files owned | Depends on | Acceptance (spec section) |
| --- | --- | --- | --- | --- | --- |
| 1 | PR-1 | Revision ledger and exact admin approval | `src/database/migrations.ts` (append 065), `docs/reference/migrations/065_intent_revisions.md`, `src/database/repositories/intent.repository.ts`, `src/database/repositories/intent-revision.repository.ts` (new), `src/database/repositories/workflow-session.repository.ts` (`liveIntentIds`), `src/services/intent/{registry,rule-fingerprint,revision-body,revision-validator,revision-ledger,revision-service}.ts` (new; exact split decided by the implementer), `src/services/intent/seed-replacement.ts`, `scripts/generate-intent-docs.ts` and `scripts/replay-intent-corpus.ts` (fingerprint import only), `test/helpers/intent-registry.ts` (new), `src/services/intent/intent-executor.ts` (`revisionGuard` only), `scripts/replace-intent-basis.ts`, `scripts/intent-revisions.ts` (new CLI), `docs/intents/engine.md` (managed-basis paragraph) | none | Scope 2, acceptance 1-17 |
| 2 | PR-0 | Simulator, coverage harness, methodology, synthetic fixtures | `src/services/intent/simulation/*` (new), `scripts/intent-simulate.ts` (new child-process runner), `scripts/intent-coverage.ts` (new), `test/fixtures/intent-corpus/synthetic-cases.json`, `docs/intents/coverage-methodology.md` | PR-1 (merge order only; no code dependency) | Scope 5, PR-0 1-5 |
| 3 | PR-5 | Event reference store, migration 066, time primitives, bounded title lookup | `src/database/migrations.ts` (append 066), `docs/reference/migrations/066_event_references.md`, `src/services/intent/{event-reference-store,event-time,wall-clock}.ts` (new), `src/database/repositories/event.repository.ts` (`findByTitleFolded` only) | PR-1 (migration order) | Scope 1, PR-5 1-10 |
| 4 | PR-2 | Learning service, sidecar store, HTTP API, admin CLI | `src/services/intent-learning/*` (new), `src/web/intent-learning.ts` (new), `src/web/server.ts` (route registration hunk), `src/config/env.ts` (4 vars), `scripts/intent-learning-admin.ts` (new), `docs/intents/learning-service.md` (new) | PR-1, PR-0 | Scope 3, PR-2 1-10 |
| 5 | PR-3 | Mac worker, evidence MCP, LaunchAgent installer | `scripts/intent-worker.py`, `scripts/intent-worker-evidence.py`, `scripts/install-intent-worker.py`, `test/python/test_intent_worker*.py`, `test/web/intent-worker-contract.test.ts`, `docs/intent-worker.md` | PR-2 | Scope 4, 1-6 + contract test |
| 6 | PR-4 | Live wiring and Telegram admin commands | `src/bot/pipeline/ai-agent-layer.ts`, `src/index.ts`, `src/bot/index.ts`, `src/config/constants.ts` (admin strings), `src/services/feature-tracking.ts`, `src/bot/commands/intent-admin.ts` (new) | PR-1, PR-2; rebase after #508/#509 (`constants.ts`) | Scope 3, PR-4 1-4 |
| 7 | PR-7 | Natural entry recognizers and seeds | `src/services/intent/{natural-entry,seed-natural}.ts` (new), `seed-catalog.ts`, `workflow-bindings.ts`/`workflow-validator.ts` (natural hunks), `docs/intents/*` regenerated | PR-1, PR-0; rebase coordination with #548 | Scope 5, PR-7 1-2 |
| 8 | PR-6 | Contextual seeds, confirmation consumption, wiring | `src/services/intent/seed-contextual.ts` (new), `seed-catalog.ts`, `seed-lineage.ts`, `workflow-bindings.ts` (eventref context), `intent-executor.ts`, `src/bot/pipeline/intent-matcher-layer.ts`, `src/bot/handlers/message.handler.ts`, `src/services/ai/tool-executor.ts` (reference hook), `src/database/repositories/workflow-session.repository.ts` (optional `threadId` in session data), `docs/intents/*` | PR-1, PR-5, PR-0, #509, #498; rebase coordination with #548 | Scope 1, PR-6 1-8 |

Child tasks (each blocks GH-334; dependency links recorded in the tracker): PR-1 = #555,
PR-0 = #556, PR-5 = #557, PR-2 = #560, PR-3 = #561, PR-4 = #558, PR-7 = #563, PR-6 = #559.
Use the child task code for `review diff --task` of each PR.

PR-7 and PR-6 are independent of each other; whichever merges second rebases `seed-catalog.ts`.

External dependent of PR-1: #426 (with PR #394), which changes a serialized seed workflow. If it
merges before PR-1, its deploy leaves production with zero intents until an operator reruns
`replace-intent-basis.ts` (current behavior, documented in `engine.md`). After PR-1, its seed change
is drafted as a source baseline and the old rules keep running until the administrator approves.
#548 is not a dependent: it changes only notes metadata and binding runtime, not the fingerprint.

## Tasks

### PR-1 revision ledger (first code PR)

- [x] Worktree: already created by the coordinator at `.worktrees/intent-revision-ledger-334`
  (branch `feat/intent-revision-ledger-334`, base 7399876e); RED recorded in the private
  `ledger-red.txt`. Do not create a second #555 worktree.
- [x] RED: `test/regressions/intent-revision-ledger.test.ts` case 1 (source-only deploy keeps 52),
  failing for the right reason (recorded in the private `ledger-red.txt`).
- [ ] RED: migration tests `test/database/migrations-065.test.ts` (backfill from the live manifest;
  tamper before backfill inserts nothing and does not throw; unmanaged inserts nothing).
- [ ] Implement migration 065 and its doc; `registry.ts` (`readRegistry`, `registryIntegrity`).
- [ ] Change `getApproved()` to the integrity table in the spec; per-rule compatibility skip.
- [ ] RED then GREEN: cases 2-6, 8-11 (baseline draft idempotent and never active; dropped learned
  rules listed; approve; revise/hash/not-found; stale base; tamper after proposal; tampered unaffected
  rule; ledger mismatch; per-rule skip).
- [ ] RED then GREEN: case 12 (`liveIntentIds` reusing `TTL_MS`, predicate and codec; boundary; corrupt
  JSON).
- [ ] RED then GREEN: cases 13-14 (`revisionGuard` before every mutation step; resumed session and
  in-flight run of a changed rule stop before mutation).
- [ ] RED then GREEN: case 15 (retire dispositions), case 16 (principals; body `author` ignored).
- [ ] `replace-intent-basis.ts` records/approves revisions; `scripts/intent-revisions.ts` list/show/
  approve/reject with operator principal; `engine.md` paragraph corrected.
- [ ] `tsc --noEmit`, `bun run lint`, full `bun test`, `bunx knip`; `review diff --staged`; commit; `gh ship`.
- [ ] After deploy: read-only check that production `getApproved()` still returns 52 and one active
  `source_baseline` revision exists with target equal to the manifest.

### PR-0 simulator and coverage harness

- [ ] RED: simulator fixture tests (direct read covered; write covered only via confirmation;
  `send_invitation` unsafe and blocked; contextual without references is `missing_context`).
- [ ] RED then GREEN: child-process simulator with the per-case clock preload; a read and a write
  fixture give the same outcome under two host clocks; the parent clock is untouched.
- [ ] Implement `simulateCases` on in-memory SQLite with real layers and fake sender; external-effect
  guard.
- [ ] Harness CLI with bucket classifier, `--compare`, output-path guard (RED test refusing `docs/`,
  `test/`).
- [ ] Synthetic fixtures (at least 6 per class) and the local-only similarity check against the private
  corpus.
- [ ] Methodology doc; local run on the private corpus; record matcher-only 18 and covered N in the
  private checkpoint; gates; review; commit; ship.

### PR-5 reference store and primitives

- [ ] RED: acceptance 1-10 in the scope 1 spec, one test each; migration 066 plus doc.
- [ ] Port and fix the store (snapshots, statuses `stale`/`none`, reply mapping, bounded retention);
  `event-time.ts`/`wall-clock.ts` with DST cases; cursor-bounded `findByTitleFolded`.
- [ ] Gates; review; commit; ship.

### PR-2 learning service

- [ ] RED: acceptance 1-10 of the learning-service spec (auth separation on production routes first).
- [ ] Port queue, leases, stages (`assess`, `generate`, `simulate`, `verify`), rate bucket, backoff,
  fairness, minimisation, retention, outbox; activation only via PR-1 `propose`.
- [ ] Route registration in `server.ts`; env vars in `env.ts` with graceful disable; admin CLI; doc.
- [ ] Gates; review; commit; ship (feature stays disabled until PR-3 and PR-4).

### PR-3 Mac worker

- [ ] RED: Python tests 1-6; TypeScript contract test against the real handler.
- [ ] Port and fix worker (`assess` stage, explicit acceptance body, CLI version check, pure argv
  builder, session id cross-check), evidence MCP, installer; doc.
- [ ] Gates; review; commit; ship.
- [ ] Ops: install LaunchAgent with its own token; `--dry-run` receipt in the private checkpoint.

### PR-4 wiring and admin commands

- [ ] RED: acceptance 1-4 of PR-4 with real handlers and fake Telegram transport.
- [ ] Wire capture (keep `toolCalls.length > 0` and no-`ask_user` guards), startup
  `ensureSourceBaselineDraft`, admin commands with `t(lang)` strings, `COMMAND_FEATURE_MAP`.
- [ ] Gates; review; commit; ship; enable `INTENT_LEARNING_ENABLED` in `/opt/hypercal/.env`, recreate
  the container, and prove one real Opus job end to end (three distinct session ids recorded
  server-side, draft visible in `/intents`, nothing approved by the proof).

### PR-7 natural entry

- [ ] Rebase onto current main (coordinate with #548 on `workflow-bindings.ts`). RED: fixture cases move to `covered`; other buckets unchanged.
- [ ] Port recognizers and seeds; regenerate intent docs; gates; review; commit; ship.
- [ ] Activation: approve the drafted source baseline by exact hash; rerun the corpus harness; record
  the measured covered number.

### PR-6 contextual intents

- [ ] Rebase after #509, #498 and PR-5 (coordinate with #548 on `workflow-bindings.ts`). RED: acceptance 1-8 of PR-6.
- [ ] Port seeds, confirmation consumption, reference hook, matcher/executor wiring; adapt to #509's
  merged gate API; reverse the lineage retirement with a recorded reason; paraphrase the regression
  sentence flagged in the preservation summary.
- [ ] Gates; review; commit; ship; approve the source baseline by exact hash; rerun the corpus harness.

## Outstanding acceptance of GH-334 (none checked yet)

Every GH-334 criterion stays open until its PRs are merged, deployed, activated where relevant, and
proven live (running version, real Opus job, measured coverage).

## Open questions for the owner

1. Learning sample scope: default is all users' requests, minimised and pseudonymised, sensitive
   tools excluded (the 2026-09-19 Opus classification already covered all 402 retained messages).
   Alternative: administrator-only samples.
2. Sequencing with #426: merge PR-1 before it so its seed deploy cannot empty the
   catalogue, or accept the current operator-rerun behavior for it.
3. "Three-way verification" is read as the three-answer comparison (historical, simulated intent,
   independent ideal) in a verify session separate from generation and assessment, not three
   separate reviewer sessions.
