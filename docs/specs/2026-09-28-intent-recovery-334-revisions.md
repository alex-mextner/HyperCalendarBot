# GH-334 Scope 2: intent revision ledger and exact administrator approval

Status: draft, independent review incorporated (2026-09-28). Task: GH-334. Implemented by PR-1
(ledger); consumed by PR-2 (learned proposals, admin HTTP routes), PR-4 (Telegram admin commands),
PR-6/PR-7 (new source baselines). External dependents and the #548/#426 distinction: see "PR table and merge order" in
`docs/plans/2026-09-28-intent-recovery-334.md` (single source for that rationale).
Related: `docs/intents/engine.md` (managed basis), `docs/specs/2026-09-18-workflow-v2.md` (typed
workflows), `scripts/replace-intent-basis.ts` (operator seed replacement).

## Problem

`IntentRepository.getApproved()` (`src/database/repositories/intent.repository.ts`, lines 53-70 on
main 7399876e) returns the approved rows only when three fingerprints agree: the installed
`intent_basis_manifest`, the rows themselves, and the source seed compiled into the running build.
Any difference returns an empty list, silently. Two consequences:

1. **No approved change is possible.** Every write method throws `INTENT_BASIS_READ_ONLY`; the only
   path is a new source seed plus an operator-run `replace-intent-basis.ts`. Manual and learned rules
   cannot exist.
2. **Any seed-touching deploy disables every rule.** `docs/intents/engine.md` states it: a build whose
   seed differs from the installed manifest runs with zero intents until an operator reruns the
   replacement. #426 (with PR #394) changes a serialized seed workflow and is therefore exposed.

Production on 2026-09-27 (read-only check recorded in the private checkpoint): managed basis,
52 approved rows, `getApproved()` returns 52.

## Decisions

- **The ledger lives in the main database** (`calendar.db`), migration `065_intent_revisions`
  (064 is taken by PR #464; 065 is unused on origin/main and in every open PR as of 2026-09-28;
  recheck before merge). Reasons: `getApproved()` is the load-bearing reader; `scripts/backup-db.sh`
  backs up only `calendar.db`; ledger and `intents` in one file make activation one `IMMEDIATE`
  transaction. The 2026-09-19 sidecar ledger (`intent-learning/ledger.ts`) is not ported.
- **Runtime acceptance never depends on the build's source fingerprint.** A build whose seed differs
  from the active revision keeps running the active revision. "New code merged" never counts as a
  changed active catalogue.
- **Integrity is fail-closed and checked everywhere it matters**: at runtime load, before the
  migration backfill, before every proposal is based on the registry, and inside every approval
  transaction before anything is written.
- **Revisions are immutable rows.** Editing inserts a new row naming its predecessor; the predecessor
  becomes `superseded`. An approval names one row id and its exact body hash.
- **No silent rebase.** If the active revision moved after validation, approval refuses with
  `conflict`; a rebased draft (new hash) needs its own approval.
- **Authority comes from the authenticated principal, never from request data.** `author` and
  `decided_by` are set by the server from the principal; a body field cannot change them.
- **Per-rule compatibility at load.** A stored rule that the current code cannot parse or validate
  (`WorkflowSchema` + `validateWorkflow`) is skipped individually, logged, and reported to the
  administrator once per fingerprint. Integrity (rows versus manifest versus ledger) stays
  all-or-nothing.

## State invariant

`registryIntegrity(db)` computes, for a managed database (manifest row present):

```
R = fingerprint(intents WHERE status='approved')   -- raw rows, parsed through codecs; unparseable => broken
M = intent_basis_manifest.fingerprint
A = intent_revisions.target_fingerprint WHERE status='active'
B = fingerprint(body of the active revision)        -- the active row's stored rule set
intact  <=>  R == M == A == B, and exactly one active revision exists
```

A partial unique index enforces at most one active revision. Outcomes:

| Condition | `getApproved()` | Proposal / approval |
| --- | --- | --- |
| No manifest (fresh dev/test DB) | approved rows as today | refused `unmanaged` |
| `R` unparseable or `R != M` | `[]` + error `intent_registry_tampered` | refused `registry_tampered`, nothing written |
| no active revision, or `M != A`, or `A != B` | `[]` + error `intent_registry_unledgered` | refused `registry_unledgered`, nothing written |
| intact | approved rows minus per-rule validation failures | allowed |

The comparison with `seedFingerprint(this.canonicalSeed)` is removed from `getApproved()`.

## Schema (migration 065_intent_revisions)

```sql
CREATE TABLE intent_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('source_baseline','manual','learned')),
  status TEXT NOT NULL CHECK (status IN ('draft','validated','active','superseded','rejected','conflict')),
  parent_id INTEGER REFERENCES intent_revisions(id),
  base_fingerprint TEXT,           -- active target when validated; NULL for the backfilled row
  target_fingerprint TEXT,         -- fingerprint of the full rule set after this revision; NULL while invalid
  body_hash TEXT NOT NULL,         -- sha256 of the canonical JSON body
  body TEXT NOT NULL,              -- RevisionBody JSON
  validation TEXT,                 -- JSON: errors, or the plan summary incl. dropped rules
  author TEXT NOT NULL,            -- server-set: 'migration' | 'operator' | 'admin' | 'learner:<jobId>' | 'source:<fp16>'
  created_at INTEGER NOT NULL,
  decided_by TEXT,                 -- server-set: 'telegram:admin' | 'bearer:admin' | 'operator_cli'
  decided_at INTEGER,
  decision_reason TEXT
);
CREATE UNIQUE INDEX idx_intent_revisions_one_active ON intent_revisions(status) WHERE status = 'active';
CREATE INDEX idx_intent_revisions_status ON intent_revisions(status, id);
```

**Backfill** in the same migration, only when `intent_basis_manifest` exists **and** the raw approved
rows parse and fingerprint exactly to the manifest (`R == M`): insert one row
`kind='source_baseline', status='active', author='migration'`, `target_fingerprint = M`, `body` = the
current approved rule set, and assert `fingerprint(body) == M` before the insert. Otherwise
(tampered or unparseable rows) insert nothing; the migration itself succeeds and never throws on bad
row JSON; the registry then loads `[]` exactly as main does today for a broken registry, and the
operator repairs it with `replace-intent-basis.ts`. The backfill never consults the build's source
seed, so the merge order of PR-1 relative to #426 does not matter.

Required doc: `docs/reference/migrations/065_intent_revisions.md` (what, why safe, rollback, verify).
Rollback: an older binary ignores the table; while the active revision still equals the older build's
source seed it behaves as before; after any other activation it loads `[]` (fail closed, the AI path
answers everything), never crashes.

## Revision body

```ts
type DraftRule = { canonical_name: string; pattern: string; workflow: JsonObject; phrases: string[];
  trigger_words: string[]; source_message: string; format: 'text' };
type ExampleDisposition = {
  example: string;                                  // a positive example of a removed or replaced rule
  disposition: 'covered_by' | 'handled_by_ai' | 'unsafe_removed';
  coveredBy?: string;                               // required for covered_by: a rule name in the target set
  note: string;                                     // non-empty justification
};
type RevisionOperation =
  | { kind: 'create'; sourceNames: []; intents: [DraftRule, ...DraftRule[]]; reason: string }
  | { kind: 'generalize'; sourceNames: [string]; intents: [DraftRule]; reason: string; dispositions: ExampleDisposition[] }
  | { kind: 'consolidate'; sourceNames: [string, string, ...string[]]; intents: [DraftRule]; reason: string; dispositions: ExampleDisposition[] }
  | { kind: 'retire'; sourceNames: [string, ...string[]]; intents: []; reason: string; dispositions: ExampleDisposition[] };
type RevisionBody =
  | { type: 'operations'; summary: string; operations: RevisionOperation[] }  // manual, learned; a batch
  | { type: 'replace_all'; summary: string; rules: DraftRule[] };            // source_baseline only
```

Bounds: at most 16 operations and 32 rules per `operations` body; `replace_all` at most 256 rules.
Every affected active name appears in exactly one operation.

## Validation (`validateRevision`)

Ported from `intent-evolution-release-20260919/src/services/intent-learning/proposal-validator.ts`
with: anchored `^...$` pattern without nested quantifiers; `WorkflowSchema` parse and
`validateWorkflow` pass; each draft's positive examples route uniquely to it through a real
`IntentMatcher` loaded with the full target set; no example of an unaffected rule changes route;
known negative examples do not route to any draft; `learned` and `manual` rules cannot use the
`basis.` namespace; names held by non-approved rows are reserved.

**Example preservation and retirement.** Every positive example of every removed or replaced rule
must be either still routed to a replacement draft in the target set, or listed in that operation's
`dispositions` exactly once:
- `covered_by`: the example must route to `coveredBy` in the target set (checked);
- `handled_by_ai`: the example must route to no rule in the target set (checked; it will reach the AI
  path);
- `unsafe_removed`: the example must route to no rule; `note` must say why the old behavior is unsafe.
There is no global bypass flag. A `retire` without a disposition for each example fails validation.
The dispositions are shown to the administrator in the review.

**`replace_all` (source baseline) validation** additionally computes, against the active revision,
the lists `dropped` (active names absent from the source set, grouped by the kind of revision that
introduced them: `learned`, `manual`, `source_baseline`), `added` and `changed`, stores them in
`validation`, and marks the draft `validated` only if the source set passes the checks above except
example preservation for dropped rules (those are listed, not silently accepted: the administrator sees
every learned/manual rule the baseline would drop before approving).

Validation runs at `propose`/`revise` time **and again inside the approval transaction**.

## Service API (`src/services/intent/revision-service.ts`)

```ts
declare const adminBrand: unique symbol;
export interface AdminPrincipal { readonly via: 'telegram' | 'bearer' | 'operator_cli'; readonly [adminBrand]: true }
export function adminFromTelegram(fromId: number, configuredAdminId: number | undefined): AdminPrincipal | null;
export function adminFromOperatorCli(): AdminPrincipal;     // imported only by scripts/
// The bearer principal is minted only in src/web/intent-learning.ts (PR-2) after a constant-time
// comparison with a configured INTENT_ADMIN_TOKEN; with no valid admin token configured it is never minted.

export class IntentRevisionService {
  constructor(db: Database, deps: { sessions: WorkflowSessionRepository; now?: () => number; logger?: Logger });
  propose(body: RevisionBody, source: { kind: 'manual'; principal: AdminPrincipal } | { kind: 'learned'; jobId: string }): IntentRevision;
  revise(principal: AdminPrincipal, id: number, body: RevisionBody): IntentRevision;
  ensureSourceBaselineDraft(seed: readonly CanonicalSeed[]): IntentRevision | null;  // never activates
  approve(principal: AdminPrincipal, id: number, expectedHash: string): ApproveResult;
  reject(principal: AdminPrincipal, id: number, reason: string): IntentRevision;
  list(filter?: { status?: RevisionStatus }): IntentRevision[];
  get(id: number): IntentRevision | null;
  activeRevisionId(): number | null;
}
export type ApproveResult =
  | { status: 'active'; revisionId: number; targetFingerprint: string; removed: string[]; inserted: string[] }
  | { status: 'refused'; code: 'not_found' | 'not_validated' | 'hash_mismatch' | 'invalid' | 'conflict'
      | 'registry_tampered' | 'registry_unledgered' | 'unmanaged' | 'session_active' | 'session_unreadable' };
```

`approve` requires `expectedHash === body_hash` (full 64 hex; the Telegram command may accept a
16+ hex prefix that it expands against exactly one row and echoes in full). One `IMMEDIATE`
transaction, in this order, with no write before step 5:
1. `registryIntegrity(db)` intact, else refuse (`registry_tampered` / `registry_unledgered`).
2. Row exists, `status='validated'`, hash matches, and `base_fingerprint == A`; otherwise refuse.
   For a stale base the row is marked `conflict` afterwards in a separate transaction that touches
   only that revision row.
3. Revalidate against the live registry.
4. Live-session guard (below).
5. Delete affected rows, insert drafts as `approved`, verify `fingerprint(rows) == target_fingerprint`,
   move the manifest, mark the old active revision `superseded`, mark this row `active`, set
   `decided_by/decided_at` from the principal.
Any failure rolls back everything; intents, manifest and revision statuses are then unchanged.

The repository write methods keep throwing `INTENT_BASIS_READ_ONLY`; only this transaction mutates a
managed registry.

## Live workflows versus activation

**Persisted (awaiting the user).** `WorkflowSessionRepository` stores the whole `workflow` snapshot
and `intentId` in `data`, with `TTL_MS` = 5 minutes and "expired when `now - created_at >= TTL_MS`".
PR-1 adds `WorkflowSessionRepository.liveIntentIds(now): { intentIds: Set<number>; unreadable: number }`
that reuses the same `TTL_MS` constant, the same expiry predicate and the same `WorkflowSessionCodec`
(no duplicated literal or schema). Approval refuses `session_active` when an affected intent id is live.
A live row whose full data fails to decode is read again with a minimal `{ intentId: number }` codec;
if that yields an id, the row counts for that id only; only a live row whose `intentId` itself cannot
be read blocks every approval with `session_unreadable` (its intent is unknown; fail closed; the row
expires within the TTL). The helper catches nothing silently: decode failures are counted, never thrown.

**Resumed and in-flight executions.** A run keeps the immutable workflow it matched (the session
snapshot, or the rule object captured at match time for a run awaiting a tool read), so activation
never changes which workflow a resumed execution runs. Before every mutation step the executor calls
`revisionGuard(intentId, workflowHash)`, which is true only when the active revision still contains a
rule with that id and an identical workflow hash. When false, the run stops before the mutation with
write outcome unchanged (`none` if nothing was written yet, otherwise the existing `applied`/`unknown`,
which are never replayed) and tells the user the rule changed and nothing further was done. Tool
handlers keep applying the current access checks on every call. Sessions created before PR-1 carry no
revision id; the hash comparison covers them.

## Source baseline flow

- Startup (wired in PR-4) calls `ensureSourceBaselineDraft(seedIntents)`. When the build's seed
  fingerprint differs from `A`, it inserts one validated `source_baseline` draft per body hash
  (idempotent) and queues one admin notice. It never approves or activates. Active approved rules
  keep running unchanged.
- The draft's review shows `dropped` (with learned/manual rules listed by name), `added`, `changed`.
- `scripts/replace-intent-basis.ts`: first install (unmanaged to managed) keeps its backup and
  fingerprint procedure and records the backfilled active revision in the same transaction; on a
  managed database it approves the drafted baseline with an operator principal (still requires
  `--expect <body hash>` and a new `--backup`), subject to the same integrity checks.

## Draft editing and future web editor

Any client (Telegram command, admin bearer API, CLI, a future web editor) calls `propose`/`revise`.
None writes `intents` directly. No editor UI is built here.

## Acceptance (PR-1)

All tests use real `bun:sqlite` databases with `runMigrations`, real `IntentMatcher`,
real `WorkflowSessionRepository`. Test file `test/regressions/intent-revision-ledger.test.ts` unless
named otherwise.

1. `source-only deploy keeps the active catalogue` (RED on main): managed DB, 52 rows, manifest `X`,
   repository built with a seed of fingerprint `Y != X` -> `getApproved()` returns 52; revision rows
   unchanged except at most one new `source_baseline` draft after `ensureSourceBaselineDraft`.
2. `startup never activates a source baseline`: after `ensureSourceBaselineDraft`, the active revision
   id, manifest and rows are identical; calling it twice creates one draft.
3. `source baseline lists dropped learned rules`: with an active learned rule absent from the source,
   the draft's `validation.dropped.learned` names it.
4. `approve activates exactly the validated revision`: after approving a `generalize`, rows, manifest
   and active target all equal the draft's target; the previous revision is `superseded`.
5. `revise supersedes without changing behavior`; approving the superseded id -> `not_validated`;
   approving with the old hash -> `hash_mismatch`; wrong id -> `not_found`.
6. `stale base refuses`: two drafts on one base; approve A -> active; approve B -> `conflict`, rows
   unchanged.
7. `tamper before backfill` (`test/database/migrations-065.test.ts`): a DB at migration 064 with one
   approved row edited so `R != M`; running 065 inserts no revision, does not throw, and
   `getApproved()` returns `[]`; unparseable row JSON behaves the same.
8. `tamper after proposal before approval`: propose on an intact registry, then UPDATE one affected
   row directly; approve -> `registry_tampered`; rows, manifest and every revision status unchanged.
9. `tampered unaffected rule`: same, but the edited row is not touched by the revision; approve ->
   `registry_tampered`, nothing changed.
10. `ledger mismatch fails closed`: active target edited to differ from the manifest -> `getApproved()`
    returns `[]` and approve refuses `registry_unledgered`.
11. `per-rule incompatibility skips one rule`: one stored workflow fails current validation -> 51 load.
12. `live session guard`: sessions at `created_at = now - TTL_MS + 1` (live) and `now - TTL_MS`
    (expired) around an affected intent -> refuse and allow respectively; a live row with corrupt
    workflow data but a readable `intentId` of an affected intent -> `session_active`; a live row whose
    `intentId` is unreadable -> `session_unreadable`; no exception in either case; the guard reads `intentId` from the stored schema.
13. `resumed workflow of a changed rule stops before mutation`: a session suspended on a delete rule;
    approve a revision that generalizes that rule; resume with "yes" -> no `delete_event` call, outcome
    `none`, user told nothing was done. An unaffected rule's session resumes normally.
14. `in-flight run stops before mutation`: a run blocked in a read tool (deferred promise) while a
    revision retiring its rule is approved; releasing the read -> no mutation tool call.
15. `retire requires dispositions`: a retire without dispositions fails; with `handled_by_ai` for an
    example that still routes to another rule fails; with correct dispositions validates.
16. `principal gates`: `adminFromTelegram(other, admin)` and `adminFromTelegram(id, undefined)` are
    `null`; `propose` ignores any `author` field inside the body.
17. Migration test: 065 applies on an unmanaged DB with no rows inserted; `docs/reference/migrations/
    065_intent_revisions.md` exists (deploy schema gate).

Production-route acceptance for worker/admin separation (finding 5 of the independent review) is
owned by PR-2 (HTTP) and PR-4 (Telegram) and listed in the learning-service spec: worker token cannot
approve, reject, propose manual, retry or purge; there is no worker-reachable replace or source-reset
route; a missing or invalid admin token configuration denies every admin route; admin tokens are
compared in constant time; wrong id, hash or stale base refuse without mutation; `author` in a body
never decides authority.
