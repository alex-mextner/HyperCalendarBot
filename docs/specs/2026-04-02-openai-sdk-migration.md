# Migration: Anthropic SDK → OpenAI SDK

## Motivation

- z.ai proxy supports both Anthropic and OpenAI formats; GLM models work with OpenAI format
- Fallback to DeepSeek R1 via HF Novita requires OpenAI format
- Anthropic SDK provides zero value beyond HTTP transport — all agent logic is ours
- Single SDK for both primary and fallback eliminates format conversion

## Current State

```
@anthropic-ai/sdk → z.ai/api/anthropic → GLM-5.1 / GLM-4.7-flash
```

## Target State

```
openai SDK → z.ai/api/openai → GLM-5.1 / GLM-4.7-flash  (primary)
openai SDK → HF Novita       → DeepSeek-R1               (fallback)
```

## Environment Variables

```env
# Primary (z.ai — OpenAI-compatible endpoint)
ANTHROPIC_API_KEY=...                        # z.ai API key (name kept for compat)
AI_BASE_URL=https://api.z.ai/api/paas/v4    # was /api/anthropic
AI_MODEL=glm-5.1
AI_FAST_MODEL=glm-4.7-flash

# Fallback (HF Inference Providers → Novita → DeepSeek R1)
AI_MODEL_FALLBACK=deepseek-ai/DeepSeek-R1:novita
AI_FAST_MODEL_FALLBACK=deepseek-ai/DeepSeek-V3:novita
AI_BASE_URL_FALLBACK=https://router.huggingface.co/v1
AI_API_KEY_FALLBACK=<HF_TOKEN>
```

## Format Conversion Reference

### Tool Definitions

```
Anthropic:  { name, description, input_schema: { type: "object", properties, required } }
OpenAI:     { type: "function", function: { name, description, parameters: { type: "object", properties, required } } }
```

### System Prompt

```
Anthropic:  system: [{ type: "text", text: "...", cache_control }]
OpenAI:     messages: [{ role: "system", content: "..." }, ...]
```

### Messages

```
Anthropic user:      { role: "user", content: string | ContentBlock[] }
OpenAI user:         { role: "user", content: string }

Anthropic assistant: { role: "assistant", content: [{ type: "text" }, { type: "tool_use", id, name, input }] }
OpenAI assistant:    { role: "assistant", content: "text", tool_calls: [{ id, type: "function", function: { name, arguments } }] }

Anthropic tool:      { role: "user", content: [{ type: "tool_result", tool_use_id, content, is_error }] }
OpenAI tool:         { role: "tool", tool_call_id, content: string }
```

### Streaming

```
Anthropic:  client.messages.stream({ model, system, messages, tools })
            for await (event of stream) — content_block_delta, content_block_start, message_delta
            stream.finalMessage()

OpenAI:     client.chat.completions.create({ model, messages, tools, stream: true })
            for await (chunk of stream) — chunk.choices[0].delta.content, .tool_calls
            No finalMessage — accumulate manually
```

## Files to Change

### Core (agent loop + streaming)
1. **src/services/ai/agent.ts** — main refactor: streaming, message format, tool parsing
2. **src/services/ai/anthropic-client.ts** → **ai-client.ts** — OpenAI client factory
3. **src/services/ai/tools.ts** — tool definition format conversion
4. **src/services/ai/types.ts** — AgentConfig, remove Anthropic types

### Type references only
5. **src/services/ai/debug-logger.ts** — `Anthropic.ContentBlockParam` → own types
6. **src/services/conversation-logger.ts** — same
7. **src/bot/pipeline/intent-matcher-layer.ts** — if it references Anthropic types

### Separate AI calls (non-agent)
8. **src/services/timezone/city-resolver.ts** — simple create() call, no streaming
9. **src/services/voice/tts-translation.ts** — simple create() call
10. **src/services/intent/intent-learner.ts** — simple create() call (fast model)

### Tests
11. **test/services/ai/agent-run.test.ts** — mock format update
12. **test/services/ai/agent.test.ts** — mock format update

## What Does NOT Change

- Tool executor (`tool-executor.ts`) and all tool handlers — input/output format is internal
- Pipeline layers — they call agent.run() which returns the same AgentRunResult
- Message handler — unchanged
- TelegramStreamWriter — unchanged (receives text chunks, doesn't care about SDK)
- System prompt builder — returns string, no SDK types

## Fallback Strategy

Same as current but both clients use OpenAI SDK:

```
Primary (3 retries) → Fallback (1 retry) → Error message to user
```

Fast model calls (intent-learner, city-resolver, tts-translation) also get fallback:
- Primary: AI_FAST_MODEL via primary client
- Fallback: AI_FAST_MODEL_FALLBACK via fallback client

## Internal Types

Replace `Anthropic.*` types with own lightweight types:

```ts
// In src/services/ai/types.ts
interface AiContentBlock {
  type: 'text';
  text: string;
}

interface AiToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string (OpenAI format)
}

// For conversation logger — store as JSON string array of content blocks
```

## Risk

- z.ai OpenAI endpoint URL needs verification (user confirms it exists)
- GLM tool calling quality through OpenAI format — should be same as Anthropic format via z.ai
- DeepSeek R1 tool calling quality — acceptable for fallback
