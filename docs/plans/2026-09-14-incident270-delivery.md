# Reliability delivery priorities — 2026-09-14

## Incident and evidence
The incident happened on 2026-09-13. Model-generated IDs arrived as strings; rejected operations were narrated as completed. Manual Google Calendar repair is separate from fixing the bot. Numeric validation was merged in PR #272; production deployment must be verified independently.

## Ordered work

1. **P0 — truthful results (#270).** Distinguish applied changes, rejected requests, uncertain execution, skipped repeats, delivered invitations, manual forwarding, attendance decline and waiting for input. Persist tool receipts before another provider call; never automatically replay a whole request after a mutation may have happened. Verify normal, retry, timeout, partial-success, group privacy and voice paths with real SQLite and fake delivery.
2. **P0 — financial data integrity (ExpenseSyncBot #116).** Unknown currency must not become EUR 1:1. Retain original transaction/currency, keep unconverted values out of EUR totals and expose the unresolved conversion. Do not rewrite historical user data without a reviewed repair plan.
3. **P1 — receipt/intent linkage and interrupted explanations (#270/#231).** Attempt results are not proof every requested item was attempted or resolved. Add durable operation identifiers and recovery-only explanation behavior before claiming exactly-once delivery across process restarts.
4. **P1 — provider transcript compatibility (#258).** Preserve required Gemini tool metadata, pair calls/results and handle provider-specific history restrictions without re-executing writes.
5. **P1 — financial test evidence and FX (ExpenseSyncBot #118/#119/#117).** Use the isolated suite; fix real dependency advisories before shipping. A deterministic security-audit failure is not a flaky test. Currency features stay out of HyperCalendarBot.
6. **P1 — runtime model routing (#257/#267).** Connect the reviewed Light/Medium/Smart design to actual Telegram ingress and persistent repair state; full short catalog stays visible, discovery is always exposed, and no keyword routing layer is added.
7. **P1 — agenda metadata (#269), invitation identity (#221/#255), sync (#218).** Keep these open until their own tests, deployment and authorized live verification pass. Do not resend expired invitations from September 13 as a present-day repair.

## Current delivery checkpoints

- #272 is merged. A running container is not proof that this revision is deployed; verify source/image identity first.
- The #270 independent review exposed actual false-reporting and persistence defects. They are being corrected with regression tests; no new production change is claimed here.
- `AGENTS.md` now records ordered work, test/review/fix/merge/deployment discipline and preservation-before-cleanup.
- Closed PR #264 is superseded by #267. Its obsolete worktree and the intermediate three-tier worktree were backed up with per-file SHA-256 verification, staged/unstaged patches and Git bundles under `~/xp/_recovery/hypercalendarbot/20260914-pr264/`, then removed along with unused branches. The active #267 branch was retained.

## Completion evidence required

Record exact commit, native full-suite/typecheck/lint, independent reviews and their limitations, normal `gh ship` result, deployed revision and live smoke separately. Keep parent incidents open for any undelivered scope. Never disable checks, falsify status checks or mark deployment complete from source tests alone.

## Review follow-up checkpoint

Implementation is now pushed as PR #275 (initial source commit 341fe2f). The initial full suite passed 4,652 tests with 8 disclosed skips. A further source review identified missing not-applied markers on known create/update/invitation rejections; three real-agent regressions failed before those markers and the interruption text were corrected. The real group-history fixture now sets groupChatId and asserts nonempty persisted receipts.
Full privacy of raw group-history/tool-label sinks remains in existing #245; final-summary redaction is not a claim those older sinks are fixed. Persistent intent linkage and partial external synchronization are tracked in #274. Expense dependency audit failures are explicitly tracked in ExpenseSyncBot #120 and are not flaky tests.
The misplaced calendar FX PR #265 was closed. Its 786-file snapshot, diffs and verified bundle are in the private 20260914-pr265 recovery directory; obsolete workspace/local/remote branch were removed after child-PR and active-process checks. The continuing financial work remains intact. A surviving inference worktree dependency symlink was redirected to the same shared node_modules target and verified.

A further real SQLite regression reproduced an update which commits but becomes unreadable after its start time crosses a group-membership visibility boundary. The handler now checks absence before attempting the update and keeps a null post-update read uncertain; it must not label that committed attempt not-applied or replay it. The last narrow fix needs another independent re-review before shipping; passing source tests are not a substitute. Main has meanwhile merged agenda PR #273; validate the combined revision before release.
