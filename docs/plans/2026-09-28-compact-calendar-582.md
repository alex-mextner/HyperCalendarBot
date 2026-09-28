# Restore compact calendar images (GH-582)

Owner correction: remove repeated event details below calendar grids. Show concise
place, invitation and description metadata inside cells instead. Full text cards,
source permissions and protected image transport remain unchanged.

- [x] Reproduce oversized day/week/month fixtures in real Chromium.
- [x] Observe RED tests for removal, metadata, Unicode and actual clipping.
- [x] Replace the external detail section with a shared bounded inline renderer.
- [x] Fix compact overflow counters: all hidden titles count, not only the last one.
- [x] Observe 161 targeted tests GREEN; inspect actual screenshot geometry.
- [x] Independent review (Opus + Codex-omp + GLM), fix its must-fix finding, real local
  Chromium proof (deployment/live proof is owned by the merge-queue owner, not yet available).
- [ ] Full tests, lint, types, normal ship and exact deployed-revision proof.

Before → after synthetic geometry at width 1080:
day 1770 → 730 px; week 1761 → 967.75 px; month 2020 → 1096 px.
These are fixture measurements, not a universal percentage improvement.
Visuals and runner output retained under /tmp/hcb582-{before,after}-*.
Source: 48966c71, isolated worktree compact-calendar-20260928.
No private logs or real user data were needed for these screenshots.

## Independent review disposition

Full review at /tmp/hcb582-review.txt. Three reviewers ran against the diff.

- **Fixed (must-fix, Codex-omp/GLM):** `scripts/preview-agenda269.ts` and
  `scripts/verify-agenda-three.ts` still asserted the removed `.agenda-details__item` footer and
  unbounded location text. Rewrote both against the real DOM (compact-item/overflow-item
  selectors, bounded/clipped text, description preview now legitimately present), added a
  light+dark theme loop and a `<script>`-element XSS guard to the preview script. Both pass
  against real Chromium. Fixing them surfaced a genuine second-order consequence not flagged by
  the review: the compact 100-event day image is now small enough to legitimately qualify for
  Telegram's photo delivery path instead of the lossless-document fallback, so
  `scripts/verify-agenda-three.ts` and the companion `scripts/verify-agenda-three-transports.ts`
  were updated to expect `sendPhoto`, not `sendDocument`, for that fixture.
- **Checked, not a bug (Opus):** image cache key allegedly omitting `descriptionPreview`. There is
  no render cache for day/week/month images at all (grepped `src/worker`, `src/services/image` —
  the BullMQ image-render queue renders fresh every job). Nothing to fix.
- **Deferred (GLM items 2–10, low priority, out of scope for this fix):** `MiniEvent` mapping
  duplication across the three mappers in `src/services/image/data-mapper.ts`; duplicated
  event-block markup in `daily-agenda.ts` (main vs. overflow cards); `OverflowItem` type
  gymnastics with manual field copying; the magic `60`/`36` clip-length constants repeated across
  call sites with no named constant; `CompactEvent` hand-redeclaring `MiniEvent` fields instead of
  `Pick<...>`; `compactMetadataCSS` styling selectors owned by other templates
  (`.event-block__heading`, `.event-pill`, `.ev-dot`); the opaque `renderCompactMetadata(ev, true)`
  boolean flag; stray blank lines left by the `agenda-details.ts` removal. None of these are
  correctness or security issues — all are readability/duplication cleanups on code this diff
  already touches. **Impact if left undone:** maintainability/readability only; no observed
  correctness, security or user-facing failure. **Next action:** reassess after GH-582 ships;
  if the same files see more churn or a bug traces back to one of these patterns, file a
  dedicated follow-up ticket then — not opening a speculative ticket now with no concrete
  trigger.
