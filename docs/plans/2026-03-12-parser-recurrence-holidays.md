# Parser Extensions + Recurring Events UI + Holidays Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend Phase A with multilingual parser support, recurring event creation/editing UI, and holiday subscriptions.

**Architecture:** Three features built in dependency order: (1) parser extensions add full-word RU/EN duration and date formats, (2) recurring events UI adds scene steps for recurrence creation, scope-based edit/delete with `editOccurrence`/`splitRecurrence`/`deleteFuture` service methods, (3) holidays add `date-holidays` integration with SQLite cache, subscription management, and agenda/free-slot integration.

**Tech Stack:** Bun, GramIO, @gramio/scenes, bun:sqlite, rrule, date-holidays, date-fns, @date-fns/tz

---

> **Split document.** This file is the index; the full text lives in the ordered parts under [`2026-03-12-parser-recurrence-holidays/`](2026-03-12-parser-recurrence-holidays/). Reading the parts in order reproduces the original document.

## Contents

1. [Tasks 1–4](2026-03-12-parser-recurrence-holidays/01-tasks-1-4.md)
   - [Chunk 1: Multilingual Parser Extensions](2026-03-12-parser-recurrence-holidays/01-tasks-1-4.md#chunk-1-multilingual-parser-extensions)
   - [Task 1: Extend `parseDuration` with full-word suffixes](2026-03-12-parser-recurrence-holidays/01-tasks-1-4.md#task-1-extend-parseduration-with-full-word-suffixes)
   - [Task 2: Extend `parseSimpleDate` with full RU weekdays, "послезавтра", and full RU months](2026-03-12-parser-recurrence-holidays/01-tasks-1-4.md#task-2-extend-parsesimpledate-with-full-ru-weekdays-послезавтра-and-full-ru-months)
   - [Chunk 2: Recurrence Parser & Formatter](2026-03-12-parser-recurrence-holidays/01-tasks-1-4.md#chunk-2-recurrence-parser--formatter)
   - [Task 3: Create `parseRecurrence` function](2026-03-12-parser-recurrence-holidays/01-tasks-1-4.md#task-3-create-parserecurrence-function)
   - [Task 4: Extend `formatRecurrenceHuman` with INTERVAL, UNTIL, and COUNT](2026-03-12-parser-recurrence-holidays/01-tasks-1-4.md#task-4-extend-formatrecurrencehuman-with-interval-until-and-count)
2. [Tasks 5–10](2026-03-12-parser-recurrence-holidays/02-tasks-5-10.md)
   - [Chunk 3: Repository & Service Methods for Recurring Edit/Delete](2026-03-12-parser-recurrence-holidays/02-tasks-5-10.md#chunk-3-repository--service-methods-for-recurring-editdelete)
   - [Task 5: Add new EventRepository methods](2026-03-12-parser-recurrence-holidays/02-tasks-5-10.md#task-5-add-new-eventrepository-methods)
   - [Task 6: Add new EventService methods (`editOccurrence`, `splitRecurrence`, `deleteFuture`)](2026-03-12-parser-recurrence-holidays/02-tasks-5-10.md#task-6-add-new-eventservice-methods-editoccurrence-splitrecurrence-deletefuture)
   - [Chunk 4: Add-Event Scene, Keyboards, Callbacks, and i18n](2026-03-12-parser-recurrence-holidays/02-tasks-5-10.md#chunk-4-add-event-scene-keyboards-callbacks-and-i18n)
   - [Task 7: Add new CB constants and i18n messages](2026-03-12-parser-recurrence-holidays/02-tasks-5-10.md#task-7-add-new-cb-constants-and-i18n-messages)
   - [Task 8: Update keyboards for recurring events](2026-03-12-parser-recurrence-holidays/02-tasks-5-10.md#task-8-update-keyboards-for-recurring-events)
   - [Task 9: Rewrite add-event scene with recurrence steps and skip buttons](2026-03-12-parser-recurrence-holidays/02-tasks-5-10.md#task-9-rewrite-add-event-scene-with-recurrence-steps-and-skip-buttons)
   - [Task 10: Update callback handler for recurring event edit/delete with occurrence date](2026-03-12-parser-recurrence-holidays/02-tasks-5-10.md#task-10-update-callback-handler-for-recurring-event-editdelete-with-occurrence-date)
3. [Tasks 11–13](2026-03-12-parser-recurrence-holidays/03-tasks-11-13.md)
   - [Chunk 5: Holidays — Data Layer](2026-03-12-parser-recurrence-holidays/03-tasks-11-13.md#chunk-5-holidays--data-layer)
   - [Task 11: Add migration 004 for holiday tables](2026-03-12-parser-recurrence-holidays/03-tasks-11-13.md#task-11-add-migration-004-for-holiday-tables)
   - [Task 12: Create HolidayRepository](2026-03-12-parser-recurrence-holidays/03-tasks-11-13.md#task-12-create-holidayrepository)
   - [Task 13: Create HolidayService](2026-03-12-parser-recurrence-holidays/03-tasks-11-13.md#task-13-create-holidayservice)
4. [Tasks 14–16](2026-03-12-parser-recurrence-holidays/04-tasks-14-16.md)
   - [Chunk 6: Holidays — Bot Layer](2026-03-12-parser-recurrence-holidays/04-tasks-14-16.md#chunk-6-holidays--bot-layer)
   - [Task 14: Add holiday i18n keys, keyboards, and `/holidays` command](2026-03-12-parser-recurrence-holidays/04-tasks-14-16.md#task-14-add-holiday-i18n-keys-keyboards-and-holidays-command)
   - [Task 15: Integrate holidays into agenda and /free](2026-03-12-parser-recurrence-holidays/04-tasks-14-16.md#task-15-integrate-holidays-into-agenda-and-free)
   - [Task 16: Update help text and final verification](2026-03-12-parser-recurrence-holidays/04-tasks-14-16.md#task-16-update-help-text-and-final-verification)
