// src/services/ai/response-validator.ts
import type Anthropic from '@anthropic-ai/sdk';
import { logger } from '../../utils/logger.ts';

const aiLogger = logger.child({ module: 'response-validator' });

const VALIDATION_TIMEOUT_MS = 15_000;
const VALIDATION_MAX_TOKENS = 256;

const VALIDATION_PROMPT = `You are a strict QA validator for a calendar assistant bot.

Your job: check the assistant's response for problems. Be fast and decisive.

## AUTOMATIC REJECT reasons:
1. **No tool calls for data questions** — if the user asked about events, schedule, reminders, contacts, free slots, or any calendar data, the assistant MUST have called at least one tool. Answering from memory/context/conversation history is NEVER acceptable — calendar state changes between messages.
2. **No tool calls for mutation requests** — if the user asked to create, edit, delete, move, or manage an event, reminder, contact, or setting, the assistant MUST have called a tool. Saying "done", "noted", or "I'll do that" WITHOUT calling a tool is NEVER acceptable.
3. **Hallucinated data** — events, dates, times, locations, or contact info that don't appear in tool results.
4. **Claimed "not found" without searching** — if the assistant says an event doesn't exist but didn't call search_events, get_events, or get_upcoming, that's a hallucination.

## AUTOMATIC APPROVE:
- Greeting, help, or conversational responses (no tools needed).
- Response correctly uses data from tool results with no fabrication.
- Assistant explicitly told the user data is incomplete/unavailable after attempting a search.
- Follow-up questions or clarifications before taking action.
- [SKIP] responses (silent mode in groups).

Respond with EXACTLY one line:
APPROVE
or
REJECT: <short reason in the language of the user's message>`;

interface ValidationInput {
  userMessage: string;
  toolCalls: string[];
  response: string;
}

export type ValidationResult = { approved: true } | { approved: false; reason: string };

export async function validateResponse(
  client: Anthropic,
  model: string,
  input: ValidationInput,
): Promise<ValidationResult> {
  const toolCallsSummary = input.toolCalls.length > 0 ? input.toolCalls.join(', ') : '(none — no tools were called)';

  const userContent = `USER MESSAGE: ${input.userMessage}

TOOL CALLS MADE: ${toolCallsSummary}

ASSISTANT RESPONSE (first 2000 chars):
${input.response.substring(0, 2000)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);

  try {
    const result = await client.messages.create(
      {
        model,
        max_tokens: VALIDATION_MAX_TOKENS,
        system: VALIDATION_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      },
      { signal: controller.signal },
    );

    const text = result.content[0]?.type === 'text' ? result.content[0].text.trim() : '';

    aiLogger.info({ result: text }, 'Response validation result');

    if (text.startsWith('APPROVE')) {
      return { approved: true };
    }

    const reason = text.replace(/^REJECT:\s*/i, '').trim() || 'Validation failed';
    return { approved: false, reason };
  } catch (err) {
    aiLogger.error({ err }, 'Response validation failed');
    // No tools called → likely hallucination, reject to force retry
    if (input.toolCalls.length === 0) {
      return {
        approved: false,
        reason: 'Validator unavailable and no tools were called — likely hallucination',
      };
    }
    // Tools were called → data is probably real
    return { approved: true };
  } finally {
    clearTimeout(timeout);
  }
}
