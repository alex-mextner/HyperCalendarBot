// Validates the turn's final prose before it is trusted: always for tool-less prose, plus factual
// claims the run's tools cannot support. A rejected answer gets one corrective retry with tools,
// and a retry is never approval — unverified text stays out of delivery and history.
import { logger } from '../../../utils/logger.ts';
import {
  shouldValidateResponse,
  supplementIsGrounded,
  type ValidationResult,
  validateResponse,
} from '../response-validator.ts';
import { buildUserProfileEvidence } from '../system-prompt.ts';
import { isSkipText, toolDefinitionsFor } from './round-support.ts';
import { requestBudgetSpent } from './run-limits.ts';
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
 * One validator verdict for `prose`, recorded on the turn. The validator may start while the request
 * budget has time left, even when little is, and then runs on its own clock; once the budget is
 * spent it launches nothing and only the deterministic checks can decide.
 */
async function judge(
  env: TurnEnv,
  state: TurnState,
  evidence: ProseEvidence,
  prose: string,
): Promise<ValidationResult> {
  const verdict = await validateResponse(
    { ...evidence, response: prose, userProfile: buildUserProfileEvidence(env.ctx) },
    env.validatorStream,
    {
      canAskModel: !requestBudgetSpent(env.startTime, env.requestTimeoutMs),
      timeoutMs: env.validationTimeoutMs,
    },
  );
  state.validation = verdict;
  return verdict;
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
  const reValidation = await judge(env, state, evidence, retryOutcome.lastRoundText);
  state.responseUnverified = reValidation.verdict !== 'approved';
  if (reValidation.verdict === 'rejected') {
    aiLogger.warn(
      { userId: ctx.user.telegram_id, reason: reValidation.reason },
      'Retry response rejected by validator — suppressing unverified explanation',
    );
  } else if (reValidation.verdict === 'unavailable') {
    aiLogger.warn(
      { userId: ctx.user.telegram_id, cause: reValidation.cause },
      'Validator unavailable for the retry response — it stays unverified',
    );
  }
}

/**
 * Runs the validator. A rejection triggers the corrective retry and, when it answered in prose, a
 * second look. An outage after the run changed the calendar does not: the retry could replay those
 * writes, and an outage says nothing about whether the answer was wrong.
 */
async function validateWithRetry(env: TurnEnv, state: TurnState, evidence: ProseEvidence): Promise<boolean> {
  const { ctx } = env;
  const validation = await judge(env, state, evidence, evidence.response);
  if (validation.verdict === 'approved') return false;

  state.responseUnverified = true;
  state.pendingAssistantTurn = null;
  if (validation.verdict === 'unavailable' && env.ledger.writeOutcomes.mayHaveMutated) {
    aiLogger.warn(
      { userId: ctx.user.telegram_id, requestId: env.requestId, cause: validation.cause },
      'Validator unavailable after calendar writes — no retry; the reply comes from the write receipts',
    );
    return true;
  }
  aiLogger.info(
    {
      userId: ctx.user.telegram_id,
      ...(validation.verdict === 'rejected' ? { reason: validation.reason } : { cause: validation.cause }),
    },
    validation.verdict === 'rejected'
      ? 'Response validation REJECTED — retrying with tools'
      : 'Response validator unavailable — retrying with tools',
  );
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
