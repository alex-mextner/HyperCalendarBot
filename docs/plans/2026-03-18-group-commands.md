# Group Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adapt all bot commands to work with the group calendar in group chats, remove deprecated commands (/agenda, /unshare, /timezone), and store group timezone/country in group_chats.

**Architecture:** Each command detects group context via `ctx.chat.type`. In groups, commands operate on `owner_type='group'` events via existing `EventRepository` and `EventService` group methods. Group settings (timezone, country) stored in new columns in `group_chats`. If group has no timezone, bot prompts on first calendar use.

**Tech Stack:** TypeScript, Bun, bun:sqlite, GramIO

---

> **Split document.** This file is the index; the full text lives in the ordered parts under [`2026-03-18-group-commands/`](2026-03-18-group-commands/). Reading the parts in order reproduces the original document.

## Contents

1. [Overview, tasks 1–5](2026-03-18-group-commands/01-overview-tasks-1-5.md)
   - [Existing group infrastructure (already implemented — do not re-implement)](2026-03-18-group-commands/01-overview-tasks-1-5.md#existing-group-infrastructure-already-implemented--do-not-re-implement)
   - [File Map](2026-03-18-group-commands/01-overview-tasks-1-5.md#file-map)
   - [Task 1: DB migration — group timezone/country](2026-03-18-group-commands/01-overview-tasks-1-5.md#task-1-db-migration--group-timezonecountry)
   - [Task 2: Group context utility](2026-03-18-group-commands/01-overview-tasks-1-5.md#task-2-group-context-utility)
   - [Task 3: Remove deprecated commands](2026-03-18-group-commands/01-overview-tasks-1-5.md#task-3-remove-deprecated-commands)
   - [Task 4: Adapt view commands (/today, /tomorrow, /week, /month)](2026-03-18-group-commands/01-overview-tasks-1-5.md#task-4-adapt-view-commands-today-tomorrow-week-month)
   - [Task 5: Adapt /add for groups](2026-03-18-group-commands/01-overview-tasks-1-5.md#task-5-adapt-add-for-groups)
2. [Tasks 6–12](2026-03-18-group-commands/02-tasks-6-12.md)
   - [Task 6: Adapt /edit and /delete for groups](2026-03-18-group-commands/02-tasks-6-12.md#task-6-adapt-edit-and-delete-for-groups)
   - [Task 7: Adapt /search and /free](2026-03-18-group-commands/02-tasks-6-12.md#task-7-adapt-search-and-free)
   - [Task 8: Adapt /settings for groups](2026-03-18-group-commands/02-tasks-6-12.md#task-8-adapt-settings-for-groups)
   - [Task 9: Adapt /import and /holidays](2026-03-18-group-commands/02-tasks-6-12.md#task-9-adapt-import-and-holidays)
   - [Task 10: Adapt /share and /invite](2026-03-18-group-commands/02-tasks-6-12.md#task-10-adapt-share-and-invite)
   - [Task 11: Disable /connect-google and /disconnect-google in groups](2026-03-18-group-commands/02-tasks-6-12.md#task-11-disable-connect-google-and-disconnect-google-in-groups)
   - [Task 12: Final verification](2026-03-18-group-commands/02-tasks-6-12.md#task-12-final-verification)
