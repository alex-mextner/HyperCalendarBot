# Connect Telegram Account — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to connect their Telegram account so the bot can send event invitations from the user's own account to people who haven't started the bot, using a first-person message format that feels personal.

**Architecture:** GramIO scene guides the user through Pyrogram auth flow (phone → OTP → optional 2FA). Encrypted session + encrypted phone number stored in SQLite. On invitation delivery, the user's session is tried before the admin MTProto fallback, with a first-person invitation text. Settings menu shows connection status with connect / disconnect actions. Master key is verified at startup against an existing session to fail fast if rotated incorrectly.

**Tech stack:** AES-256-GCM (`node:crypto`), Pyrogram (Python bridge via `Bun.spawn`), `@gramio/scenes` ^0.5, `bun:sqlite`, zod v4 (`z.codec` for JSON parsing without external try/catch).

**Scope note:** All spec sections are in scope, including §10.1 (contextual connect prompt), §10.2 (post-connect invitation flow), and §13 (automatic timezone detection). These are implemented in Tasks 12 and 13 after the core flow is complete in Tasks 1–11.

**Spec:** `docs/specs/2026-03-24-connect-telegram.md`

---

> **Split document.** This file is the index; the full text lives in the ordered parts under [`2026-03-25-connect-telegram/`](2026-03-25-connect-telegram/). Reading the parts in order reproduces the original document.

## Contents

1. [Overview, tasks 1–3](2026-03-25-connect-telegram/01-overview-tasks-1-3.md)
   - [File Structure](2026-03-25-connect-telegram/01-overview-tasks-1-3.md#file-structure)
   - [New files](2026-03-25-connect-telegram/01-overview-tasks-1-3.md#new-files)
   - [Modified files](2026-03-25-connect-telegram/01-overview-tasks-1-3.md#modified-files)
   - [Task 1: Config, Types & Migration](2026-03-25-connect-telegram/01-overview-tasks-1-3.md#task-1-config-types--migration)
   - [Task 2: Session & Phone Crypto](2026-03-25-connect-telegram/01-overview-tasks-1-3.md#task-2-session--phone-crypto)
   - [Task 3: Master-Key Startup Verification (Fail-Fast)](2026-03-25-connect-telegram/01-overview-tasks-1-3.md#task-3-master-key-startup-verification-fail-fast)
2. [Tasks 4–6](2026-03-25-connect-telegram/02-tasks-4-6.md)
   - [Task 4: I18N Strings](2026-03-25-connect-telegram/02-tasks-4-6.md#task-4-i18n-strings)
   - [Task 5: Python Bridge Scripts](2026-03-25-connect-telegram/02-tasks-4-6.md#task-5-python-bridge-scripts)
   - [Task 6: TypeScript Session Bridge (zod-codec stdout parsing)](2026-03-25-connect-telegram/02-tasks-4-6.md#task-6-typescript-session-bridge-zod-codec-stdout-parsing)
3. [Tasks 7–8](2026-03-25-connect-telegram/03-tasks-7-8.md)
   - [Task 7: First-Person Invitation Text (spec §11)](2026-03-25-connect-telegram/03-tasks-7-8.md#task-7-first-person-invitation-text-spec-11)
   - [Task 8: GramIO Scene](2026-03-25-connect-telegram/03-tasks-7-8.md#task-8-gramio-scene)
4. [Tasks 9–11](2026-03-25-connect-telegram/04-tasks-9-11.md)
   - [Task 9: Connected-User Sender + Delivery Chain](2026-03-25-connect-telegram/04-tasks-9-11.md#task-9-connected-user-sender--delivery-chain)
   - [Task 10: Bot Commands, Settings UI, Feature Tracking, Master-Key Startup Check](2026-03-25-connect-telegram/04-tasks-9-11.md#task-10-bot-commands-settings-ui-feature-tracking-master-key-startup-check)
   - [Task 11: AI Tool — connect_telegram_status](2026-03-25-connect-telegram/04-tasks-9-11.md#task-11-ai-tool--connect_telegram_status)
5. [Tasks 12–14](2026-03-25-connect-telegram/05-tasks-12-14.md)
   - [Task 12: Contextual Connect Prompt + Post-Connect Invitation Flow (spec §10.1 / §10.2)](2026-03-25-connect-telegram/05-tasks-12-14.md#task-12-contextual-connect-prompt--post-connect-invitation-flow-spec-101--102)
   - [Task 13: Automatic Timezone Detection (spec §13)](2026-03-25-connect-telegram/05-tasks-12-14.md#task-13-automatic-timezone-detection-spec-13)
   - [Task 14: Final Integration](2026-03-25-connect-telegram/05-tasks-12-14.md#task-14-final-integration)
   - [Summary](2026-03-25-connect-telegram/05-tasks-12-14.md#summary)
