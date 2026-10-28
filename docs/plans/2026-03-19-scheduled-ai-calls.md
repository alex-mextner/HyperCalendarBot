# Scheduled AI Calls & Trigger System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add time-based scheduled AI pipeline invocations and event-driven trigger system so users can say "call me tomorrow" or "notify me when a meeting is added".

**Architecture:** BullMQ `ai-messages` queue + `SyntheticPipelineRunner` that runs IntentMatcher → AiAgent without a GramIO context. `DomainEventBus` (in-process typed EventEmitter) carries domain events to `TriggerService` which evaluates conditions and pushes jobs to the same queue. 6 new AI tools expose both systems.

**Tech Stack:** BullMQ, bun:sqlite, `expression-evaluator.ts` (existing), `nanoid`, TypeScript

**Spec:** `docs/specs/2026-03-19-scheduled-ai-calls-design.md`

---

> **Split document.** This file is the index; the full text lives in the ordered parts under [`2026-03-19-scheduled-ai-calls/`](2026-03-19-scheduled-ai-calls/). Reading the parts in order reproduces the original document.

## Contents

1. [Overview, tasks 1–4](2026-03-19-scheduled-ai-calls/01-overview-tasks-1-4.md)
   - [File Map](2026-03-19-scheduled-ai-calls/01-overview-tasks-1-4.md#file-map)
   - [Task 1: DB migrations — 3 new tables](2026-03-19-scheduled-ai-calls/01-overview-tasks-1-4.md#task-1-db-migrations--3-new-tables)
   - [Task 2: DomainEventBus](2026-03-19-scheduled-ai-calls/01-overview-tasks-1-4.md#task-2-domaineventbus)
   - [Task 3: TriggerRepository + ScheduledAiCallRepository](2026-03-19-scheduled-ai-calls/01-overview-tasks-1-4.md#task-3-triggerrepository--scheduledaicallrepository)
   - [Task 4: TriggerService](2026-03-19-scheduled-ai-calls/01-overview-tasks-1-4.md#task-4-triggerservice)
2. [Tasks 5–10](2026-03-19-scheduled-ai-calls/02-tasks-5-10.md)
   - [Task 5: ScheduledAiCallService](2026-03-19-scheduled-ai-calls/02-tasks-5-10.md#task-5-scheduledaicallservice)
   - [Task 6: Create AgentContextBuilder shared type](2026-03-19-scheduled-ai-calls/02-tasks-5-10.md#task-6-create-agentcontextbuilder-shared-type)
   - [Task 7: ai-messages queue + SyntheticPipelineRunner](2026-03-19-scheduled-ai-calls/02-tasks-5-10.md#task-7-ai-messages-queue--syntheticpipelinerunner)
   - [Task 8: EventStartingChecker](2026-03-19-scheduled-ai-calls/02-tasks-5-10.md#task-8-eventstartingchecker)
   - [Task 9: Emit domain events from EventService + InvitationService](2026-03-19-scheduled-ai-calls/02-tasks-5-10.md#task-9-emit-domain-events-from-eventservice--invitationservice)
   - [Task 10: Emit conflictDetected from events tool handler](2026-03-19-scheduled-ai-calls/02-tasks-5-10.md#task-10-emit-conflictdetected-from-events-tool-handler)
3. [Tasks 11–15](2026-03-19-scheduled-ai-calls/03-tasks-11-15.md)
   - [Task 11: AI tool handlers for scheduled calls + triggers](2026-03-19-scheduled-ai-calls/03-tasks-11-15.md#task-11-ai-tool-handlers-for-scheduled-calls--triggers)
   - [Task 12: Wire tools.ts + tool-executor.ts](2026-03-19-scheduled-ai-calls/03-tasks-11-15.md#task-12-wire-toolsts--tool-executorts)
   - [Task 13: Expose agentContextBuilder + runSyntheticPipeline from createBot()](2026-03-19-scheduled-ai-calls/03-tasks-11-15.md#task-13-expose-agentcontextbuilder--runsyntheticpipeline-from-createbot)
   - [Task 14: Wire ai-messages worker + EventStartingChecker in src/index.ts](2026-03-19-scheduled-ai-calls/03-tasks-11-15.md#task-14-wire-ai-messages-worker--eventstartingchecker-in-srcindexts)
   - [Task 15: Final verification](2026-03-19-scheduled-ai-calls/03-tasks-11-15.md#task-15-final-verification)
