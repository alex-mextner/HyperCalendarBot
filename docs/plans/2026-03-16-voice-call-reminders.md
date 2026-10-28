# Voice Call Reminders — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bot calls users via Telegram voice calls to play TTS-synthesized event reminders. No voice capture in v1 — post-call inline buttons for snooze/cancel/acknowledge.

**Architecture:** MTProto userbot (@mtcute/bun) handles call signaling (phone.requestCall, DH exchange). ntgcalls C++ library (via Bun FFI) handles WebRTC media transport — plays TTS audio into the call. Edge TTS synthesizes reminder text. BullMQ call-reminder queue dispatches calls from existing notification system. After call ends, bot sends inline keyboard with actions.

**Tech Stack:** @mtcute/bun (MTProto), ntgcalls (C++ via Bun FFI), edge-tts (TTS synthesis), BullMQ + Redis, bun:sqlite

**Spec:** `docs/specs/07-voice-calls.md`
**Architecture spec:** `docs/specs/00-common-architecture.md`

**Testing:** All new `src/` modules must have ≥80% line coverage (enforced by `bunfig.toml`). Each task includes red tests (error paths, edge cases, invalid input) alongside happy-path tests. Run `bun test --coverage` after each chunk to verify.

---

> **Split document.** This file is the index; the full text lives in the ordered parts under [`2026-03-16-voice-call-reminders/`](2026-03-16-voice-call-reminders/). Reading the parts in order reproduces the original document.

## Contents

1. [Overview, tasks 1–4](2026-03-16-voice-call-reminders/01-overview-tasks-1-4.md)
   - [File Structure](2026-03-16-voice-call-reminders/01-overview-tasks-1-4.md#file-structure)
   - [New files](2026-03-16-voice-call-reminders/01-overview-tasks-1-4.md#new-files)
   - [Modified files](2026-03-16-voice-call-reminders/01-overview-tasks-1-4.md#modified-files)
   - [Test files (mirror src/ structure)](2026-03-16-voice-call-reminders/01-overview-tasks-1-4.md#test-files-mirror-src-structure)
   - [Binary dependencies (not in git)](2026-03-16-voice-call-reminders/01-overview-tasks-1-4.md#binary-dependencies-not-in-git)
   - [Chunk 1: Database Foundation + TTS Text Rendering](2026-03-16-voice-call-reminders/01-overview-tasks-1-4.md#chunk-1-database-foundation--tts-text-rendering)
   - [Task 1: Migration 009 — voice call tables](2026-03-16-voice-call-reminders/01-overview-tasks-1-4.md#task-1-migration-009--voice-call-tables)
   - [Task 2: CallSettingsRepository + CallLogRepository](2026-03-16-voice-call-reminders/01-overview-tasks-1-4.md#task-2-callsettingsrepository--calllogrepository)
   - [Task 3: TTS Text Renderer — speech-friendly reminder text](2026-03-16-voice-call-reminders/01-overview-tasks-1-4.md#task-3-tts-text-renderer--speech-friendly-reminder-text)
   - [Task 4: TTS Service — Edge TTS synthesis + caching](2026-03-16-voice-call-reminders/01-overview-tasks-1-4.md#task-4-tts-service--edge-tts-synthesis--caching)
2. [Tasks 5–6](2026-03-16-voice-call-reminders/02-tasks-5-6.md)
   - [Chunk 2: ntgcalls FFI Bindings + MTProto Signaling](2026-03-16-voice-call-reminders/02-tasks-5-6.md#chunk-2-ntgcalls-ffi-bindings--mtproto-signaling)
   - [Task 5: Download ntgcalls binaries + create FFI bindings](2026-03-16-voice-call-reminders/02-tasks-5-6.md#task-5-download-ntgcalls-binaries--create-ffi-bindings)
   - [Task 6: MTProto userbot client with @mtcute](2026-03-16-voice-call-reminders/02-tasks-5-6.md#task-6-mtproto-userbot-client-with-mtcute)
3. [Tasks 7–12](2026-03-16-voice-call-reminders/03-tasks-7-12.md)
   - [Chunk 3: Call Manager + Queue + Bot Integration](2026-03-16-voice-call-reminders/03-tasks-7-12.md#chunk-3-call-manager--queue--bot-integration)
   - [Task 7: Voice call types + logger](2026-03-16-voice-call-reminders/03-tasks-7-12.md#task-7-voice-call-types--logger)
   - [Task 8: Call Manager — orchestrate TTS → call → audio → end](2026-03-16-voice-call-reminders/03-tasks-7-12.md#task-8-call-manager--orchestrate-tts--call--audio--end)
   - [Task 9: BullMQ call-reminder queue and worker](2026-03-16-voice-call-reminders/03-tasks-7-12.md#task-9-bullmq-call-reminder-queue-and-worker)
   - [Task 10: Constants + /callsettings command + bot wiring](2026-03-16-voice-call-reminders/03-tasks-7-12.md#task-10-constants--callsettings-command--bot-wiring)
   - [Task 11: Integrate with notification scheduler](2026-03-16-voice-call-reminders/03-tasks-7-12.md#task-11-integrate-with-notification-scheduler)
   - [Task 12: Final verification](2026-03-16-voice-call-reminders/03-tasks-7-12.md#task-12-final-verification)
   - [Implementation Notes](2026-03-16-voice-call-reminders/03-tasks-7-12.md#implementation-notes)
   - [What this plan delivers (v1 MVP)](2026-03-16-voice-call-reminders/03-tasks-7-12.md#what-this-plan-delivers-v1-mvp)
   - [Research conclusions (resolved)](2026-03-16-voice-call-reminders/03-tasks-7-12.md#research-conclusions-resolved)
   - [Remaining follow-up work](2026-03-16-voice-call-reminders/03-tasks-7-12.md#remaining-follow-up-work)
   - [Risks](2026-03-16-voice-call-reminders/03-tasks-7-12.md#risks)
