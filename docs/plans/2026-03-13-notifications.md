# Notifications Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fully configurable notification system with morning agendas, event reminders, and evening reviews — all timezone-aware, delivered through BullMQ workers.

**Architecture:** A per-minute BullMQ repeatable job ticks through all due notifications (morning agendas, event reminders, evening reviews), filters by quiet hours and dedup, then enqueues delivery jobs. A separate BullMQ worker sends messages via GramIO. Event reminders are pre-materialized when events are created/updated.

**Tech Stack:** BullMQ, Bun.redis, bun:sqlite, @date-fns/tz, GramIO, pino

---

> **Split document.** This file is the index; the full text lives in the ordered parts under [`2026-03-13-notifications/`](2026-03-13-notifications/). Reading the parts in order reproduces the original document.

## Contents

1. [Tasks 1–5](2026-03-13-notifications/01-tasks-1-5.md)
   - [Chunk 1: Data Layer](2026-03-13-notifications/01-tasks-1-5.md#chunk-1-data-layer)
   - [Task 1: Migration 006 — Notification Tables](2026-03-13-notifications/01-tasks-1-5.md#task-1-migration-006--notification-tables)
   - [Task 2: NotificationPreferencesRepository](2026-03-13-notifications/01-tasks-1-5.md#task-2-notificationpreferencesrepository)
   - [Task 3: EventReminderRepository](2026-03-13-notifications/01-tasks-1-5.md#task-3-eventreminderrepository)
   - [Task 4: NotificationLogRepository](2026-03-13-notifications/01-tasks-1-5.md#task-4-notificationlogrepository)
   - [Task 5: Wire Repositories into DatabaseService](2026-03-13-notifications/01-tasks-1-5.md#task-5-wire-repositories-into-databaseservice)
2. [Tasks 6–9](2026-03-13-notifications/02-tasks-6-9.md)
   - [Chunk 2: Core Services](2026-03-13-notifications/02-tasks-6-9.md#chunk-2-core-services)
   - [Task 6: Timezone Utilities for Notifications](2026-03-13-notifications/02-tasks-6-9.md#task-6-timezone-utilities-for-notifications)
   - [Task 7: NotificationPreferencesService](2026-03-13-notifications/02-tasks-6-9.md#task-7-notificationpreferencesservice)
   - [Task 8: ReminderMaterializer](2026-03-13-notifications/02-tasks-6-9.md#task-8-remindermaterializer)
   - [Task 9: NotificationRenderer](2026-03-13-notifications/02-tasks-6-9.md#task-9-notificationrenderer)
3. [Tasks 10–12](2026-03-13-notifications/03-tasks-10-12.md)
   - [Chunk 3: Scheduler + Delivery](2026-03-13-notifications/03-tasks-10-12.md#chunk-3-scheduler--delivery)
   - [Task 10: NotificationScheduler (Tick Logic)](2026-03-13-notifications/03-tasks-10-12.md#task-10-notificationscheduler-tick-logic)
   - [Task 11: NotificationWorker](2026-03-13-notifications/03-tasks-10-12.md#task-11-notificationworker)
   - [Task 12: Wire Materializer into EventService](2026-03-13-notifications/03-tasks-10-12.md#task-12-wire-materializer-into-eventservice)
4. [Tasks 13–17](2026-03-13-notifications/04-tasks-13-17.md)
   - [Chunk 4: Bot Integration](2026-03-13-notifications/04-tasks-13-17.md#chunk-4-bot-integration)
   - [Task 13: Constants and i18n for Notifications](2026-03-13-notifications/04-tasks-13-17.md#task-13-constants-and-i18n-for-notifications)
   - [Task 14: Notification Keyboards](2026-03-13-notifications/04-tasks-13-17.md#task-14-notification-keyboards)
   - [Task 15: /notify Command Handler](2026-03-13-notifications/04-tasks-13-17.md#task-15-notify-command-handler)
   - [Task 16: Wire into Bot](2026-03-13-notifications/04-tasks-13-17.md#task-16-wire-into-bot)
   - [Task 17: BullMQ Queue Setup](2026-03-13-notifications/04-tasks-13-17.md#task-17-bullmq-queue-setup)
