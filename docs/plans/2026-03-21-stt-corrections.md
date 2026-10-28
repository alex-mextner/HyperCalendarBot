# STT Corrections Dictionary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-user and global STT post-processing dictionary with phonetic matching, agent tools, and `/dict` bot command — zero AI (Haiku) in the pipeline.

**Architecture:** `TranscriptEnricher` runs Levenshtein/Jaccard against `SttCorrectionsRepository` after each transcript, annotates low-confidence words inline, and attaches `SttMeta` to `AgentContext` so the agent can ask for clarification and call `dict_*` tools to manage the dictionary. Four new AI tools. One bot command with inline-keyboard CRUD.

**Tech Stack:** Bun, bun:sqlite, TypeScript, GramIO, Anthropic SDK.

---

> **Split document.** This file is the index; the full text lives in the ordered parts under [`2026-03-21-stt-corrections/`](2026-03-21-stt-corrections/). Reading the parts in order reproduces the original document.

## Contents

1. [Overview, tasks 1–3](2026-03-21-stt-corrections/01-overview-tasks-1-3.md)
   - [File Map](2026-03-21-stt-corrections/01-overview-tasks-1-3.md#file-map)
   - [Task 1: DB Migration + SttCorrectionsRepository](2026-03-21-stt-corrections/01-overview-tasks-1-3.md#task-1-db-migration--sttcorrectionsrepository)
   - [Task 2: TranscriptEnricher](2026-03-21-stt-corrections/01-overview-tasks-1-3.md#task-2-transcriptenricher)
   - [Task 3: STT Events Extension (Nova + Flux)](2026-03-21-stt-corrections/01-overview-tasks-1-3.md#task-3-stt-events-extension-nova--flux)
2. [Tasks 4–7](2026-03-21-stt-corrections/02-tasks-4-7.md)
   - [Task 4: CallSession Integration](2026-03-21-stt-corrections/02-tasks-4-7.md#task-4-callsession-integration)
   - [Task 5: AgentContext Types + System Prompt](2026-03-21-stt-corrections/02-tasks-4-7.md#task-5-agentcontext-types--system-prompt)
   - [Task 6: Whisper Path Integration](2026-03-21-stt-corrections/02-tasks-4-7.md#task-6-whisper-path-integration)
   - [Task 7: AI Tools (dict_*)](2026-03-21-stt-corrections/02-tasks-4-7.md#task-7-ai-tools-dict_)
3. [Task 8](2026-03-21-stt-corrections/03-task-8.md)
   - [Task 8: /dict Bot Command](2026-03-21-stt-corrections/03-task-8.md#task-8-dict-bot-command)
   - [Final Verification](2026-03-21-stt-corrections/03-task-8.md#final-verification)
