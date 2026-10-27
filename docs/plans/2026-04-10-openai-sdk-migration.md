# OpenAI SDK Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Anthropic SDK with OpenAI SDK and add multi-provider fallback chains for reliability.

**Architecture:** Single unified streaming API `aiStreamRound()` backed by provider chains. Callbacks are optional — services without UI (validator, intent-learner, city-resolver, tts-translation) call it without callbacks and collect the full result. Two chains: main (heavy tool calling) and light (cheap/fast internal calls) selected via `{ fast: true }` option. All providers use OpenAI SDK with different `baseURL` (z.ai coding endpoint, HF router, Gemini OpenAI-compat). All base URLs and models are loaded from env — no hardcoded values.

**Chains:**
- `SMART_CHAIN = z.ai ${ZAI_MODEL} → Gemini ${GEMINI_MODEL} → HF ${HF_MODEL}`
- `FAST_CHAIN = z.ai ${ZAI_FAST_MODEL} → Gemini ${GEMINI_FAST_MODEL} → HF ${HF_FAST_MODEL}`

**Defaults (via env):**
- `ZAI_BASE_URL=https://api.z.ai/api/coding/paas/v4`, `ZAI_MODEL=glm-5.1`, `ZAI_FAST_MODEL=glm-4.7-flash`
- `HF_BASE_URL=https://router.huggingface.co/v1`, `HF_MODEL=Qwen/Qwen3-235B-A22B`, `HF_FAST_MODEL=meta-llama/Llama-3.3-70B-Instruct`
- `GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/`, `GEMINI_MODEL=gemini-2.5-pro`, `GEMINI_FAST_MODEL=gemini-2.5-flash`

**z.ai coding endpoint quirk:** Returns `content: ''` and populates `reasoning_content` for text-only responses (no tool calls). Tool calling works fine. Post-tool-result rounds also return proper `content`. Strategy: if z.ai returns 200 with empty text AND no tool calls, treat as provider failure → fall through to Gemini. This only affects pure text responses (greetings, [SKIP]), which are fine handled by Gemini.

**Tech Stack:** `openai` npm package (replacing `@anthropic-ai/sdk`), Bun runtime.

---

> **Split document.** This file is the index; the full text lives in the ordered parts under [`2026-04-10-openai-sdk-migration/`](2026-04-10-openai-sdk-migration/). Reading the parts in order reproduces the original document.

## Contents

1. [Overview, tasks 1–4](2026-04-10-openai-sdk-migration/01-overview-tasks-1-4.md)
   - [File Structure](2026-04-10-openai-sdk-migration/01-overview-tasks-1-4.md#file-structure)
   - [Task 1: Environment config — add new provider keys (all required)](2026-04-10-openai-sdk-migration/01-overview-tasks-1-4.md#task-1-environment-config--add-new-provider-keys-all-required)
   - [Task 2: Create OpenAI clients module](2026-04-10-openai-sdk-migration/01-overview-tasks-1-4.md#task-2-create-openai-clients-module)
   - [Task 3: Create unified streaming module](2026-04-10-openai-sdk-migration/01-overview-tasks-1-4.md#task-3-create-unified-streaming-module)
   - [Task 4: Convert tool definitions to OpenAI format](2026-04-10-openai-sdk-migration/01-overview-tasks-1-4.md#task-4-convert-tool-definitions-to-openai-format)
2. [Tasks 5–13](2026-04-10-openai-sdk-migration/02-tasks-5-13.md)
   - [Task 5: Rewrite agent.ts streaming loop](2026-04-10-openai-sdk-migration/02-tasks-5-13.md#task-5-rewrite-agentts-streaming-loop)
   - [Task 6: Update response-validator.ts](2026-04-10-openai-sdk-migration/02-tasks-5-13.md#task-6-update-response-validatorts)
   - [Task 7: Migrate intent-learner.ts](2026-04-10-openai-sdk-migration/02-tasks-5-13.md#task-7-migrate-intent-learnerts)
   - [Task 8: Migrate city-resolver.ts and tts-translation.ts](2026-04-10-openai-sdk-migration/02-tasks-5-13.md#task-8-migrate-city-resolverts-and-tts-translationts)
   - [Task 9: Update debug-logger.ts types](2026-04-10-openai-sdk-migration/02-tasks-5-13.md#task-9-update-debug-loggerts-types)
   - [Task 10: Simplify AgentConfig and index.ts wiring](2026-04-10-openai-sdk-migration/02-tasks-5-13.md#task-10-simplify-agentconfig-and-indexts-wiring)
   - [Task 11: Delete anthropic-client.ts and remove @anthropic-ai/sdk](2026-04-10-openai-sdk-migration/02-tasks-5-13.md#task-11-delete-anthropic-clientts-and-remove-anthropic-aisdk)
   - [Task 12: Integration test](2026-04-10-openai-sdk-migration/02-tasks-5-13.md#task-12-integration-test)
   - [Task 13: Final verification](2026-04-10-openai-sdk-migration/02-tasks-5-13.md#task-13-final-verification)
