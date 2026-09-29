# Preserve dates throughout a multi-day calendar answer

Task: [mixed-list date ambiguity](https://github.com/alex-mextner/HyperCalendarBot/issues/499).
Recovered source: [PR547](https://github.com/alex-mextner/HyperCalendarBot/pull/547), head `f20dbb477a40177f92e326bc5c493960a4322e74`.

Lena's week plan included dated older events followed by an undated event from today. The last line could be read as belonging to the previous displayed day.

1. Reproduce the missing date with the recovered synthetic regression on current main, before applying its production change.
2. Date every row whenever any row is not today in the viewer's timezone. Preserve short time-only rows for an all-today list and correct all-day spacing.
3. Revalidate current full tests, typecheck, lint and a fresh diff review. Preserve the original branch until the replacement is merged and its lineage recorded.
4. Ship normally after the roster release; verify the live immutable source and an authorized read-only multi-day answer. No events are created, changed or deleted.

This patch does not redefine a calendar week, change read authorization or widen the requested date range. The separate upcoming-week issue497 remains separately tracked.
