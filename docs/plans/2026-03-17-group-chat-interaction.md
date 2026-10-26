# Group Chat Interaction & Group Calendar — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable bot interaction in Telegram group chats with group calendars, conversation sessions, and inline mode split.

**Architecture:** Add `scope` parameter to event tools, routing to personal or group calendar. In-memory conversation sessions track active dialogs in groups. AI agent decides per-message whether to respond or skip. Inline mode moves to a separate bot in the same process.

**Tech Stack:** Bun, GramIO, bun:sqlite (WAL), Anthropic SDK, Pyrogram (Python subprocess)

**Spec:** `docs/specs/2026-03-17-group-chat-interaction-design.md`

---

> **Split document.** This file is the index; the full text lives in the ordered parts under [`2026-03-17-group-chat-interaction/`](2026-03-17-group-chat-interaction/). Reading the parts in order reproduces the original document.

## Contents

1. [Tasks 1–6](2026-03-17-group-chat-interaction/01-tasks-1-6.md)
   - [Chunk 1: Data Layer](2026-03-17-group-chat-interaction/01-tasks-1-6.md#chunk-1-data-layer)
   - [Task 1: Migration — events columns + chat_history.chat_id + group_members](2026-03-17-group-chat-interaction/01-tasks-1-6.md#task-1-migration--events-columns--chat_historychat_id--group_members)
   - [Task 2: Type changes — CalendarEvent + CreateEventData](2026-03-17-group-chat-interaction/01-tasks-1-6.md#task-2-type-changes--calendarevent--createeventdata)
   - [Task 3: EventRepository — group-aware methods](2026-03-17-group-chat-interaction/01-tasks-1-6.md#task-3-eventrepository--group-aware-methods)
   - [Task 4: ChatHistoryRepository — chat_id support](2026-03-17-group-chat-interaction/01-tasks-1-6.md#task-4-chathistoryrepository--chat_id-support)
   - [Task 5: GroupMemberRepository](2026-03-17-group-chat-interaction/01-tasks-1-6.md#task-5-groupmemberrepository)
   - [Task 5b: EventService — group-aware methods](2026-03-17-group-chat-interaction/01-tasks-1-6.md#task-5b-eventservice--group-aware-methods)
   - [Chunk 2: Group Session Manager](2026-03-17-group-chat-interaction/01-tasks-1-6.md#chunk-2-group-session-manager)
   - [Task 6: GroupSessionManager](2026-03-17-group-chat-interaction/01-tasks-1-6.md#task-6-groupsessionmanager)
2. [Tasks 7–18](2026-03-17-group-chat-interaction/02-tasks-7-18.md)
   - [Chunk 3: AI Agent Group Support](2026-03-17-group-chat-interaction/02-tasks-7-18.md#chunk-3-ai-agent-group-support)
   - [Task 7: AgentContext extension](2026-03-17-group-chat-interaction/02-tasks-7-18.md#task-7-agentcontext-extension)
   - [Task 8: System prompt — group context block](2026-03-17-group-chat-interaction/02-tasks-7-18.md#task-8-system-prompt--group-context-block)
   - [Task 9: Agent — per-chat history + [SKIP] detection](2026-03-17-group-chat-interaction/02-tasks-7-18.md#task-9-agent--per-chat-history--skip-detection)
   - [Chunk 4: Tool Scope](2026-03-17-group-chat-interaction/02-tasks-7-18.md#chunk-4-tool-scope)
   - [Task 10: Add scope to tool definitions](2026-03-17-group-chat-interaction/02-tasks-7-18.md#task-10-add-scope-to-tool-definitions)
   - [Task 11: Scope routing in tool executor and handlers](2026-03-17-group-chat-interaction/02-tasks-7-18.md#task-11-scope-routing-in-tool-executor-and-handlers)
   - [Chunk 5: Message Handler + /cal Command + Inline Bot Split](2026-03-17-group-chat-interaction/02-tasks-7-18.md#chunk-5-message-handler--cal-command--inline-bot-split)
   - [Task 12: /cal command registration](2026-03-17-group-chat-interaction/02-tasks-7-18.md#task-12-cal-command-registration)
   - [Task 13: Message handler — group session + [SKIP] + isReplyToBot fix](2026-03-17-group-chat-interaction/02-tasks-7-18.md#task-13-message-handler--group-session--skip--isreplytobot-fix)
   - [Task 14: Inline bot split](2026-03-17-group-chat-interaction/02-tasks-7-18.md#task-14-inline-bot-split)
   - [Task 15: Delete dead code](2026-03-17-group-chat-interaction/02-tasks-7-18.md#task-15-delete-dead-code)
   - [Task 15b: ask_user button restriction in groups](2026-03-17-group-chat-interaction/02-tasks-7-18.md#task-15b-ask_user-button-restriction-in-groups)
   - [Task 15c: Session activation via onBotResponse callback](2026-03-17-group-chat-interaction/02-tasks-7-18.md#task-15c-session-activation-via-onbotresponse-callback)
   - [Chunk 6: Pyrogram Members Script + Group Reminders + Google Sync](2026-03-17-group-chat-interaction/02-tasks-7-18.md#chunk-6-pyrogram-members-script--group-reminders--google-sync)
   - [Task 16: Pyrogram get-chat-members script](2026-03-17-group-chat-interaction/02-tasks-7-18.md#task-16-pyrogram-get-chat-members-script)
   - [Task 17: Group event reminders to all members](2026-03-17-group-chat-interaction/02-tasks-7-18.md#task-17-group-event-reminders-to-all-members)
   - [Task 18: Google sync — use created_by for group events](2026-03-17-group-chat-interaction/02-tasks-7-18.md#task-18-google-sync--use-created_by-for-group-events)
   - [Final Verification](2026-03-17-group-chat-interaction/02-tasks-7-18.md#final-verification)
