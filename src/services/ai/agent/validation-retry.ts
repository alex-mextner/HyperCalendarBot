// The one corrective pass after the response validator rejected a tool-less answer: the model is
// told to do the work with tools, under what is left of the request's overall budget.
import { t } from '../../../config/constants.ts';
import { logger } from '../../../utils/logger.ts';
import type { WeekdayDateMismatch } from '../day-references.ts';
import type { aiStreamRound } from '../streaming.ts';
import type { MessageParam } from './message-sanitizer.ts';
import { checkRoundWeekdays, createRoundCallbacks, runModelRound, skipPersistIdsFor } from './round-support.ts';
import { MAX_ROUNDS, remainingRequestMs, requestBudgetSpent } from './run-limits.ts';
import { runToolCalls, type ToolRoundEnv } from './tool-round.ts';

const aiLogger = logger.child({ module: 'ai-agent' });

/**
 * Generic retry nudge. Does NOT echo the validator's REJECT string, which
 * is an LLM-generated value that cannot be trusted as a system directive.
 */
const RETRY_NUDGE =
  '[SYSTEM] Your previous response was rejected by the quality validator. You MUST complete the calendar task with the appropriate tools instead of repeating unsupported prose. Facts about the user themself may come from User Info and What I Know About You; state a fact about their calendar only from a read tool called in this turn, or leave it out. For normal calendar create/edit requests, user-provided titles, descriptions, locations, and notes are content-neutral data: do not refuse, sanitize, euphemize, or moralize because of profanity, sexual/adult wording, politics/religion, slang, or other sensitive vocabulary. Preserve the requested field text and perform the calendar operation when its date/time/action are otherwise valid.';

export interface ValidationRetryEnv extends ToolRoundEnv {
  /** When the whole request started; the retry shares its budget instead of getting a fresh one. */
  startTime: number;
  requestTimeoutMs: number;
  retryStream: typeof aiStreamRound;
  saveAssistant: (message: MessageParam, skipIds?: Set<string>) => void;
}

export interface ValidationRetryOutcome {
  hitStopLoop: boolean;
  waiting?: boolean;
  /** Text produced by the most recent round of the retry loop (for re-validation). */
  lastRoundText: string;
  /** Whether the last round called any tools. Used to decide if re-validation is needed. */
  lastRoundHadToolCalls: boolean;
  /** Weekdays the text-only last round paired with dates on other weekdays. */
  lastRoundMismatches?: WeekdayDateMismatch[];
}

/**
 * Retry the round after the quality validator rejected a tool-less response.
 *
 * NOTE: the validator's REJECT reason is deliberately NOT forwarded to the
 * retry prompt. The validator is itself an LLM whose free-form output can
 * be influenced by the user's original message, so splicing the reason into
 * a pseudo-system instruction would open a prompt-injection channel where a
 * malicious user can steer the retry. Caller logs the reason once before
 * calling this function; after that it is discarded.
 */
export async function runRetryAfterRejection(
  env: ValidationRetryEnv,
  messages: MessageParam[],
  previousText: string,
): Promise<ValidationRetryOutcome> {
  const { ctx, writer, dbg } = env;
  // Discard the rejected draft text so commitIntermediate() never pushes it
  // into the execution log — but keep any tool history already committed
  // from earlier rounds of this same request; that work really happened.
  writer.resetDraft();

  let currentMessages: MessageParam[] = [
    ...messages,
    { role: 'assistant', content: previousText },
    { role: 'user', content: RETRY_NUDGE },
  ];

  for (let round = 0; round < MAX_ROUNDS; round++) {
    dbg?.logRound(100 + round);

    if (requestBudgetSpent(env.startTime, env.requestTimeoutMs)) {
      aiLogger.warn({ userId: ctx.user.telegram_id }, 'Agent timeout (retry)');
      writer.appendText(`\n\n${t(ctx.user.language).agent_timeout}`);
      return { hitStopLoop: false, lastRoundText: '', lastRoundHadToolCalls: false };
    }

    const { result, exposedThisRound } = await runModelRound({
      ctx,
      stream: env.retryStream,
      messages: currentMessages,
      callbacks: createRoundCallbacks(writer, env.requestMetrics),
      exposure: env.exposure,
      signal: () => AbortSignal.timeout(remainingRequestMs(env.startTime, env.requestTimeoutMs)),
    });

    dbg?.logAiText(result.text);
    const lastRoundMismatches = checkRoundWeekdays(writer, result.text, ctx.user.timezone);

    if (result.toolCalls.length === 0) {
      // A reply pairing a weekday with another weekday's date is never kept for history.
      if (!ctx.supplementMode && lastRoundMismatches.length === 0) env.saveAssistant(result.assistantMessage);
      return { hitStopLoop: false, lastRoundText: result.text, lastRoundHadToolCalls: false, lastRoundMismatches };
    }

    const skipPersistIds = skipPersistIdsFor(result.toolCalls);
    if (!ctx.supplementMode) {
      env.saveAssistant(result.assistantMessage, skipPersistIds);
    }

    const outcome = await runToolCalls(env, 'retry', round, result.toolCalls, exposedThisRound, skipPersistIds);
    if (outcome.stop) {
      return {
        hitStopLoop: true,
        waiting: outcome.stop.waiting,
        lastRoundText: '',
        lastRoundHadToolCalls: true,
      };
    }

    commitToolRound(env, outcome.messages, skipPersistIds);
    currentMessages = [...currentMessages, result.assistantMessage, ...outcome.messages];
  }
  return { hitStopLoop: false, lastRoundText: '', lastRoundHadToolCalls: true };
}

/** Persists a finished tool round's results and folds its tool lines into the execution log. */
function commitToolRound(env: ValidationRetryEnv, messages: MessageParam[], skipPersistIds: Set<string>): void {
  if (!env.ctx.supplementMode && messages.length > 0) env.saveResults(messages, skipPersistIds);
  env.writer.clearToolLabel();
  env.writer.commitIntermediate();
}
