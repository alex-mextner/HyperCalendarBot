# Invite: Propose Alternative Time — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow invitation recipients to propose an alternative event time; inviter gets a notification with one-click reschedule.

**Architecture:** New `proposed_time` column on `invitations` table. New service methods in `InvitationService`. New `inv:propose`, `inv:reschedule`, `inv:dismiss` callback sub-actions (`inv:dismiss` replaces the stub `inv:keep` for inviter actions). A `proposeTimeSessions` Map shared between callback and message handlers for free-text time input. Shared `formatProposedTime` ESM util to avoid duplicate date-formatting logic.

**Spec:** `docs/specs/invite-propose-time.md`

**Tech Stack:** Bun, bun:sqlite, GramIO, TypeScript, existing `parseSimpleDate` util.

**Worktree:** `.worktrees/propose-time` on branch `feat/invite-propose-time`

---

> **Split document.** This file is the index; the full text lives in the ordered parts under [`2026-03-18-invite-propose-time/`](2026-03-18-invite-propose-time/). Reading the parts in order reproduces the original document.

## Contents

1. [Overview, tasks 1–5](2026-03-18-invite-propose-time/01-overview-tasks-1-5.md)
   - [File Map](2026-03-18-invite-propose-time/01-overview-tasks-1-5.md#file-map)
   - [Task 1: DB Migration + Types](2026-03-18-invite-propose-time/01-overview-tasks-1-5.md#task-1-db-migration--types)
   - [Task 2: Repository Methods](2026-03-18-invite-propose-time/01-overview-tasks-1-5.md#task-2-repository-methods)
   - [Task 3: Service Methods](2026-03-18-invite-propose-time/01-overview-tasks-1-5.md#task-3-service-methods)
   - [Task 4: i18n Strings](2026-03-18-invite-propose-time/01-overview-tasks-1-5.md#task-4-i18n-strings)
   - [Task 5: Add "Другое время" Button to Invite Command](2026-03-18-invite-propose-time/01-overview-tasks-1-5.md#task-5-add-другое-время-button-to-invite-command)
   - [Task 5.1: Create formatProposedTime Shared Util](2026-03-18-invite-propose-time/01-overview-tasks-1-5.md#task-51-create-formatproposedtime-shared-util)
   - [Task 5.5: Add "Другое время" Button to telegram-sender.ts and start.ts](2026-03-18-invite-propose-time/01-overview-tasks-1-5.md#task-55-add-другое-время-button-to-telegram-senderts-and-startts)
2. [Tasks 6–10](2026-03-18-invite-propose-time/02-tasks-6-10.md)
   - [Task 6: Callback Handler — Propose Sub-action](2026-03-18-invite-propose-time/02-tasks-6-10.md#task-6-callback-handler--propose-sub-action)
   - [What to implement](2026-03-18-invite-propose-time/02-tasks-6-10.md#what-to-implement)
   - [Deps changes needed](2026-03-18-invite-propose-time/02-tasks-6-10.md#deps-changes-needed)
   - [Task 7: Callback Handler — Reschedule + Dismiss](2026-03-18-invite-propose-time/02-tasks-6-10.md#task-7-callback-handler--reschedule--dismiss)
   - [Task 8: Message Handler — Propose Time Text Input](2026-03-18-invite-propose-time/02-tasks-6-10.md#task-8-message-handler--propose-time-text-input)
   - [What to add](2026-03-18-invite-propose-time/02-tasks-6-10.md#what-to-add)
   - [Task 9: Wire Up in bot/index.ts](2026-03-18-invite-propose-time/02-tasks-6-10.md#task-9-wire-up-in-botindexts)
   - [Task 10: Full Test Suite + Final Verification](2026-03-18-invite-propose-time/02-tasks-6-10.md#task-10-full-test-suite--final-verification)
   - [Notes for the Implementing Agent](2026-03-18-invite-propose-time/02-tasks-6-10.md#notes-for-the-implementing-agent)
