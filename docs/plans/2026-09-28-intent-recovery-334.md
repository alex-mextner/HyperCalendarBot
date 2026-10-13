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

**Recon (private, never in git):** the 2026-09-27 recon (preservation summary, state map, evidence
audit reproducing 18/402 matcher-only matches, revision-spec review, orchestrator verification) lived
in the gitignored `logs/` of the former development Mac checkout. Only its conclusions are recorded
here and in the specs.

## Global constraints

- Priority order: data integrity and security, then reliability, then coverage and features.
- Port source is the dirty, never-tested `intent-evolution-release-20260919` snapshot (read-only);
  every port applies the fixes named in the specs. The 2026-09-19 code is not copied wholesale.
  The 2026-09-19 branches named in these specs were deleted on 2026-10-07 and are preserved in the
  recovery bundle 2026-10-07: `intent-evolution-release-20260919` at `d3e9275a`,
  `cc-intent-worker-20260919` at `80c604bb`, `intent-learning-service-20260919` at `2a99f86c`.
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
| 1 | PR-1 | Revision ledger and exact admin approval | see "PR-1 files" below | none | Scope 2, acceptance 1-17 |
| 2 | PR-0 | Simulator, coverage harness, methodology, synthetic fixtures | `src/services/intent/simulation/*` (new), `scripts/intent-simulate.ts` (new child-process runner), `scripts/intent-coverage.ts` (new), `test/fixtures/intent-corpus/synthetic-cases.json`, `docs/intents/coverage-methodology.md` | PR-1 (merge order only; no code dependency) | Scope 5, PR-0 1-6 |
| 3 | PR-5 | Event reference store, migration 066, time primitives, bounded title lookup | `src/database/migrations.ts` (append 066), `docs/reference/migrations/066_event_references.md`, `src/services/intent/{event-reference-store,event-time,wall-clock}.ts` (new), `src/database/repositories/event.repository.ts` (`findByTitleFolded` only) | PR-1 (migration order) | Scope 1, PR-5 1-11 and 5a |
| 4 | PR-2 | Learning service, sidecar store, HTTP API, admin CLI | `src/services/intent-learning/*` (new), `src/web/intent-learning.ts` (new), `src/web/server.ts` (route registration hunk), `src/config/env.ts` (4 vars), `scripts/intent-learning-admin.ts` (new), `docs/intents/learning-service.md` (new) | PR-1, PR-0 | Scope 3, PR-2 1-11 |
| 5 | PR-3 | Mac worker, evidence MCP, LaunchAgent installer | `scripts/intent-worker.py`, `scripts/intent-worker-evidence.py`, `scripts/install-intent-worker.py`, `test/python/test_intent_worker*.py`, `test/web/intent-worker-contract.test.ts`, `docs/intent-worker.md` | PR-2 | Scope 4, 1-6 + contract test |
| 6 | PR-4 | Live wiring and Telegram admin commands | `src/bot/pipeline/ai-agent-layer.ts`, `src/index.ts`, `src/bot/index.ts`, `src/config/constants.ts` (admin strings), `src/services/feature-tracking.ts`, `src/bot/commands/intent-admin.ts` (new) | PR-1, PR-2; rebase after #508/#509 (`constants.ts`) | Scope 3, PR-4 1-4 |
| 7 | PR-7 | Natural entry recognizers and seeds | `src/services/intent/{natural-entry,seed-natural}.ts` (new), `seed-catalog.ts`, `workflow-bindings.ts`/`workflow-validator.ts` (natural hunks), `docs/intents/*` regenerated | PR-1, PR-0; rebase coordination with #548 | Scope 5, PR-7 1-2 |
| 8 | PR-6 | Contextual seeds, confirmation consumption, wiring | `src/services/intent/seed-contextual.ts` (new), `seed-catalog.ts`, `seed-lineage.ts`, `workflow-bindings.ts` (eventref context), `intent-executor.ts`, `src/bot/pipeline/intent-matcher-layer.ts`, `src/bot/handlers/message.handler.ts`, `src/services/ai/tool-executor.ts` (reference hook), `src/database/repositories/workflow-session.repository.ts` (optional `threadId` in session data), `docs/intents/*` | PR-1, PR-5, PR-0, #509, #498; rebase coordination with #548 | Scope 1, PR-6 1-8 |

PR-1 files (as planned; what shipped differs as listed under "PR-1 revision ledger"):

- `src/database/migrations.ts` (append 065)
- `docs/reference/migrations/065_intent_revisions.md`
- `src/database/repositories/intent.repository.ts`
- `src/database/repositories/intent-revision.repository.ts` (new)
- `src/database/repositories/workflow-session.repository.ts` (`liveIntentIds`)
- `src/services/intent/{registry,rule-fingerprint,revision-body,revision-validator,revision-ledger,revision-service}.ts` (new; exact split decided by the implementer)
- `src/services/intent/seed-replacement.ts`
- `scripts/generate-intent-docs.ts` and `scripts/replay-intent-corpus.ts` (fingerprint import only)
- `test/helpers/intent-registry.ts` (new)
- `src/services/intent/intent-executor.ts` (`revisionGuard` only)
- `scripts/replace-intent-basis.ts`
- `scripts/intent-revisions.ts` (new CLI)
- `docs/intents/engine.md` (managed-basis paragraph)

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

Done: merged in PR #575 as `e8dfbc3bb58e4383edfcb5b6c0dd435adf411b36` and deployed; issue #555 closed
against the six acceptance criteria in its issue body, each checked with proof. Deployed on
2026-09-28T05:16Z; a read-only production check then showed exactly one active `source_baseline`
revision matching the installed manifest and 52 approved rules still loading. No new rules were
activated: the administrator approval route does not exist yet (#558). Review follow-ups: #577. The spec's PR-1 acceptance 1-17 was not re-audited item by item; what
shipped differs from the PR table row above in these known ways:

- The run guard shipped as `src/services/intent/rule-run-guard.ts`, used by the matcher layer and
  by scheduled/trigger runs (`synthetic-intent-run.ts`), not as a `revisionGuard` in
  `intent-executor.ts`.
- `scripts/intent-revisions.ts` (operator list/show/approve/reject CLI) was not built. No production
  route calls propose, revise, reject or approve; the administrator approval route belongs to #558.
- The per-rule compatibility skip (spec acceptance 11) is not implemented; it stays with the
  executor slice (#498) and is tracked with the other deferred review findings in #577.
- The startup wiring that records the source-baseline draft (`ensureSourceBaselineDraft` in
  `src/bot/index.ts`, a file the table assigns to PR-4) shipped in PR-1. It only drafts; it never
  approves or activates. Its startup test is still missing (#577 item 8, with PR-4).
- `scripts/replace-intent-basis.ts` on a managed database calls `recordOperatorBaseline`
  (`src/services/intent/revision-ledger.ts`): it moves the manifest and supersedes the active
  revision directly instead of approving the drafted source baseline with an operator principal as
  the revisions spec's "Source baseline flow" describes (#577 item 4, source-baseline slice).
- PR-1 also changed two files the table assigns to later slices: `src/index.ts` (PR-4; it now only
  wires the intent module) and `src/bot/pipeline/intent-matcher-layer.ts` (PR-6; run-guard wiring
  `guardRuleTools`). PR-4 and PR-6 keep that code.

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

- [ ] RED: acceptance 1-11 and 5a in the scope 1 spec, one test each; migration 066 plus doc.
- [ ] Port and fix the store (snapshots, statuses `stale`/`none`, reply mapping, bounded retention);
  `event-time.ts`/`wall-clock.ts` with DST cases; cursor-bounded `findByTitleFolded`.
- [ ] Gates; review; commit; ship.

### PR-2 learning service

- [ ] RED: acceptance 1-11 of the learning-service spec (auth separation on production routes first).
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
- [ ] Wire capture (keep `toolCalls.length > 0` and no-`ask_user` guards), admin commands with `t(lang)` strings, `COMMAND_FEATURE_MAP`. (The startup
  `ensureSourceBaselineDraft` call already shipped in PR-1, `src/bot/index.ts`.)
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
2. Settled: PR-1 merged first (PR #575), so a seed deploy for #426 no longer empties the
   catalogue.
3. "Three-way verification" is read as the three-answer comparison (historical, simulated intent,
   independent ideal) in a verify session separate from generation and assessment, not three
   separate reviewer sessions.
