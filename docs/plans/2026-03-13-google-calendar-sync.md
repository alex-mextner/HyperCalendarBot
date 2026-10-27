# Google Calendar Sync Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bidirectional Google Calendar sync — OAuth, pull/push, conflict resolution, webhooks (conditional on PUBLIC_DOMAIN), disconnect flow.

**Architecture:** OAuth 2.0 via `googleapis` npm package. Refresh tokens encrypted with AES-256-GCM in SQLite. Sync jobs run via BullMQ (`google-sync` queue). Two modes: webhook (PUBLIC_DOMAIN set) vs polling-only (cron every 15min). Redis for OAuth state + BullMQ.

**Tech Stack:** googleapis, bullmq, bun:sqlite, Bun.serve, AES-256-GCM (node:crypto)

> **Split document.** This file is the index; the full text lives in the ordered parts under [`2026-03-13-google-calendar-sync/`](2026-03-13-google-calendar-sync/). Reading the parts in order reproduces the original document.

## Contents

1. [Overview, tasks 1–4](2026-03-13-google-calendar-sync/01-overview-tasks-1-4.md)
   - [Design Decisions (spec section 14 open questions)](2026-03-13-google-calendar-sync/01-overview-tasks-1-4.md#design-decisions-spec-section-14-open-questions)
   - [Known deviations from spec](2026-03-13-google-calendar-sync/01-overview-tasks-1-4.md#known-deviations-from-spec)
   - [File Structure](2026-03-13-google-calendar-sync/01-overview-tasks-1-4.md#file-structure)
   - [New Files](2026-03-13-google-calendar-sync/01-overview-tasks-1-4.md#new-files)
   - [Modified Files](2026-03-13-google-calendar-sync/01-overview-tasks-1-4.md#modified-files)
   - [Chunk 1: Foundation (env, crypto, migration, types, repositories)](2026-03-13-google-calendar-sync/01-overview-tasks-1-4.md#chunk-1-foundation-env-crypto-migration-types-repositories)
   - [Task 1: Env config — add Google + Redis + web variables](2026-03-13-google-calendar-sync/01-overview-tasks-1-4.md#task-1-env-config--add-google--redis--web-variables)
   - [Task 2: Crypto utility — AES-256-GCM encrypt/decrypt](2026-03-13-google-calendar-sync/01-overview-tasks-1-4.md#task-2-crypto-utility--aes-256-gcm-encryptdecrypt)
   - [Task 3: Database types — add Google sync types](2026-03-13-google-calendar-sync/01-overview-tasks-1-4.md#task-3-database-types--add-google-sync-types)
   - [Task 4: Migration 007 — Google sync tables + event sync fields](2026-03-13-google-calendar-sync/01-overview-tasks-1-4.md#task-4-migration-007--google-sync-tables--event-sync-fields)
2. [Tasks 5–7](2026-03-13-google-calendar-sync/02-tasks-5-7.md)
   - [Task 5: GoogleSyncRepository](2026-03-13-google-calendar-sync/02-tasks-5-7.md#task-5-googlesyncrepository)
   - [Task 6: GoogleCalendarRepository](2026-03-13-google-calendar-sync/02-tasks-5-7.md#task-6-googlecalendarrepository)
   - [Task 7: Wire repos + add repo methods for sync + loggers + shared redis util](2026-03-13-google-calendar-sync/02-tasks-5-7.md#task-7-wire-repos--add-repo-methods-for-sync--loggers--shared-redis-util)
3. [Tasks 8–11](2026-03-13-google-calendar-sync/03-tasks-8-11.md)
   - [Chunk 2: OAuth Flow + Web Server](2026-03-13-google-calendar-sync/03-tasks-8-11.md#chunk-2-oauth-flow--web-server)
   - [Task 8: OAuth service — client creation, auth URL, token exchange](2026-03-13-google-calendar-sync/03-tasks-8-11.md#task-8-oauth-service--client-creation-auth-url-token-exchange)
   - [Task 9: Web server — Bun.serve with OAuth callback route](2026-03-13-google-calendar-sync/03-tasks-8-11.md#task-9-web-server--bunserve-with-oauth-callback-route)
   - [Task 10: /connect_google command](2026-03-13-google-calendar-sync/03-tasks-8-11.md#task-10-connect_google-command)
   - [Task 11: /disconnect_google command](2026-03-13-google-calendar-sync/03-tasks-8-11.md#task-11-disconnect_google-command)
4. [Tasks 12–15](2026-03-13-google-calendar-sync/04-tasks-12-15.md)
   - [Chunk 3: Event Mapper + Calendar API + Calendar Picker](2026-03-13-google-calendar-sync/04-tasks-12-15.md#chunk-3-event-mapper--calendar-api--calendar-picker)
   - [Task 12: Event mapper — local <-> Google conversion](2026-03-13-google-calendar-sync/04-tasks-12-15.md#task-12-event-mapper--local---google-conversion)
   - [Task 13: Google Calendar API wrapper](2026-03-13-google-calendar-sync/04-tasks-12-15.md#task-13-google-calendar-api-wrapper)
   - [Task 14: Calendar picker UI](2026-03-13-google-calendar-sync/04-tasks-12-15.md#task-14-calendar-picker-ui)
   - [Chunk 4: Sync Service (initial pull, incremental pull, push)](2026-03-13-google-calendar-sync/04-tasks-12-15.md#chunk-4-sync-service-initial-pull-incremental-pull-push)
   - [Task 15: Sync service — initial sync](2026-03-13-google-calendar-sync/04-tasks-12-15.md#task-15-sync-service--initial-sync)
5. [Tasks 16–24](2026-03-13-google-calendar-sync/05-tasks-16-24.md)
   - [Chunk 5: BullMQ Queue + Workers + Crons](2026-03-13-google-calendar-sync/05-tasks-16-24.md#chunk-5-bullmq-queue--workers--crons)
   - [Task 16: Google sync BullMQ queue and workers](2026-03-13-google-calendar-sync/05-tasks-16-24.md#task-16-google-sync-bullmq-queue-and-workers)
   - [Task 17: Sync cron + watch renewal cron](2026-03-13-google-calendar-sync/05-tasks-16-24.md#task-17-sync-cron--watch-renewal-cron)
   - [Chunk 6: Bot Integration + Wiring](2026-03-13-google-calendar-sync/05-tasks-16-24.md#chunk-6-bot-integration--wiring)
   - [Task 18: Update EventService to trigger push sync](2026-03-13-google-calendar-sync/05-tasks-16-24.md#task-18-update-eventservice-to-trigger-push-sync)
   - [Task 19: Wire everything into bot + main entrypoint](2026-03-13-google-calendar-sync/05-tasks-16-24.md#task-19-wire-everything-into-bot--main-entrypoint)
   - [Chunk 7: Watch Channel Setup + Conflict Notification + Onboarding + Cleanup](2026-03-13-google-calendar-sync/05-tasks-16-24.md#chunk-7-watch-channel-setup--conflict-notification--onboarding--cleanup)
   - [Task 20: Watch channel setup after initial sync (conditional on PUBLIC_DOMAIN)](2026-03-13-google-calendar-sync/05-tasks-16-24.md#task-20-watch-channel-setup-after-initial-sync-conditional-on-public_domain)
   - [Task 21: Conflict notification to user](2026-03-13-google-calendar-sync/05-tasks-16-24.md#task-21-conflict-notification-to-user)
   - [Task 22: Cleanup cron — sync_log pruning, dead channels](2026-03-13-google-calendar-sync/05-tasks-16-24.md#task-22-cleanup-cron--sync_log-pruning-dead-channels)
   - [Task 23: Google Calendar onboarding prompt](2026-03-13-google-calendar-sync/05-tasks-16-24.md#task-23-google-calendar-onboarding-prompt)
   - [Task 24: Final integration — install googleapis, verify build](2026-03-13-google-calendar-sync/05-tasks-16-24.md#task-24-final-integration--install-googleapis-verify-build)
