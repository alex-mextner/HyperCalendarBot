# Intent learning service

Server-managed learning of new intent rules. Workers (Claude Code sessions) generate and review
proposals; only the configured admin (`BOT_ADMIN_ID`) or the admin bearer can change the active
registry. Code: `src/services/intent-learning/`, route `src/web/intent-learning.ts`, operator CLI
`scripts/intent-learning-admin.ts`.

## Storage

- Sidecar SQLite `<DATABASE_PATH>.intent-learning.sqlite`, mode 0600, WAL: samples, jobs, stage runs,
  artifacts, proposals, revision ledger, persisted rate bucket, audit, admin outbox. No calendar migration.
- Active intents stay in the main database `intents` table and `intent_basis_manifest`.
- The shipped seed stays the versioned source baseline. The active registry may evolve through
  admin-approved revisions; `IntentRepository.getApproved()` loads a managed registry when the rows
  fingerprint to the manifest AND the manifest is either the source seed or the target of an
  `activating`/`active` ledger revision. Any other drift loads nothing.

## Activation

`approve(id, expectedHash)` (hash or a 16+ hex prefix) re-validates against the live registry, writes
an `activating` ledger row, then runs one main-database `IMMEDIATE` transaction
(`IntentRepository.applyRegistryRevision`): base fingerprint and manifest compare-and-swap, affected
rows removed, drafts inserted, target fingerprint verified, manifest moved. Recent workflow sessions
(5 minutes) on affected intents refuse the activation. A moved base is accepted only when every
affected rule is unchanged (rebase); otherwise the proposal becomes `conflict`. Recovery only
reconciles the sidecar by fingerprint and never writes the main database or restores a backup.

## HTTP protocol `/admin/intent-learning/v1`

Bearer tokens: worker and admin are separate secrets of at least 32 characters and must differ from
each other and from `ADMIN_ALERT_TOKEN` (otherwise every route answers 503). JSON POST only (except
`GET /schema`, `GET /status`), body at most 1 MiB, `Cache-Control: no-store`, no CORS headers.

| Route | Role | Body | Result |
| --- | --- | --- | --- |
| `POST /claim` | worker | `{workerId}` | 204 (+`Retry-After`) or `{jobId, leaseToken, stage, round, model: 'claude-opus-5', permissionMode: 'auto', payload, deadlineAt}` |
| `POST /heartbeat` | worker | `{jobId, leaseToken}` | `{leaseExpiresAt}` |
| `POST /result` | worker | `{jobId, leaseToken, sessionId, artifact}` | stage outcome |
| `POST /failure` | worker | `{jobId, leaseToken, errorClass, retryAfterMs?}` | `{outcome: 'deferred', dueAt, pausedUntil}` or a quality outcome |
| `POST /evidence` | worker | `{jobId, leaseToken, kind: samples/catalog/operations/log-summary, limit?}` | job-scoped data |
| `GET /schema` | both | none | JSON Schema of `proposal` and `review` artifacts |
| `POST /enqueue` | admin | interaction, or `{kind: 'corpus', sampleIds}` | enqueue result |
| `POST /proposals` | admin | `{action: 'list', status?}`, `{action: 'get', id}`, `{action: 'create', proposal}` | proposals |
| `POST /approve` | admin | `{id, expectedHash}` | `{status: 'active', ...}` |
| `POST /reject` | admin | `{id, reason?}` | `{status: 'rejected'}` |
| `GET /status` | admin | none | queue, rate, awaiting proposals, revisions, registry (no secrets) |

Errors: `{error, message, details}` with 401/403/404/405/409/413/415/422/503.

## Worker rules

- Stage `generate` returns a `proposal` artifact, stage `verify` a `review` of `payload.proposal.hash`.
- Every stage uses a new `sessionId`. Retrying the identical body after a lost response returns the
  recorded outcome; any other reuse of a session is refused.
- Both artifacts compare every id in `payload.requiredSampleIds` exactly once. `previousAiResponse` is
  replaced by the stored answer. `intentResponse` and `idealResponse` are model judgment, not execution.
- A review `pass` reaches the admin only with no findings, full coverage and native validation of both
  the generator's and the reviewer's comparisons. Three failed rounds end in `needs_admin_revision`.
- Transient classes (`quota`, `auth`, `token`, `network`, `timeout`, `rate_limit`, `server`) defer with
  backoff 15 min .. 12 h (never below `retryAfterMs`) and never consume a round; `quota`, `auth`, `token`
  and `rate_limit` pause all claims. `invalid_output` consumes a round.
- Defaults: 1 concurrent lease, 2 starts/minute, 12/hour, 48/day, lease 15 minutes extended by heartbeat.

## Proposal validation

Operations: `create` (0 sources → 1+ rules), `generalize` (1 → 1), `consolidate` (2+ → 1), `retire`
(1+ → 0); at most 16 operations and 32 rules; every affected active name exactly once. Every draft,
whatever its name, needs an anchored `^...$` pattern without nested quantifiers, an explicit workflow
v2 that passes `validateWorkflow`, examples that route uniquely to it, no lost examples of unaffected
rules, full coverage of replaced examples, and no known negative example routing to it. New rules
cannot enter the `basis.` namespace; custom names do not get the matcher's strict-structure mode, so
the anchored pattern is their whole-message guarantee.
