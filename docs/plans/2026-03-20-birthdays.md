# Birthday Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add birthday event type with automatic MTProto discovery, `/birthdays` command, AI tool for creation, and birthday filter in `search_events`.

**Architecture:** Three new DB tables (event_type column on events, birth_event_metadata, birthday_sync_state), a BirthdayService that wraps MTProto fetch + event upsert + reminder creation logic, a daily BullMQ cron job, and a new Python batch script. Display title enrichment (🎁 emoji, age suffix) happens at read time, never stored.

**Tech Stack:** TypeScript/Bun, bun:sqlite, BullMQ, Pyrogram (Python), GramIO

**Spec:** `docs/specs/2026-03-20-birthdays-design.md`

---

> **Split document.** This file is the index; the full text lives in the ordered parts under [`2026-03-20-birthdays/`](2026-03-20-birthdays/). Reading the parts in order reproduces the original document.

## Contents

1. [Overview, tasks 1–4](2026-03-20-birthdays/01-overview-tasks-1-4.md)
   - [File Map](2026-03-20-birthdays/01-overview-tasks-1-4.md#file-map)
   - [Task 1: DB Migrations + Types](2026-03-20-birthdays/01-overview-tasks-1-4.md#task-1-db-migrations--types)
   - [Task 2: Update `EventRepository.create()` + Birthday Queries](2026-03-20-birthdays/01-overview-tasks-1-4.md#task-2-update-eventrepositorycreate--birthday-queries)
   - [Task 3: BirthdayMetadataRepository](2026-03-20-birthdays/01-overview-tasks-1-4.md#task-3-birthdaymetadatarepository)
   - [Task 4: `scripts/fetch-birthdays.py`](2026-03-20-birthdays/01-overview-tasks-1-4.md#task-4-scriptsfetch-birthdayspy)
2. [Tasks 5–6](2026-03-20-birthdays/02-tasks-5-6.md)
   - [Task 5: BirthdayService](2026-03-20-birthdays/02-tasks-5-6.md#task-5-birthdayservice)
   - [Task 6: Cron Job + Message Handler Hook](2026-03-20-birthdays/02-tasks-5-6.md#task-6-cron-job--message-handler-hook)
3. [Tasks 7–9](2026-03-20-birthdays/03-tasks-7-9.md)
   - [Task 7: `/birthdays` Command](2026-03-20-birthdays/03-tasks-7-9.md#task-7-birthdays-command)
   - [Task 8: AI Tools + Constants](2026-03-20-birthdays/03-tasks-7-9.md#task-8-ai-tools--constants)
   - [Task 9: Final Validation](2026-03-20-birthdays/03-tasks-7-9.md#task-9-final-validation)
