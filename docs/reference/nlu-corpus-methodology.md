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
- Any row matching `AUTH` (an OTP/2FA/session/API-key pattern, or one of the
  connect wizard's phone and code prompts, which name no credential term; a
  test checks every credential prompt in both languages), holding
  `[redacted: connect wizard input]` (the marker chat logging has stored for
  Telegram-connect wizard input since #617/#641) or whose text is not a string
  (it may hold either) opens the auth quarantine. So does a debug-log run whose
  logged block (message, history, tool calls, reply) matches one of these or
  whose reply is not a string, even in a merged archive that kept only its
  reply (`response`): before #617
  a cancelled wizard handed its text to the AI, and the debug log may be the
  only copy left. The quarantine works like this:
  a candidate text matching `AUTH` is replaced outright with
  `[QUARANTINED_AUTH]`, and every row in the same conversation within
  `SESSION_GAP_SECONDS` (1800s, also the wizard's idle expiry) of it is
  quarantined too (`quarantined_indices`), because a bystander reply near a
  credential prompt is not safe to assume is unrelated. However late it comes,
  the first typed user text after a bot message that opens the window or lies
  inside it is quarantined as well, with the bot's turn after it (every bot row
  up to the user's next message): the connect-wizard guard (#641) treats that
  text as the answer to the prompt of an expired wizard, and before #641 it went
  to the AI, whose reply could quote it. Any bot message inside the window
  counts, since it may be a prompt. So
  the first message after every auth window is dropped even when it is
  unrelated. Finally, every row of the conversation repeating a quarantined
  user text is quarantined (such as the debug log's copy of a database row),
  which also drops that user's other identical short replies.
- **The raw export holds no connect-wizard input** (GH-721).
  `selected.private.json` is written by `raw_export()`, not copied from the
  sources. Backups taken before the #617 fix (2026-09-28) still hold what users
  typed into the wizard: phone number, login code, 2FA password (GH-519). No row
  of the auth quarantine is exported, from any source: live databases,
  `*.db.pre-*` copies, `backups/*.db.gz`, debug logs and `--merge` archives.
  Every kept row's free text (`content`, `response`) goes through
  `redact_candidate()`. Only the identifier and structure fields a later
  `--merge` needs are kept, each with the shape `collect()` gives it; a row that
  cannot be placed in time or has another shape is left out (fail closed).
  `summary.json` counts both (`raw_export_quarantined_rows`,
  `raw_export_omitted_rows`).
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
`quarantined_auth_rows`, `invalid_timestamp_rows`, `raw_export_quarantined_rows`,
`raw_export_omitted_rows`) rather than silently dropped,
so coverage accounting stays honest about what was excluded and why.

## Input bounds

- `collect()` and `read_bounded_merge_archive()` open every source through
  `open_regular_bounded()`, which opens with `O_NOFOLLOW` and checks the
  *already-open descriptor* via `fstat` (regular file, under a byte ceiling)
  before any byte is read. `is_safe_source_file()` is a separate, faster
  path-based pre-check used only to produce an accurate `skipped_unsafe_path`
  inventory entry up front — it is not itself race-free (a plain
  check-then-open has a window where the path could be swapped to a symlink
  afterward). `open_regular_bounded()` is the actual security boundary for
  that fd-based open: the kernel refuses the open outright if the final path
  component is a symlink at open time, so nothing can be swapped in between
  that check and the read it guards.
- **Plain (non-gzip) SQLite sources are read through a second, path-based
  open, honestly documented as narrower.** After the `open_regular_bounded()`
  fd-based preflight above confirms the path was a bounded regular file, not
  a symlink, `collect()` closes that fd and hands the real path to SQLite's
  own read-only URI connection (`mode=ro`), because SQLite must open by path
  to locate a sibling `-wal`/`-shm` file and correctly combine it with the
  main `.db` file in one consistent read-only transaction. An earlier
  version instead byte-copied only the main `.db` file into a temporary
  file and read that copy — silently dropping any row committed to the WAL
  but not yet checkpointed into the main file, which is exactly what live
  bot databases look like between checkpoints. Forcing a checkpoint, or
  reading/copying the WAL file independently, was rejected as an
  unacceptable write against a source this tool must treat as read-only;
  SQLite's own WAL-aware reader is the correct mechanism and needs no new
  VFS. **This is a real, honest narrowing of the guarantee above**: the
  second open is a standard path-based SQLite open, not `O_NOFOLLOW`+`fstat`
  on an already-open descriptor, so it assumes `--root` is a trusted,
  owner-controlled directory rather than defending against a kernel-race
  swap of an arbitrary hostile ancestor directory between the two opens.
  Gzip-compressed backups (`backups/*.db.gz`) keep the original
  decompress-into-a-bounded-temp-file path unchanged — a compressed archive
  is a static, already-checkpointed snapshot with no live WAL counterpart to
  lose, so the byte-copy approach is correct and safe there.
- `-wal`/`-shm`/`-journal` sidecar files next to a database are excluded from
  the standalone source glob (`_is_wal_sidecar()`) — they are never
  independently openable as their own SQLite database, and SQLite reads them
  automatically (by path adjacency) when the parent database is opened
  above. They are never deleted or moved by this tool. A fresh inventory run
  found exactly one real file the unfiltered `*.db.pre-*` glob had
  misclassified this way (`data/calendar.db.pre-intent-seed-backup-shm`,
  reported `unreadable`); that entry is now excluded from the source list
  rather than reported at all, and the parent database it belongs to is
  still read correctly, WAL included, via the mechanism above.
- Both SQLite files (plain and gzip) and debug logs are capped at a fixed
  byte ceiling on the source file itself via the `fstat` preflight, and gz
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
- `intent` — must match `SINGLE_INTENT_RE` (one dotted or bare lowercase
  label, e.g. `event.create`, matching everything `COMMANDS`/`RULES`/
  `suggest_labels` ever produce). A compound request spanning multiple
  operations, encoded as one string (e.g.
  `"event.create,invitation.send"`), is rejected as unsupported rather than
  silently squeezed into a single label — `GoldLabel` has no ordered,
  multi-operation representation yet, and building one is future, separately
  reviewable work, not a default the importer should invent.
- `slots` — every key and value must be a `str`, matching the `GoldLabel`
  TypedDict's `dict[str, str]` shape; a non-string slot value (or key) is
  rejected rather than silently accepted and later misread by a consumer
  expecting text.

**A caller-supplied approval can never promote a source-quarantined
candidate.** `apply_gold_import` hard-rejects `train_eligible` — regardless
of what the four supplied review statuses say — for any candidate whose own
`privacy_status` is `'quarantined'` or whose `text_candidate` is the
`[QUARANTINED_AUTH]` marker (`gold_rejected_source_quarantined` in the
report; `label_status` becomes `'gold_rejected_source_quarantined'`, and
`gold`/`gold_adjudication` are cleared). An imported review is an *external
assertion* about a record a reviewer looked at outside this script; it is
never proof that this script itself re-adjudicated a quarantine it already
raised, so it cannot override one.

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

A parent-run fresh inventory pass against the real retained server, local,
and archive roots completed on 2026-09-28T17:29:48Z, at commit `1bccd268`
(the corrected session/lineage/permission/symlink logic, **before** the
`eb3a7449` TOCTOU-hardening commit and **before** the three blocker fixes
documented in this section that landed on top of it — see below). Only the
aggregate `summary.json` counts were read; no raw historical text entered
this document, model context, or any provider. Combined retained inventory:
**3884 rows, 968 user candidates** (876 database, 92 debug-log), 553
auth-quarantined rows, 108 detached-unknown-provenance rows, 1 detached
stale-session row, 0 invalid timestamps. 1061 sources (71 SQLite, 989 debug
logs, 1 legacy retained archive): 130 `read`, 930 `no_direct_dialogues`, 1
`unreadable`. Weak labels: `unknown` 402, `dialogue.answer` 280,
`calendar.read` 88, `invitation.send` 86, `event.create` 39 (plus smaller
counts down the tail). **`gold_count` is 0 and `train_eligible` is 0** —
nothing in this corpus is adjudicated, and nothing is train-eligible, by
design. (A server-only sub-pass reported 2431 rows / 535 candidates / 140
sources as a partial breakdown of the same combined total.) These are
overlapping candidates, not unique Telegram updates or validated intents.

That sole `unreadable` entry was `data/calendar.db.pre-intent-seed-backup-shm`
— the real-world instance of the `*.db.pre-*` glob sidecar-misclassification
bug fixed above, not an actually-unreadable history database. It is why that
fix exists.

**These numbers do not reflect the current `HEAD` of this branch** and must
not be attributed to it: they predate both the `eb3a7449` WAL-byte-copy
regression (fixed above, blocker 1) and its own fix, and they predate the
`-shm`/`-wal` sidecar exclusion and the gold-import hardening (blockers 2
and 3) landing in this same commit. A fresh rerun against this fixed `HEAD`
is the concrete next step and is **not done as part of this change** — it
remains an independently owned, independently verifiable action for the
PR's reviewer/merge-queue owner, not something this code-fix commit should
assert for itself.

**Runtime correction:** an earlier version of this document assumed a full
pass was too slow to run here because retained logs total several
gigabytes. That was not measured and turned out to be wrong: the actual
parent-run passes completed in 31.35s (server-only) and 31.55s (combined
server+local+retained archive), both exit 0. The next full rerun is still
deferred (see above) — not because of a runtime cost that does not exist,
but because the fresh, fixed-`HEAD` run is a distinct action the reviewer
performs and republishes, not something this fix should silently
regenerate and then reuse as its own proof of correctness.

## Limitations

- Regex `intent_candidates` are unvalidated hypotheses, not a trained
  classifier's accuracy.
- Pseudonymization is not an anonymity guarantee; every free-text record still
  needs a privacy review before any external use.
- Database and debug-log records may overlap; source counts are not unique
  Telegram updates.
- Historical permissions, entity state, and timezone are not reconstructed —
  `historical_state` is always `not_reconstructed`.
- Auth-window quarantine is a conservative blast radius reconstructed from
  history, not the wizard state the bot itself checks. The ingress fix that
  keeps credentials out of chat history is #617/#641; backups taken before it
  rotate out around 2026-10-12 (#613). A credential row whose prompt is not
  among the loaded rows is not recognised. A full snapshot always holds the
  prompt, because it was written seconds before the answer. The gap is a
  partial `--merge` archive that starts after the prompt, or the 90-day
  `chat_history` cleanup cutting between prompt and answer. Pre-GH-721 packages
  are the only partial archives, and they are redacted under #519.
- A package built before GH-721 is not safe to open: its
  `selected.private.json` copied connect-wizard input from old backups
  verbatim. Such packages from 2026-09-28 are redacted under #519.
- A later `--merge` of a GH-721 export sees pseudonymized text under that
  run's key, not the source text. Candidates built from it are pseudonymized
  twice, and a tool call whose JSON held a redacted bare number (e.g. a chat
  id) no longer parses, so its tool name is not observed.
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
