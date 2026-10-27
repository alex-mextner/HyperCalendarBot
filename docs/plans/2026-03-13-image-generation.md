# Image Generation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render shareable calendar agenda images (daily, weekly, event card) via HTML/CSS templates + Playwright screenshots, delivered through BullMQ worker queue.

**Architecture:** Bot command builds data payload from EventService → enqueues BullMQ job → Worker renders HTML via template → Playwright screenshots to PNG → base64 result returned via BullMQ → Bot decodes and sends PNG to Telegram. Playwright pool limits concurrency (4 pages). Worker runs in-process (matches existing notification/sync queue pattern).

**Tech Stack:** Playwright (chromium headless), BullMQ (installed), Redis (configured), HTML/CSS tagged template literals, Inter font (woff2 base64), `@date-fns/tz` (installed)

---

> **Split document.** This file is the index; the full text lives in the ordered parts under [`2026-03-13-image-generation/`](2026-03-13-image-generation/). Reading the parts in order reproduces the original document.

## Contents

1. [Overview, tasks 1–5](2026-03-13-image-generation/01-overview-tasks-1-5.md)
   - [Prerequisites](2026-03-13-image-generation/01-overview-tasks-1-5.md#prerequisites)
   - [File Structure](2026-03-13-image-generation/01-overview-tasks-1-5.md#file-structure)
   - [New Files](2026-03-13-image-generation/01-overview-tasks-1-5.md#new-files)
   - [Modified Files](2026-03-13-image-generation/01-overview-tasks-1-5.md#modified-files)
   - [Chunk 1: Template Foundation](2026-03-13-image-generation/01-overview-tasks-1-5.md#chunk-1-template-foundation)
   - [Task 1: Data contracts & template types](2026-03-13-image-generation/01-overview-tasks-1-5.md#task-1-data-contracts--template-types)
   - [Task 2: Theme definitions](2026-03-13-image-generation/01-overview-tasks-1-5.md#task-2-theme-definitions)
   - [Task 3: i18n labels + pluralization](2026-03-13-image-generation/01-overview-tasks-1-5.md#task-3-i18n-labels--pluralization)
   - [Task 4: HTML helpers + overlapping event columns](2026-03-13-image-generation/01-overview-tasks-1-5.md#task-4-html-helpers--overlapping-event-columns)
   - [Task 5: Fonts + shared CSS](2026-03-13-image-generation/01-overview-tasks-1-5.md#task-5-fonts--shared-css)
2. [Tasks 6–11](2026-03-13-image-generation/02-tasks-6-11.md)
   - [Chunk 2: HTML Templates](2026-03-13-image-generation/02-tasks-6-11.md#chunk-2-html-templates)
   - [Task 6: Daily agenda template](2026-03-13-image-generation/02-tasks-6-11.md#task-6-daily-agenda-template)
   - [Task 7: Weekly overview template](2026-03-13-image-generation/02-tasks-6-11.md#task-7-weekly-overview-template)
   - [Task 8: Event card template](2026-03-13-image-generation/02-tasks-6-11.md#task-8-event-card-template)
   - [Task 9: Template registry](2026-03-13-image-generation/02-tasks-6-11.md#task-9-template-registry)
   - [Chunk 3: Rendering Engine](2026-03-13-image-generation/02-tasks-6-11.md#chunk-3-rendering-engine)
   - [Task 10: Playwright pool](2026-03-13-image-generation/02-tasks-6-11.md#task-10-playwright-pool)
   - [Task 11: BullMQ image render queue + worker](2026-03-13-image-generation/02-tasks-6-11.md#task-11-bullmq-image-render-queue--worker)
3. [Tasks 12–17](2026-03-13-image-generation/03-tasks-12-17.md)
   - [Chunk 4: Bot Integration](2026-03-13-image-generation/03-tasks-12-17.md#chunk-4-bot-integration)
   - [Task 12: Data mapper (EventOccurrence → template data)](2026-03-13-image-generation/03-tasks-12-17.md#task-12-data-mapper-eventoccurrence--template-data)
   - [Task 13: RenderService](2026-03-13-image-generation/03-tasks-12-17.md#task-13-renderservice)
   - [Task 14: Add callback prefixes](2026-03-13-image-generation/03-tasks-12-17.md#task-14-add-callback-prefixes)
   - [Task 15: Wire image queue into entry point](2026-03-13-image-generation/03-tasks-12-17.md#task-15-wire-image-queue-into-entry-point)
   - [Task 16: Add image buttons to commands + callback handler](2026-03-13-image-generation/03-tasks-12-17.md#task-16-add-image-buttons-to-commands--callback-handler)
   - [Task 17: Manual end-to-end verification](2026-03-13-image-generation/03-tasks-12-17.md#task-17-manual-end-to-end-verification)
   - [Design Decisions](2026-03-13-image-generation/03-tasks-12-17.md#design-decisions)
   - [Deferred (not in this plan)](2026-03-13-image-generation/03-tasks-12-17.md#deferred-not-in-this-plan)
