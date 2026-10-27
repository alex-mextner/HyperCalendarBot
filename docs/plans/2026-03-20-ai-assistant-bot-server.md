# AI Assistant — Bot Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add WebSocket infrastructure, pairing, agent registry, dispatcher, and 9 new AI tools to the bot server so the macOS agent can connect and execute commands on the user's machine.

**Architecture:** New `src/agent/` module owns all agent concerns: protocol types, pairing codes, JWT auth, WebSocket connections, command dispatching. New AI tools in `tool-handlers/assistant.ts` delegate to dispatcher. Tools gated by `UserCapabilities` (assistant_enabled DB flag + live connection check at definition-time and at execution-time). Agent.ts caps wiring happens in Task 10 in one place.

**Tech Stack:** Bun WebSocket (Bun.serve), `jose` (JWT HS256), `bun:sqlite` migration, existing GramIO bot

**Spec:** `docs/specs/2026-03-20-ai-assistant-agent-design.md`

---

> **Split document.** This file is the index; the full text lives in the ordered parts under [`2026-03-20-ai-assistant-bot-server/`](2026-03-20-ai-assistant-bot-server/). Reading the parts in order reproduces the original document.

## Contents

1. [Overview, tasks 1–6](2026-03-20-ai-assistant-bot-server/01-overview-tasks-1-6.md)
   - [File Map](2026-03-20-ai-assistant-bot-server/01-overview-tasks-1-6.md#file-map)
   - [New files](2026-03-20-ai-assistant-bot-server/01-overview-tasks-1-6.md#new-files)
   - [Modified files](2026-03-20-ai-assistant-bot-server/01-overview-tasks-1-6.md#modified-files)
   - [Task 1: Protocol types + env config](2026-03-20-ai-assistant-bot-server/01-overview-tasks-1-6.md#task-1-protocol-types--env-config)
   - [Task 2: DB migration + User type](2026-03-20-ai-assistant-bot-server/01-overview-tasks-1-6.md#task-2-db-migration--user-type)
   - [Task 3: Pairing service](2026-03-20-ai-assistant-bot-server/01-overview-tasks-1-6.md#task-3-pairing-service)
   - [Task 4: Agent registry](2026-03-20-ai-assistant-bot-server/01-overview-tasks-1-6.md#task-4-agent-registry)
   - [Task 5: Dispatcher](2026-03-20-ai-assistant-bot-server/01-overview-tasks-1-6.md#task-5-dispatcher)
   - [Task 6: WebSocket server + web/server.ts integration](2026-03-20-ai-assistant-bot-server/01-overview-tasks-1-6.md#task-6-websocket-server--webserverts-integration)
2. [Tasks 7–A3](2026-03-20-ai-assistant-bot-server/02-tasks-7-a3.md)
   - [Task 7: UserCapabilities — gated tool definitions](2026-03-20-ai-assistant-bot-server/02-tasks-7-a3.md#task-7-usercapabilities--gated-tool-definitions)
   - [Task 8: Assistant tool handlers](2026-03-20-ai-assistant-bot-server/02-tasks-7-a3.md#task-8-assistant-tool-handlers)
   - [Task 9: manage_settings — assistant category](2026-03-20-ai-assistant-bot-server/02-tasks-7-a3.md#task-9-manage_settings--assistant-category)
   - [Task 10: system-prompt + agent.ts caps wiring](2026-03-20-ai-assistant-bot-server/02-tasks-7-a3.md#task-10-system-prompt--agentts-caps-wiring)
   - [Task 11: /connect and /activate commands](2026-03-20-ai-assistant-bot-server/02-tasks-7-a3.md#task-11-connect-and-activate-commands)
   - [Task 12: Wire everything in bot/index.ts](2026-03-20-ai-assistant-bot-server/02-tasks-7-a3.md#task-12-wire-everything-in-botindexts)
   - [Acceptance Criteria](2026-03-20-ai-assistant-bot-server/02-tasks-7-a3.md#acceptance-criteria)
   - [AI Assistant — macOS Agent (Swift) Implementation Plan](2026-03-20-ai-assistant-bot-server/02-tasks-7-a3.md#ai-assistant--macos-agent-swift-implementation-plan)
   - [File Map](2026-03-20-ai-assistant-bot-server/02-tasks-7-a3.md#file-map)
   - [Task A1: Xcode project setup + SPM dependencies](2026-03-20-ai-assistant-bot-server/02-tasks-7-a3.md#task-a1-xcode-project-setup--spm-dependencies)
   - [Task A2: Protocol types](2026-03-20-ai-assistant-bot-server/02-tasks-7-a3.md#task-a2-protocol-types)
   - [Task A3: Keychain store + Pairing manager](2026-03-20-ai-assistant-bot-server/02-tasks-7-a3.md#task-a3-keychain-store--pairing-manager)
3. [Tasks A4–A10](2026-03-20-ai-assistant-bot-server/03-tasks-a4-a10.md)
   - [Task A4: WebSocket client](2026-03-20-ai-assistant-bot-server/03-tasks-a4-a10.md#task-a4-websocket-client)
   - [Task A5: App.swift — first-launch detection + wizard window](2026-03-20-ai-assistant-bot-server/03-tasks-a4-a10.md#task-a5-appswift--first-launch-detection--wizard-window)
   - [Task A6: Tray menu with status + launch-at-login toggle](2026-03-20-ai-assistant-bot-server/03-tasks-a4-a10.md#task-a6-tray-menu-with-status--launch-at-login-toggle)
   - [Task A7: WebSocket pairing flow integration](2026-03-20-ai-assistant-bot-server/03-tasks-a4-a10.md#task-a7-websocket-pairing-flow-integration)
   - [Task A8: Claude Desktop Bridge (cookie extraction + claude.ai API)](2026-03-20-ai-assistant-bot-server/03-tasks-a4-a10.md#task-a8-claude-desktop-bridge-cookie-extraction--claudeai-api)
   - [Task A9: Action executors + CommandRouter](2026-03-20-ai-assistant-bot-server/03-tasks-a4-a10.md#task-a9-action-executors--commandrouter)
   - [Task A10: DMG packaging](2026-03-20-ai-assistant-bot-server/03-tasks-a4-a10.md#task-a10-dmg-packaging)
   - [Acceptance Criteria (macOS Agent)](2026-03-20-ai-assistant-bot-server/03-tasks-a4-a10.md#acceptance-criteria-macos-agent)
