// src/services/ai/response-validator.ts
// Quality validator for text-only agent responses.
//
// After the agent finishes a round without any tool calls, the validator checks
// whether the response looks hallucinated — e.g. the model claims "you have
// nothing scheduled today" without actually calling get_events. If the validator
// rejects, the agent retries with a strong system nudge to USE THE TOOLS.
//
// Uses the FAST chain (cheap/fast models) via aiStreamRound({ fast: true }).

import { logger } from '../../utils/logger.ts';
import { aiStreamRound } from './streaming.ts';

const aiLogger = logger.child({ module: 'response-validator' });

const VALIDATION_TIMEOUT_MS = 15_000;
const VALIDATION_MAX_TOKENS = 256;

/**
 * Injection point for tests. Same signature as aiStreamRound — tests can
 * pass a scripted impl to avoid real network calls from inside the validator.
 */
type StreamImpl = typeof aiStreamRound;

const VALIDATION_PROMPT = `You are a strict QA validator for a calendar assistant bot.

Your job: decide whether the assistant's response is TRUSTWORTHY.

APPROVE the response when:
  - The assistant called tools and its final text is consistent with the tool results.
  - The assistant answered a chit-chat / meta question where tools were not needed
    (e.g. "hi", "thanks", "can you speak Russian?", "who are you?").
  - The assistant politely refused or asked a clarifying question.

REJECT the response when:
  - The assistant claims facts about the user's calendar, events, free slots,
    reminders, holidays, contacts, or settings without calling the matching tool.
  - The assistant confidently invents event titles, times, or IDs.
  - The assistant says "I've checked your calendar" or similar without a get_events /
    search_events / get_upcoming / etc. call.
  - The assistant mentions specific event data that could not have come from a
    hardcoded source.

Respond with exactly one line:
  APPROVE
  REJECT: <short reason>
`;

interface ValidationInput {
  userMessage: string;
  toolCalls: string[];
  response: string;
}

export type ValidationResult = { approved: true } | { approved: false; reason: string };

/**
 * Validate an agent response. Fails open (approved=true) on transient errors
 * as long as the agent DID call at least one tool — calling-the-tools is the
 * main signal we want to reward. If no tools were called AND the validator
 * itself is unavailable, we fail closed (approved=false) because an untested
 * tool-less answer is the most likely hallucination.
 */
export async function validateResponse(
  input: ValidationInput,
  streamImpl: StreamImpl = aiStreamRound,
): Promise<ValidationResult> {
  const toolCallsSummary = input.toolCalls.length > 0 ? input.toolCalls.join(', ') : '(none — no tools were called)';

  const userContent = `USER MESSAGE: ${input.userMessage}\n\nTOOL CALLS MADE: ${toolCallsSummary}\n\nASSISTANT RESPONSE (first 2000 chars):\n${input.response.slice(0, 2000)}`;

  try {
    const result = await streamImpl({
      messages: [
        { role: 'system', content: VALIDATION_PROMPT },
        { role: 'user', content: userContent },
      ],
      maxTokens: VALIDATION_MAX_TOKENS,
      fast: true,
      signal: AbortSignal.timeout(VALIDATION_TIMEOUT_MS),
    });

    const text = result.text.trim();
    aiLogger.info({ result: text, providerUsed: result.providerUsed }, 'Response validation result');

    if (text.toUpperCase().startsWith('APPROVE')) return { approved: true };

    const reason = text.replace(/^REJECT:\s*/i, '').trim() || 'Validation failed';
    return { approved: false, reason };
  } catch (err) {
    aiLogger.error({ err }, 'Response validation failed');
    if (input.toolCalls.length === 0) {
      return { approved: false, reason: 'Validator unavailable and no tools were called — likely hallucination' };
    }
    return { approved: true };
  }
}
