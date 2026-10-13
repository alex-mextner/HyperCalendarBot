# Shared wall-time parser (slice 1 of #554)

Related: #650 (this slice), #554 (parent dialogue redesign), #652 (wiring/rollout, blocked by this slice), #334 (contextual intents, prior-art interface).

PR562 documented that `add-event.scene.ts`'s `parseWizardDateTime` accepted a bare `"2"` as an implicit 02:00 while `workflow-bindings.ts`'s `parseTime` rejected the identical input outright, on the same commit. `src/services/calendar/wall-time-parser.ts` extracts one pure resolver both surfaces will eventually call, so the same input and the same pending field always produce the same decision. `src/services/calendar/wall-time-adapters.ts` gives each surface its own thin result shape (`resolveWizardWallTime` mirrors the wizard's existing `WizardDateTimeResult` tagged-union convention; `resolveIntentWallTime` mirrors the intent binding's accept/reject convention, wrapping the same reason-carrying resolution) — both are transforms of one private `resolve()` call with an exhaustive, `never`-checked switch over the parser's decision type, so a new decision added later fails to compile here until handled, instead of silently falling through the way the legacy pair diverged.

## Scope

This slice resolves **time of day and the timed/all-day axis against an already-selected calendar day**. It does not parse free-text dates (weekdays, month names, relative words like "tomorrow") — that grammar already exists in three separate places (`src/utils/date.ts:parseSimpleDate`, `add-event.scene.ts:parseWizardDate`, `workflow-bindings.ts:parseAbsoluteDay`) and unifying it is a larger, separate piece of work that neither #650's acceptance criteria nor its required synthetic-case list exercises. That unification is a deferred finding, tracked as a follow-up comment on #650/#554, not silently dropped.

Spelled-out Russian numerals ("два", "один") as bare-hour input are also out of scope: no word→number lexicon for parsing user input exists anywhere in `src/` today (`stress-marker.ts` only renders numbers as words for TTS, the opposite direction). Building one would be a second, gratuitous grammar for a single corpus family; if a future slice needs it, that lexicon should be shared with recurrence-count and picker-ordinal parsing too, not private to this module.

## Interface reconciliation with #334

A wall-clock helper with the same shape (`CalendarDay`, a DST-aware probe-based instant resolver, offset formatting) is sketched, unfinished, in the unmerged, dirty `feat/contextual-intents-20260919` worktree (#334) at `src/services/intent/wall-clock.ts` / `src/services/intent/event-time.ts`. That worktree's own `docs/superpowers/specs/2026-09-28-unified-calendar-dialogue-design.md` §3 explicitly asks for interface reconciliation before treating it as a ready dependency — that design doc and the `unified-dialogue-contract-cases.jsonl` corpus this slice's tests reproduce both live in that worktree, not in this repo/branch, since #334 and #554's docs slice are still unmerged.

`src/services/calendar/wall-clock.ts` in this slice intentionally mirrors that prototype's shape (`CalendarDay`, a probe-based DST resolver, offset formatting) so a future #334 merge can adopt this module instead of diverging from it. It is a fresh implementation, not an import of the unmerged branch. One deliberate difference: that prototype's `uniqueInstant` collapses both a DST gap and a DST fold to a single `null`; this module's `resolveWallInstant` distinguishes them (`'gap'` vs `'fold'`), because the shared parser must tell a user "that time doesn't exist" from "that time happened twice, which did you mean" — reconciling #334 onto this module, not the reverse, is part of GH-652's job.

`workflow-bindings.ts` (untouched by this slice) separately contains its own `pad2`/`CalendarDay`/`offsetMinutesAt`/`formatOffset`/`uniqueInstant` — the same probe algorithm as `wall-clock.ts` here, also collapsing gap and fold to one rejection. GH-652, which does the call-site swap, must delete that duplicate from `workflow-bindings.ts` in the same change that wires it onto this module; leaving both would let a future DST fix land in one copy and not the other.

## Decision taxonomy

`parseWallTimeInput(rawInput, ctx): WallTimeOutcome` returns exactly one of:

- `accepted` — a resolved `Schedule`, either `{ kind: 'timed'; startAt }` (a UTC instant) or `{ kind: 'all_day'; startDate; endDateExclusive }` (date-only, exclusive end — never a fabricated 00:00-to-next-midnight Timed event).
- `ambiguous` — either a bare hour 1-12 with no suffix/colon (`reason: 'bare_hour'`, two `HH:MM` candidates), or a local time repeated by a DST fall-back (`reason: 'repeated_local_time'`, two offset-qualified ISO instants). Neither is ever silently picked.
- `invalid` — unparseable text, an impossible clock value (24:00, 25:00, minute 75 — rejected outright, never rolled over), a local time skipped by a DST spring-forward gap, a `selectedDate` that is not a real calendar day, or a `timezone` string `Intl` cannot resolve. Each carries a specific `reason` (`unparseable` / `explicit_date_or_time_repair` / `nonexistent_local_time` / `calendar_date_does_not_exist` / `invalid_timezone`) — the adapters carry this through rather than collapsing it to a bare "invalid", because the repo's own response-quality rubric (`docs/intents/response-quality.md`) requires telling a user *why* their input was rejected, not a generic "didn't understand".
- `clarify` — a closed vocabulary of "time not decided yet" phrases; distinct from `all_day` (an event with an unknown time is not an all-day event) and distinct from `invalid`.
- `unhandled` — the caller did not mark this turn as pending a time (`ctx.pendingField !== 'time'`). A bare digit is never guessed as a time outside a time turn; the same digit means a different thing as a recurrence count or a contact-picker ordinal, which this module does not own.

On a DST spring-forward day, a bare 1-12 hour's ambiguous candidates are computed as plain `HH:00` labels and can include a local time that doesn't exist that day (e.g. selecting `2026-03-29` and typing `2` offers `02:00`/`14:00`, but `02:00` is inside that day's gap). This is deliberate — the labels only distinguish morning from evening, they do not promise the label resolves — and is covered by a test (`wall-time-parser.test.ts`, DST fold describe block) that re-feeds the chosen label back through `parseWallTimeInput` as an explicit time and confirms it correctly comes back `invalid`/`nonexistent_local_time` rather than being accepted. GH-652's disambiguation call site must do the same re-resolution, never trust a chosen candidate label as an instant on its own.

The parser never reads the system clock, never touches the network/DB, and never negotiates its own date — `ctx.selectedDate`/`ctx.timezone`/`ctx.pendingField` are supplied explicitly by the caller on every call.

## Not done in this slice

- Not wired into `add-event.scene.ts` or `workflow-bindings.ts` — both legacy functions are untouched and keep serving live traffic, matching #650's "no change to current production routing" acceptance box. GH-652 owns the call-site swap, and must keep the legacy wrapper's exact behavior for any session already mid-wizard/mid-workflow until the v3 adapter is explicitly flag-gated on.
- No free-text date grammar unification (see Scope above).
- No spelled-out numeral parsing (see Scope above).
- No production UX copy for the new `reason` values (see Decision taxonomy above) — GH-652 owns writing the actual user-facing strings per `docs/intents/response-quality.md`.

## Tests

`test/services/calendar/wall-clock.test.ts`, `wall-time-parser.test.ts`, `wall-time-adapters.test.ts` reproduce, as independently-derived executable assertions (not copied `expected` values), the relevant families of `unified-dialogue-contract-cases.jsonl` — the corpus checked into the `docs/dialogue-spec-20260928` worktree, see "Interface reconciliation with #334" above for exactly where (`time-ambiguous`, `time-bare-unambiguous`, `time-explicit`, `time-invalid`, `time-words`, `all-day`, `dst`, `unknown-time`, the time-turn slice of `number-context`, and `negative-entry`'s abstention requirement), plus DST gap/fold, purity-under-`setSystemTime`, calendar-date/timezone-validity, and DST-gap-candidate-label guards the corpus doesn't enumerate directly but #650's brief requires.
