# Secretary Access Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let calendar owners delegate access to secretaries who can read/write their calendar via AI tools.

**Architecture:** New `calendar_secretaries` table + `SecretaryRepository`; two new AI tools (`list_calendar_access`, `manage_secretaries`); `owner_id` param on all 14 event tools with `checkSecretaryAccess` guard; invite/revoke/self_remove flows via universal `deliverMessage` utility; `sec:accept`/`sec:decline` callbacks; daily cron to expire stale invites.

**Tech Stack:** Bun, bun:sqlite, GramIO, Anthropic SDK tool definitions, existing TelegramSender/MTProto delivery chain.

**Spec:** `docs/specs/2026-03-18-privacy-delegation.md`

---

> **Split document.** This file is the index; the full text lives in the ordered parts under [`2026-03-18-secretary-access/`](2026-03-18-secretary-access/). Reading the parts in order reproduces the original document.

## Contents

1. [Overview, tasks 1–5](2026-03-18-secretary-access/01-overview-tasks-1-5.md)
   - [File Map](2026-03-18-secretary-access/01-overview-tasks-1-5.md#file-map)
   - [Task 1: `deliverMessage` universal utility](2026-03-18-secretary-access/01-overview-tasks-1-5.md#task-1-delivermessage-universal-utility)
   - [Task 2: DB migration + types](2026-03-18-secretary-access/01-overview-tasks-1-5.md#task-2-db-migration--types)
   - [Task 3: SecretaryRepository](2026-03-18-secretary-access/01-overview-tasks-1-5.md#task-3-secretaryrepository)
   - [Task 4: `list_calendar_access` tool](2026-03-18-secretary-access/01-overview-tasks-1-5.md#task-4-list_calendar_access-tool)
   - [Task 5: `manage_secretaries` — invite action](2026-03-18-secretary-access/01-overview-tasks-1-5.md#task-5-manage_secretaries--invite-action)
2. [Tasks 6–11](2026-03-18-secretary-access/02-tasks-6-11.md)
   - [Task 6: `manage_secretaries` — revoke + self_remove](2026-03-18-secretary-access/02-tasks-6-11.md#task-6-manage_secretaries--revoke--self_remove)
   - [Task 7: `sec:accept` / `sec:decline` callbacks](2026-03-18-secretary-access/02-tasks-6-11.md#task-7-secaccept--secdecline-callbacks)
   - [Task 8: `owner_id` on event tools + `checkSecretaryAccess` guard](2026-03-18-secretary-access/02-tasks-6-11.md#task-8-owner_id-on-event-tools--checksecretaryaccess-guard)
   - [Task 9: System prompt extension](2026-03-18-secretary-access/02-tasks-6-11.md#task-9-system-prompt-extension)
   - [Task 10: Cron — expire pending invites](2026-03-18-secretary-access/02-tasks-6-11.md#task-10-cron--expire-pending-invites)
   - [Task 11: Wiring — `src/bot/index.ts`](2026-03-18-secretary-access/02-tasks-6-11.md#task-11-wiring--srcbotindexts)
   - [Done](2026-03-18-secretary-access/02-tasks-6-11.md#done)
