// src/services/intent/intent-learner.ts
import type OpenAI from 'openai';
import { z } from 'zod';
import type { IntentRepository } from '../../database/repositories/intent.repository.ts';
import type { CreateIntentData } from '../../database/types.ts';
import { jsonCodec } from '../../utils/json-codec.ts';
import { cmdLogger } from '../../utils/logger.ts';
import { aiStreamRound } from '../ai/streaming.ts';
import { type EnqueueInput, type JsonObject, JsonObjectSchema } from '../intent-learning/schemas.ts';
import { LEARNER_SYSTEM_PROMPT } from './learner-prompt.ts';
import { normalize } from './normalizer.ts';
import { WorkflowSchema } from './workflow-schema.ts';
import { validateWorkflow } from './workflow-validator.ts';

const LearnerResponseSchema = z.object({
  skip: z.boolean().optional(),
  canonical_name: z.string(),
  phrases: z.array(z.string()).default([]),
  trigger_words: z.array(z.string()).optional(),
  pattern: z.string().nullish(),
  workflow: WorkflowSchema,
  format: z.string().optional(),
});

const LearnerResponseCodec = jsonCodec(LearnerResponseSchema);
const ToolInputCodec = jsonCodec(JsonObjectSchema);

interface ToolCallRecord {
  name: string;
  input: { [key: string]: unknown };
}

interface ToolResultRecord {
  success: boolean;
  output?: string;
}

interface InlineKeyboardMarkup {
  inline_keyboard: { text: string; callback_data: string }[][];
}

interface LearnerConfig {
  dailyLimit: number;
  adminId?: number;
  sendToAdmin?: (text: string, replyMarkup: InlineKeyboardMarkup) => Promise<void>;
  /**
   * Optional override for the underlying stream function. Tests inject a
   * scripted impl here so analysis runs offline. Defaults to aiStreamRound.
   */
  streamImpl?: typeof aiStreamRound;
  /**
   * Durable learning queue. When set, every interaction is handed to it and the learner never
   * calls a model or writes intents itself; proposals reach active intents only by admin approval.
   */
  enqueue?: (input: EnqueueInput) => unknown;
}

/** Conversation context the durable queue needs to scope and compare a sample. */
export interface LearnerInteractionContext {
  actorId: number;
  chatId: number;
  messageId?: number;
  previousAiResponse?: string;
  recentMessages?: { role: 'user' | 'assistant'; text: string }[];
}

/** Tool inputs are JSON by contract; anything that does not survive a JSON round trip is dropped. */
function toJsonObject(input: { [key: string]: unknown }): JsonObject {
  let text: string;
  try {
    text = JSON.stringify(input);
  } catch {
    // Cyclic or BigInt inputs cannot be stored as evidence; the call name is still kept.
    return {};
  }
  return ToolInputCodec.safeParse(text).data ?? {};
}

export class IntentLearner {
  private dailyCallCount = 0;
  private lastResetDate = '';
  private recentMessages = new Map<string, number>(); // normalized message → timestamp

  constructor(
    private intentRepo: IntentRepository,
    private config: LearnerConfig,
  ) {}

  /** Analyze an AI interaction and potentially generate an intent candidate */
  async analyze(
    message: string,
    toolCalls: ToolCallRecord[],
    toolResults: ToolResultRecord[],
    context?: LearnerInteractionContext,
  ): Promise<CreateIntentData | null> {
    if (this.config.enqueue) {
      await this.enqueueInteraction(this.config.enqueue, message, toolCalls, toolResults, context);
      return null;
    }

    // 1. Skip conditions
    if (!this.shouldAnalyze(toolCalls)) return null;

    // 2. Check daily budget
    this.resetDailyIfNeeded();
    if (this.dailyCallCount >= this.config.dailyLimit) return null;

    // 3. Check dedup (1 hour window)
    const normalized = normalize(message);
    const lastSeen = this.recentMessages.get(normalized);
    if (lastSeen && Date.now() - lastSeen < 3600_000) return null;

    // 4. Mark as processed
    this.recentMessages.set(normalized, Date.now());
    this.dailyCallCount++;

    // 5. Call AI to generate intent
    try {
      const intentData = await this.callLearnerAI(message, toolCalls, toolResults);
      if (!intentData) return null;

      // 6. An existing name is never extended in place: approved intents change only through
      // an admin-approved proposal of the durable learning queue.
      if (this.intentRepo.findByCanonicalName(intentData.canonical_name)) return null;

      // 7. Save as pending
      const id = this.intentRepo.create(intentData);

      // 8. Send to admin for verification
      this.sendToAdminForVerification(id, intentData);

      return intentData;
    } catch (error) {
      cmdLogger.error({ err: error }, 'IntentLearner AI call failed');
      return null;
    }
  }

  /**
   * Only chat without tool calls is skipped. Clarifying questions and context-dependent wording
   * are analyzed: the user may explicitly want such cases automated.
   */
  private shouldAnalyze(toolCalls: ToolCallRecord[]): boolean {
    return toolCalls.length > 0;
  }

  /** Chat without tool calls is stored as evidence only; the queue decides what to generate. */
  private async enqueueInteraction(
    enqueue: (input: EnqueueInput) => unknown,
    message: string,
    toolCalls: ToolCallRecord[],
    toolResults: ToolResultRecord[],
    context: LearnerInteractionContext | undefined,
  ): Promise<void> {
    if (!context) {
      cmdLogger.warn('IntentLearner enqueue skipped: interaction has no actor/chat context');
      return;
    }
    try {
      await enqueue({
        actorId: context.actorId,
        chatId: context.chatId,
        ...(context.messageId === undefined ? {} : { messageId: context.messageId }),
        request: message,
        previousAiResponse: context.previousAiResponse ?? '',
        toolCalls: toolCalls.map((call) => ({ name: call.name, input: toJsonObject(call.input) })),
        toolResults: toolResults.map((result) => ({
          success: result.success,
          ...(result.output === undefined ? {} : { output: result.output }),
        })),
        recentMessages: context.recentMessages ?? [],
        evidenceOnly: toolCalls.length === 0,
      });
    } catch (err) {
      cmdLogger.error({ err }, 'IntentLearner failed to enqueue interaction');
    }
  }

  private resetDailyIfNeeded(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.lastResetDate) {
      this.dailyCallCount = 0;
      this.lastResetDate = today;
      // Clean up old dedup entries
      const cutoff = Date.now() - 3600_000;
      for (const [key, ts] of this.recentMessages) {
        if (ts < cutoff) this.recentMessages.delete(key);
      }
    }
  }

  private async callLearnerAI(
    message: string,
    toolCalls: ToolCallRecord[],
    toolResults: ToolResultRecord[],
  ): Promise<CreateIntentData | null> {
    const firstUserMessage = JSON.stringify({ message, toolCalls, toolResults });
    const conversationMessages: OpenAI.ChatCompletionMessageParam[] = [{ role: 'user', content: firstUserMessage }];

    const MAX_RETRIES = 5;
    const streamImpl = this.config.streamImpl ?? aiStreamRound;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // Uses the SMART chain (no fast flag) — intent extraction is a reasoning
      // task that benefits from the primary model, not a cheap fallback.
      const result = await streamImpl({
        messages: [{ role: 'system', content: LEARNER_SYSTEM_PROMPT }, ...conversationMessages],
        maxTokens: 2048,
      });

      if (result.finishReason === 'length') {
        cmdLogger.warn('IntentLearner response truncated (max_tokens), skipping');
        return null;
      }

      const text = result.text;
      if (!text) return null;

      // Strip markdown code fences if model ignored "no markdown" instruction
      const json = text
        .replace(/^\s*```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .trim();

      // Parse and validate JSON response.
      // Use safeParse first — a {"skip":true} response omits required fields and
      // would throw a ZodError with .parse(), even though it's a valid AI decision.
      const parsedResult = LearnerResponseCodec.safeParse(json);
      if (!parsedResult.success) {
        const skipCheck = jsonCodec(z.object({ skip: z.boolean().optional() }).passthrough()).safeParse(json);
        if (skipCheck.success && skipCheck.data.skip) return null;
        throw parsedResult.error;
      }
      const parsed = parsedResult.data;

      if (parsed.skip) return null;

      // Validate required fields — phrases can be empty for parameterized intents
      if (!parsed.canonical_name || !parsed.workflow) {
        return null;
      }
      if (!parsed.phrases.length && !parsed.pattern) {
        return null;
      }

      // Validate workflow schema
      const workflowResult = WorkflowSchema.safeParse(parsed.workflow);
      if (!workflowResult.success) {
        cmdLogger.warn({ attempt, errors: workflowResult.error.issues }, 'IntentLearner workflow has invalid schema');

        if (attempt < MAX_RETRIES) {
          const schemaErrors = workflowResult.error.issues.map((i) => `- ${i.path.join('.') || 'root'}: ${i.message}`);
          const errorFeedback = [
            'The workflow does not match the required schema. Fix it and return corrected JSON.',
            'Schema errors:',
            ...schemaErrors,
          ].join('\n');
          conversationMessages.push({ role: 'assistant', content: text });
          conversationMessages.push({ role: 'user', content: errorFeedback });
          continue;
        }

        cmdLogger.error(
          { errors: workflowResult.error.issues },
          'IntentLearner: workflow schema still invalid after retries, skipping',
        );
        return null;
      }

      // Validate template variables and the tool calls themselves
      const varErrors = validateWorkflow(workflowResult.data, parsed.pattern ?? null);
      if (varErrors.length > 0) {
        cmdLogger.warn({ attempt, errors: varErrors }, 'IntentLearner workflow is invalid');

        if (attempt < MAX_RETRIES) {
          // Feed the errors back and retry
          const errorFeedback = [
            'The workflow is invalid. Fix the errors below and return corrected JSON.',
            'Errors:',
            ...varErrors.map((e) => `- ${e}`),
          ].join('\n');
          conversationMessages.push({ role: 'assistant', content: text });
          conversationMessages.push({ role: 'user', content: errorFeedback });
          continue;
        }

        // After all retries failed — skip this intent
        cmdLogger.error({ errors: varErrors }, 'IntentLearner: workflow still invalid after retries, skipping');
        return null;
      }

      return {
        canonical_name: parsed.canonical_name,
        phrases: parsed.phrases,
        trigger_words: parsed.trigger_words,
        pattern: parsed.pattern ?? undefined,
        workflow: workflowResult.data,
        format: parsed.format || 'text',
        source_message: message,
      };
    }

    return null;
  }

  private sendToAdminForVerification(intentId: number, data: CreateIntentData): void {
    if (!this.config.adminId || !this.config.sendToAdmin) return;

    const workflowStr = JSON.stringify(data.workflow, null, 2);
    const lines = [`💡 New intent: ${data.canonical_name}`];
    if (data.phrases.length > 0) {
      lines.push(`Phrases: ${data.phrases.map((p) => `"${p}"`).join(', ')}`);
    }
    lines.push(
      data.pattern ? `Pattern: ${data.pattern}` : 'Pattern: none (exact match only)',
      `Workflow: ${workflowStr}`,
      `Format: ${data.format}`,
      `Source: "${data.source_message}"`,
    );
    const text = lines.join('\n');

    const replyMarkup = {
      inline_keyboard: [
        [
          { text: '✅ Accept', callback_data: `intent_accept:${intentId}` },
          { text: '✏️ Edit', callback_data: `intent_edit:${intentId}` },
          { text: '❌ Reject', callback_data: `intent_reject:${intentId}` },
        ],
      ],
    };

    this.config.sendToAdmin(text, replyMarkup).catch((err: unknown) => {
      cmdLogger.error({ err: err }, 'Failed to send intent verification to admin');
    });
  }

  // For testing
  resetDailyCounter(): void {
    this.dailyCallCount = 0;
    this.lastResetDate = '';
  }

  incrementCounter(): void {
    this.dailyCallCount++;
  }

  getDailyCallCount(): number {
    return this.dailyCallCount;
  }
}
