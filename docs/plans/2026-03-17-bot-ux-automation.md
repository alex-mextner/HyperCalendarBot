# Bot UX & Automation System — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add pipeline message routing, intent automation, unified settings, feedback system, voice response prompt, auto-pin, and timezone in invitations.

**Architecture:** Sequential pipeline replaces monolithic message handler. IntentMatcher (SQLite + in-memory index) handles known phrases without AI. FeedbackRouter enriches context for AI. IntentLearner runs async after AI responses. Unified `manage_settings` tool replaces 7 fragmented tools.

**Tech Stack:** Bun, GramIO, bun:sqlite, Anthropic SDK (Haiku for IntentLearner)

**Spec:** `docs/specs/2026-03-17-bot-ux-automation.md`

---

> **Split document.** This file is the index; the full text lives in the ordered parts under [`2026-03-17-bot-ux-automation/`](2026-03-17-bot-ux-automation/). Reading the parts in order reproduces the original document.

## Contents

1. [Tasks 1–9](2026-03-17-bot-ux-automation/01-tasks-1-9.md)
   - [Task 1: BOT_ADMIN_ID Configuration](2026-03-17-bot-ux-automation/01-tasks-1-9.md#task-1-bot_admin_id-configuration)
   - [Task 2: Database Migrations (016–019)](2026-03-17-bot-ux-automation/01-tasks-1-9.md#task-2-database-migrations-016019)
   - [Task 3: Intent Repository](2026-03-17-bot-ux-automation/01-tasks-1-9.md#task-3-intent-repository)
   - [Task 4: Feedback Repository](2026-03-17-bot-ux-automation/01-tasks-1-9.md#task-4-feedback-repository)
   - [Task 5: Intent Matcher Service](2026-03-17-bot-ux-automation/01-tasks-1-9.md#task-5-intent-matcher-service)
   - [Task 6: Workflow Expression Evaluator](2026-03-17-bot-ux-automation/01-tasks-1-9.md#task-6-workflow-expression-evaluator)
   - [Task 7: Workflow Variable Resolver & Executor](2026-03-17-bot-ux-automation/01-tasks-1-9.md#task-7-workflow-variable-resolver--executor)
   - [Task 8: Response Formatters for Intents](2026-03-17-bot-ux-automation/01-tasks-1-9.md#task-8-response-formatters-for-intents)
   - [Task 9: Pipeline Architecture — Refactor Message Handler](2026-03-17-bot-ux-automation/01-tasks-1-9.md#task-9-pipeline-architecture--refactor-message-handler)
2. [Tasks 10–20](2026-03-17-bot-ux-automation/02-tasks-10-20.md)
   - [Task 10: Unified Settings Tool](2026-03-17-bot-ux-automation/02-tasks-10-20.md#task-10-unified-settings-tool)
   - [Task 11: Unified /settings Command UI](2026-03-17-bot-ux-automation/02-tasks-10-20.md#task-11-unified-settings-command-ui)
   - [Task 12: Feedback Tool & Admin Messaging](2026-03-17-bot-ux-automation/02-tasks-10-20.md#task-12-feedback-tool--admin-messaging)
   - [Task 13: Bot Info Tool](2026-03-17-bot-ux-automation/02-tasks-10-20.md#task-13-bot-info-tool)
   - [Task 14: Voice Response Prompt](2026-03-17-bot-ux-automation/02-tasks-10-20.md#task-14-voice-response-prompt)
   - [Task 15: Auto-Pin Calendar Images](2026-03-17-bot-ux-automation/02-tasks-10-20.md#task-15-auto-pin-calendar-images)
   - [Task 16: Timezone in Invitations](2026-03-17-bot-ux-automation/02-tasks-10-20.md#task-16-timezone-in-invitations)
   - [Task 17: IntentLearner Background Agent](2026-03-17-bot-ux-automation/02-tasks-10-20.md#task-17-intentlearner-background-agent)
   - [Task 18: Admin Intent Verification UI](2026-03-17-bot-ux-automation/02-tasks-10-20.md#task-18-admin-intent-verification-ui)
   - [Task 19: Wire IntentLearner into Pipeline](2026-03-17-bot-ux-automation/02-tasks-10-20.md#task-19-wire-intentlearner-into-pipeline)
   - [Task 20: Integration Test & Final Wiring](2026-03-17-bot-ux-automation/02-tasks-10-20.md#task-20-integration-test--final-wiring)
