# Intent answer quality rubric

Review of a new, changed, consolidated or batch-proposed intent checks more than pattern matches,
JSON shapes and tool calls. It checks the answer the person will actually read: put the actual
execution result, the historical AI answer and the desired answer side by side.

Every criterion below is required. A failed criterion means the intent needs rework, even when
every tool call technically succeeded.

## Criteria

**Directness.** The answer starts with what was asked. For "What is tomorrow?" that is tomorrow's
plans, or a clear statement that nothing is recorded. It does not explain internal search
mechanics.

**Informativeness.** The checked date or period and the calendar are clear. An event list carries
time, title and the important details that are available. A delete or move confirmation names the
exact event and the action. An error message makes the next safe step clear.

**Friendliness.** Natural conversational language: no bureaucratic phrasing, lecturing or
over-familiarity. Emoji is allowed but never counts as evidence of a good answer. Do not append
congratulations, "enjoy your rest" or suggestions to every empty calendar.

**Truthful scope.** "Nothing is scheduled" is allowed only after a successful read of the named
calendar. It does not mean the person is completely free, that every external calendar is synced,
or that they have no other obligations. A read failure, an access denial or an unavailable
integration is never an empty result.

**Proportion.** A short question does not need a long formal report. Necessary clarifications
stay; internal identifiers are shown only when they help choose or confirm an object.

## Example

Request: "Что завтра?" ("What is tomorrow?")

Bad: "Событий в этом диапазоне не найдено." ("No events found in this range.") It hides which day
and which calendar were checked and reads like a database message.

Good, after a successful read of an empty personal calendar with the clock on 2026-09-19 in
Europe/Belgrade: "На завтра, 20 сентября, в твоём календаре пока нет событий, которые начинаются в
этот день." The date is computed from the actually checked interval in the user's timezone, never
copied from this example. The wording says "no events start that day" rather than "nothing is
planned" because the calendar read matches events by their start: an overnight or multi-day event
that began the day before is not returned, so a stronger claim could be false (tracked in #570).

For a group the answer names that group's calendar; for a delegated read it names the selected
calendar rather than the caller's own. A check of only 09:00-10:00 says that nothing starts in that
window; it never becomes a claim about the whole day. A failed read gets an honest error, not a
friendly invention.

The reference implementation of the empty-calendar wording is
`src/services/ai/empty-agenda.ts`, called from the `get_events` tool handler.
