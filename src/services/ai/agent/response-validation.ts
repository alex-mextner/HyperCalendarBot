// Validates the turn's final prose before it is trusted: always for tool-less prose, plus factual
// claims the run's tools cannot support. A rejected answer gets one corrective retry with tools,
// and a retry is never approval — unverified text stays out of delivery and history.
import { logger } from '../../../utils/logger.ts';
import { shouldValidateResponse, supplementIsGrounded, validateResponse } from '../response-validator.ts';
import { buildUserProfileEvidence } from '../system-prompt.ts';
import { isSkipText, toolDefinitionsFor } from './round-support.ts';
import type { TurnEnv, TurnState } from './turn-state.ts';
import { runRetryAfterRejection, type ValidationRetryOutcome } from './validation-retry.ts';

const aiLogger = logger.child({ module: 'ai-agent' });

/** What the validator is shown: the user's request, the run's tool evidence, and the prose. */
type ProseEvidence = Parameters<typeof shouldValidateResponse>[0];

/** A supplement is dropped, not retried, when it states facts its own reads do not back. */
function supplementIsRejected(env: TurnEnv, state: TurnState, evidence: ProseEvidence): boolean {
  const prose = evidence.response;
  if (!prose || isSkipText(prose) || supplementIsGrounded(evidence)) return false;
  aiLogger.info({ userId: env.ctx.user.telegram_id }, 'Supplement states facts its own reads do not back — dropped');
  state.responseUnverified = true;
  return true;
}

/**
 * Judges the answer the retry loop ended on. The retry may have saved a fact that its answer now
 * mentions, so the user's profile evidence is rebuilt.
 */
async function revalidateRetryAnswer(
  env: TurnEnv,
  state: TurnState,
  evidence: ProseEvidence,
  retryOutcome: ValidationRetryOutcome,
): Promise<void> {
  const ctx = env.ctx;
  // The same reading that decided whether the retry's draft was shown.
  const retryMismatches = retryOutcome.lastRoundMismatches ?? [];
  if (retryMismatches.length > 0) {
    state.unresolvedWeekdays = retryMismatches;
    state.responseUnverified = true;
    return;
  }
  const reValidation = await validateResponse(
    { ...evidence, response: retryOutcome.lastRoundText, userProfile: buildUserProfileEvidence(ctx) },
    env.validatorStream,
  );
  state.responseUnverified = !reValidation.approved;
  if (!reValidation.approved) {
    aiLogger.warn(
      { userId: ctx.user.telegram_id, reason: reValidation.reason },
      'Retry response rejected by validator — suppressing unverified explanation',
    );
  }
}

/** Runs the validator; a rejection triggers the retry and, when it answered in prose, a second look. */
async function validateWithRetry(env: TurnEnv, state: TurnState, evidence: ProseEvidence): Promise<boolean> {
  const { ctx } = env;
  const validation = await validateResponse(
    { ...evidence, userProfile: buildUserProfileEvidence(ctx) },
    env.validatorStream,
  );
  if (validation.approved) return false;

  aiLogger.info(
    { userId: ctx.user.telegram_id, reason: validation.reason },
    'Response validation REJECTED — retrying with tools',
  );
  state.responseUnverified = true;
  state.pendingAssistantTurn = null;
  const retryOutcome = await runRetryAfterRejection(env, state.currentMessages, evidence.response);

  if (retryOutcome.hitStopLoop) state.termination = retryOutcome.waiting ? 'waiting' : 'stop';

  // A retry is not approval. Keep unverified text out of both delivery
  // and history on rejection, timeout, exhaustion, or an early stop.
  // The final evidence guard preserves writes and clarification UI.
  const answeredInProse =
    !retryOutcome.hitStopLoop && retryOutcome.lastRoundText && !retryOutcome.lastRoundHadToolCalls;
  if (answeredInProse) await revalidateRetryAnswer(env, state, evidence, retryOutcome);
  return true;
}

/**
 * Validates the final prose and, when it is trusted, saves the assistant turn that was held back.
 * The deterministic prefilter keeps ordinary tool-backed writes and answers whose days and times
 * the run's reads contain on the existing fast path.
 */
export async function settleFinalResponse(env: TurnEnv, state: TurnState): Promise<void> {
  const { ctx } = env;
  // The model's actual emitted text, not the writer buffer — tests with scripted stream impls
  // can produce an assistantMessage without calling onTextDelta, so writer.getText() may be
  // empty even when the model did return content.
  const evidence: ProseEvidence = {
    userMessage: ctx.messageText,
    timezone: ctx.user.timezone,
    tools: env.ledger.toolEvidence,
    response: state.pendingResponseText.trim(),
  };

  let rejected = false;
  if (ctx.supplementMode) {
    rejected = supplementIsRejected(env, state, evidence);
  } else if (
    toolDefinitionsFor(ctx).length > 0 &&
    evidence.response &&
    !isSkipText(evidence.response) &&
    shouldValidateResponse(evidence)
  ) {
    rejected = await validateWithRetry(env, state, evidence);
  }

  if (state.pendingAssistantTurn && !rejected && !ctx.supplementMode) env.saveAssistant(state.pendingAssistantTurn);
}
