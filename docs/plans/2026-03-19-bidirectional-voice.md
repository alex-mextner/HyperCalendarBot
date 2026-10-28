# Bidirectional Voice Calls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing one-way voice call system with full bidirectional audio — the bot listens to the user during a live Telegram call via VAD + Deepgram streaming STT, detects when the user wants to respond, classifies interruptions with Haiku (RU) or Flux EOT (EN), and replies with synthesized audio and pre-recorded thinking phrases.

**Architecture:** A Bun WebSocket server on `:3001` manages N concurrent `CallSession` instances, each owning its STT connection, classifier, and agent. The existing Python bridge (`scripts/voice-call-bridge.py`) is rewritten to accept a `sessionId`, connect to the WS server, capture incoming audio via pytgcalls + Silero VAD, and stream PCM frames to Bun. Bun handles all AI logic (Nova-3 for RU, Flux for EN, Haiku classifier, CalendarBotAgent, TTS) and sends `PLAY`/`PAUSE`/`RESUME`/`STOP` commands back to Python.

**Tech Stack:** Bun built-in WebSocket (client + server), Deepgram Nova-3/Flux via raw WS protocol, Anthropic Haiku for RU interruption classification, pytgcalls + Silero VAD in Python, OGG Opus via Silero/Kokoro/Google TTS fallback.

---

> **Split document.** This file is the index; the full text lives in the ordered parts under [`2026-03-19-bidirectional-voice/`](2026-03-19-bidirectional-voice/). Reading the parts in order reproduces the original document.

## Contents

1. [Overview, tasks 1–5](2026-03-19-bidirectional-voice/01-overview-tasks-1-5.md)
   - [File Structure](2026-03-19-bidirectional-voice/01-overview-tasks-1-5.md#file-structure)
   - [New files](2026-03-19-bidirectional-voice/01-overview-tasks-1-5.md#new-files)
   - [Modified files](2026-03-19-bidirectional-voice/01-overview-tasks-1-5.md#modified-files)
   - [Test files](2026-03-19-bidirectional-voice/01-overview-tasks-1-5.md#test-files)
   - [Task 1: inputMode type change](2026-03-19-bidirectional-voice/01-overview-tasks-1-5.md#task-1-inputmode-type-change)
   - [Task 2: Generate thinking phrases script + .gitignore](2026-03-19-bidirectional-voice/01-overview-tasks-1-5.md#task-2-generate-thinking-phrases-script--gitignore)
   - [Task 3: NovaStreamingSTT](2026-03-19-bidirectional-voice/01-overview-tasks-1-5.md#task-3-novastreamingstt)
   - [3.1 Write failing tests](2026-03-19-bidirectional-voice/01-overview-tasks-1-5.md#31-write-failing-tests)
   - [Task 4: FluxStreamingSTT](2026-03-19-bidirectional-voice/01-overview-tasks-1-5.md#task-4-fluxstreamingstt)
   - [4.1 Write failing tests](2026-03-19-bidirectional-voice/01-overview-tasks-1-5.md#41-write-failing-tests)
   - [Task 5: InterruptionClassifier](2026-03-19-bidirectional-voice/01-overview-tasks-1-5.md#task-5-interruptionclassifier)
   - [5.1 Write failing tests](2026-03-19-bidirectional-voice/01-overview-tasks-1-5.md#51-write-failing-tests)
2. [Tasks 6–8](2026-03-19-bidirectional-voice/02-tasks-6-8.md)
   - [Task 6: ThinkingPhrasePlayer](2026-03-19-bidirectional-voice/02-tasks-6-8.md#task-6-thinkingphraseplayer)
   - [6.1 Write failing tests](2026-03-19-bidirectional-voice/02-tasks-6-8.md#61-write-failing-tests)
   - [Task 7: CallSession state machine](2026-03-19-bidirectional-voice/02-tasks-6-8.md#task-7-callsession-state-machine)
   - [7.1 Write failing tests](2026-03-19-bidirectional-voice/02-tasks-6-8.md#71-write-failing-tests)
   - [Task 8: CallSessionManager + WebSocket server](2026-03-19-bidirectional-voice/02-tasks-6-8.md#task-8-callsessionmanager--websocket-server)
3. [Tasks 9–12](2026-03-19-bidirectional-voice/03-tasks-9-12.md)
   - [Task 9: CallManager — primary/fallback TTS + bidirectional support](2026-03-19-bidirectional-voice/03-tasks-9-12.md#task-9-callmanager--primaryfallback-tts--bidirectional-support)
   - [Task 10: Python bridge — bidirectional rewrite](2026-03-19-bidirectional-voice/03-tasks-9-12.md#task-10-python-bridge--bidirectional-rewrite)
   - [Task 11: Wire CallSessionManager into main index](2026-03-19-bidirectional-voice/03-tasks-9-12.md#task-11-wire-callsessionmanager-into-main-index)
   - [Task 12: End-to-end integration test (manual)](2026-03-19-bidirectional-voice/03-tasks-9-12.md#task-12-end-to-end-integration-test-manual)
   - [Deploy Notes](2026-03-19-bidirectional-voice/03-tasks-9-12.md#deploy-notes)
