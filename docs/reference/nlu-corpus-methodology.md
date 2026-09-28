# Offline NLU candidate corpus: methodology and limitations

`scripts/nlu_corpus.py` builds a private, source-grounded inventory of retained
chat history and debug logs, and produces **unvalidated candidate labels** for a
future intent/slot classifier. It never calls a network model and never
publishes anything beyond the aggregate `summary.json` counts. This document
describes what the tool actually does, what it deliberately refuses to do, and
the concrete next steps before any of its output can train or evaluate a
classifier. It supports GH-565 (source-safe historical replay) without
duplicating that ticket's larger model-log/dialogue-replay engine, which is
owned jointly with #554/#559/#562 (see "Relationship to GH-565" below).

## What it produces

For one `--root` (a bot data directory containing `data/*.db` and `logs/`),
`collect()` reads every retained SQLite snapshot and debug log it can safely
open, and `audit()` turns each user message into a **candidate record**:

```
{
  "schema_version": 2,
  "text_candidate": "...",            // pseudonymized text, not raw
  "intent_candidates": ["event.create"],  // weak regex labels, not gold
  "observed_tools": ["create_event"],     // tool calls the bot actually made
  "gold": null,                            // only ever set by an external import
  "gold_adjudication": null,               // last-seen adjudication, regardless of outcome
  "train_eligible": false,
  "label_status": "needs_adjudication",
  "privacy_status": "pseudonymized_candidate_needs_review",
  "outcome_status": "not_inferred_from_prose",
  ...
}
```

`observed_tools`/`observed_responses` describe what the bot actually did in
response, not what the user asked for or whether it was correct. Regex-based
`intent_candidates` are pattern matches, not a trained classifier's
predictions, and are never reported as accuracy.

## Privacy transformation

- Every free-text field is pseudonymized with `redact_candidate()`: URLs,
  emails, `@handles`, coordinates, and phone-number-shaped digit runs become
  `[KIND_<hmac>]` tokens; known contact/user names from the same database are
  redacted the same way. Calendar-shaped date literals survive redaction
  deliberately — both ISO `YYYY-MM-DD` and day-first `DD-MM(-YYYY)` (the
  latter checked with the same day/month range test the bot's own
  `NUMERIC_DATE_CANDIDATE_RE` in `src/bot/handlers/group-message-filter.ts`
  uses) are recognized before the phone-number-shaped digit-run rule would
  otherwise destroy them; they are needed to interpret compound requests and
  are not personally identifying on their own.
- Any row matching `AUTH` (an OTP/2FA/session/API-key pattern) is replaced
  outright with `[QUARANTINED_AUTH]`, and every other row in the same
  conversation within `SESSION_GAP_SECONDS` (1800s) of it is quarantined too
  (`quarantined_indices`), because a bystander reply near a credential prompt
  is not safe to assume is unrelated.
- All private output files (`selected.private.json`, `candidates.private.json`,
  `summary.json`, `pseudonym.key`) are created with `os.open(..., O_EXCL, 0o600)`
  in one syscall, never `open()` followed by a separate `chmod`. The earlier
  two-step version left a real (if narrow) window where the file existed at
  the process's default `umask`-derived mode before the follow-up `chmod`
  landed; the current version can never observe a wider-than-owner mode.

## Source-lineage and session-pairing safeguards

This is the part of the tool most exposed to a wrong causal claim, so it is
the most heavily tested:

- **Session boundary.** A gap of more than `SESSION_GAP_SECONDS` between two
  rows in the same conversation scope starts a new session and clears any
  in-flight candidate — a stale request from hours ago can never receive a
  reply row that arrives later.
- **Bridging-chain guard.** The above is not just a consecutive-gap check.
  `active_since` anchors the attachment window to the *triggering* user row's
  timestamp, not the previous row's, so a chain of individually-short gaps
  (each under 1800s) can no longer bridge an assistant/tool row in past 1800s
  from the actual request that opened the candidate.
- **Source-lineage binding.** Every row collected from a SQLite source carries
  a `source_refs` entry qualified by that file's own content hash
  (`path#sha256`), not just its name. An assistant/tool row is only ever
  attached to a candidate when it shares a recorded lineage with the
  triggering request. Two different database snapshots that happen to share a
  path (a live database and an old backup, or the same relative path across
  two servers) never look like one lineage. Ambiguous provenance (no recorded
  `source_refs` at all) is conservatively treated as detached, never attached.
- **Legacy archives.** A `--merge` input predating this lineage scheme (the
  older list-of-`{"row":...}` shape) is namespaced by that archive's own
  content digest *and* its row position, so it can never be treated as
  matching anything — including another row from the very same legacy
  archive. Pre-versioning data is explicitly unprovable, not silently trusted.
- **Merge schema binding.** A `--merge` input in the current dict shape must
  declare a matching `schema_version`; a mismatch raises rather than silently
  combining two incompatible candidate shapes. `--merge` inputs are read
  through the same symlink-rejecting, size-bounded reader `collect()` uses for
  its own sources.

Every row skipped by these guards is counted in `summary.json`
(`evidence_detached_unknown_provenance_rows`, `evidence_detached_stale_session_rows`,
`quarantined_auth_rows`, `invalid_timestamp_rows`) rather than silently dropped,
so coverage accounting stays honest about what was excluded and why.

## Input bounds

- `collect()` and `read_bounded_merge_archive()` open every source through
  `open_regular_bounded()`, which opens with `O_NOFOLLOW` and checks the
  *already-open descriptor* via `fstat` (regular file, under a byte ceiling)
  before any byte is read. `is_safe_source_file()` is a separate, faster
  path-based pre-check used only to produce an accurate `skipped_unsafe_path`
  inventory entry up front — it is not itself race-free (a plain
  check-then-open has a window where the path could be swapped to a symlink
  afterward). `open_regular_bounded()` is the actual security boundary: the
  kernel refuses the open outright if the final path component is a symlink
  at open time, so nothing can be swapped in between a check and a read.
- Both SQLite files (plain and gzip) and debug logs are capped at a fixed
  byte ceiling on the source file itself via that same `fstat` check, and gz
  sources are additionally capped on their *decompressed* size while
  streaming, since a small compressed file can still decompress unboundedly.

## Gold import: what exists and what does not

`validate_gold_record`/`apply_gold_import` are a pure, tested contract for
importing **externally adjudicated** gold — they never generate a label
themselves and never infer an expected outcome from the bot's own prior
response text. A gold record must carry:

- `source_ref` — binds to one specific candidate.
- `corpus_candidate_sha256` — a 64-character hex digest that must equal the
  exact `candidates.private.json` the reviewer actually looked at. Every run
  mints a fresh HMAC key, so `source_ref` pseudonyms (and the resulting
  `candidate_sha256`) are only ever valid against the one package a reviewer
  saw; this binding is what stops a freshly regenerated, differently-keyed
  package from silently absorbing someone else's adjudication.
- `reviews` — four **independent** entries, one each for `privacy`, `intent`,
  `slots`, `expected_outcome`, each with its own `reviewer_id` and
  `approved`/`rejected`/`needs_more_info` status. `train_eligible` only
  becomes true when all four are `approved`; a partial or rejected
  adjudication is recorded in `gold_adjudication` for the audit trail but
  never written into the `gold` field itself.

**Deferred, on purpose:** an end-to-end `--apply-gold` CLI mode that reads an
existing `candidates.private.json`/`summary.json` package, applies gold in
place, and rewrites it atomically. Building that now would mean designing
in-place atomic package rewriting, corpus-hash recomputation, and a durable
review workflow in the same bounded slice that just landed the pairing fixes
above — a second, separately reviewable piece of work. The validator and
importer functions are ready for it; the CLI wiring is the next gated step
(see below). **When it is built**, `corpus_candidate_sha256` binding must be
computed once, from the pre-adjudication `candidates.private.json` that
`collect()`+`audit()` originally produced, and never recomputed from a
post-import file: recomputing it after writing gold would let a *second*,
independently-adjudicated gold batch — bound to that same original
pre-adjudication package — incorrectly fail to match, because the file it
is compared against would have silently changed underneath it.

`apply_gold_import`'s report distinguishes `gold_fully_approved` (all four
review dimensions approved; this is what populates `gold` and sets
`train_eligible`) from `gold_partial_or_rejected_recorded` (bound and kept in
`gold_adjudication` for the audit trail, but never written into `gold`
itself) — a single combined "applied" counter would otherwise overstate how
much of a batch is actually validated, train-eligible gold.

## Current numbers (weak labels, not measured traffic truth)

The most recent safe aggregate summaries available in this session (captured
*before* the fixes in this change) reported, for the combined retained
inventory: 3838 rows, 962 user candidates, 516 quarantined auth rows, 1014
sources (57 SQLite, 956 debug logs, 1 legacy retained archive), 398 `unknown`
and 279 `dialogue.answer` weak labels. **`gold_count` is 0 and `train_eligible`
is 0** — nothing in this corpus is adjudicated, and nothing is train-eligible,
by design.

Those counts predate this change's session/lineage/permission/symlink fixes
and cannot be reused as-is: the corrected pairing logic will detach some
assistant/tool rows that the earlier version incorrectly attached (chained
short gaps, cross-snapshot collisions), and the symlink guard may report
additional `skipped_unsafe_path` sources. **The exact next gated step is to
rerun `scripts/nlu_corpus.py` against the same roots and republish a fresh
aggregate summary before anyone treats the label/tool counts as current.**
This was not done as part of this change because a full run reads the entire
retained log volume (several gigabytes) and regenerating it is a distinct,
independently-verifiable action from the code fix itself.

## Limitations

- Regex `intent_candidates` are unvalidated hypotheses, not a trained
  classifier's accuracy.
- Pseudonymization is not an anonymity guarantee; every free-text record still
  needs a privacy review before any external use.
- Database and debug-log records may overlap; source counts are not unique
  Telegram updates.
- Historical permissions, entity state, and timezone are not reconstructed —
  `historical_state` is always `not_reconstructed`.
- Auth-window quarantine is a conservative blast radius, not a fix for the
  underlying ingress logging issue that put credentials in chat history.
- Assistant/tool attachment is deliberately conservative: legitimate
  continuations that happen to cross a snapshot boundary (e.g. a conversation
  whose tail only survives in a different backup than its head) are reported
  as detached rather than risk stitching two inconsistent snapshots together.
- No causal replay, dialogue-state reconstruction, or full/medium/short
  evaluation pack is implemented here — that is GH-565's broader scope, owned
  jointly with #554/#559/#562's dialogue/reference contracts.

## Relationship to GH-565 and the parallel `/add`/quality work

This tool is the scoped "offline NLU inventory and candidate-label audit"
referenced in the 2026-09-28 08:56 UTC comment on #565. It intentionally does
not implement a second model-log/dialogue-replay engine — GH-565's causal
episode reconstruction, full/medium/short packs, and gold-label specification
for required final state remain with the dialogue contract owners (#554,
#559, PR562). The parallel answer-release-quality work in PR584 (`GH-566`:
`answer-quality.ts`, `model-qualification.ts`, `verified-reply.ts`) is a
separate concern (bounding what a *live* LLM reply is allowed to send) and is
not modified, read as gold, or duplicated by this corpus tool; its
hash-binding pattern for qualification evidence is the same idea this file's
`corpus_candidate_sha256` binding reuses, applied to the corpus side instead.

## Next steps

1. Rerun `scripts/nlu_corpus.py` against the retained roots under the fixed
   session/lineage/permission/symlink logic and publish a fresh aggregate
   summary before anyone reads current label/tool counts as authoritative.
2. Build the deferred `--apply-gold` package-rewrite CLI once a reviewer
   workflow exists to produce real `reviews`-shaped gold records, reusing
   `validate_gold_record`/`apply_gold_import` unchanged.
3. Coordinate with the #554/#559/#562 dialogue-contract owners before any
   causal episode reconstruction is attempted on top of this candidate
   inventory, so GH-565's full/medium/short packs stay one versioned corpus
   rather than a second implementation.
