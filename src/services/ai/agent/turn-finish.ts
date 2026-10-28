// Closes an agent turn: one evidence guard for every exit, the fallback for a silent model, what
// is persisted to history, and delivery (or discard) of the reply with the request's metrics.
import { t } from '../../../config/constants.ts';
import { logger } from '../../../utils/logger.ts';
import { weekdayMismatchNotice } from '../day-reference-guard.ts';
import { elapsedMs } from '../request-metrics.ts';
import { unverifiedResponseNotice } from '../response-validator.ts';
import type { TelegramStreamWriter } from '../telegram-stream.ts';
import type { AgentContext } from '../types.ts';
import { aiFailureNotices } from './failure-notices.ts';
import type { MessageParam } from './message-sanitizer.ts';
import { correctUtcClockTimesInReply } from './reply-correction.ts';
import type { RetryOutcome } from './retry-store.ts';
import { isSkipText } from './round-support.ts';
import type { AgentRunResult } from './run-types.ts';
import type { ToolRunLedger } from './tool-round.ts';
import type { RunFailure, TurnEnv, TurnState } from './turn-state.ts';

const aiLogger = logger.child({ module: 'ai-agent' });

/** What the turn's owner does for the closing phase: history writes, failure notice, session end. */
export interface FinishDeps {
  /** Persists an assistant turn to chat_history. */
  saveTurn: (message: MessageParam) => void;
  announceFailure: (error: unknown, retry: RetryOutcome) => void;
  /** The model ended the conversation: its debug session is over. */
  endSession: () => void;
}

/** How the evidence guard decided to close the turn. */
export interface GuardPlan {
  /** Notice of what the run really did, when its writes need one. */
  evidence: string | null;
  /** The user is shown nothing more. */
  silent: boolean;
  /** The "could not verify" notice, when the answer stays unverified and nothing else says so. */
  validationNotice: string | null;
  /** The draft is untrusted and is rebuilt from tool lines and notices only. */
  guarded: boolean;
}

/**
 * One evidence guard for every exit, including validation retries and partial streams.
 * Clarification UI is already delivered by the handler; it is never a completed write.
 */
export function planGuard(ctx: AgentContext, state: TurnState, runFailed: boolean, ledger: ToolRunLedger): GuardPlan {
  const { writeOutcomes, toolEvidence } = ledger;
  const { termination, responseUnverified } = state;
  const evidence = writeOutcomes.finalNotice(
    ctx.user.language,
    ctx.isGroup,
    (runFailed || responseUnverified) && writeOutcomes.mayHaveMutated,
  );
  // A supplement is optional text and stays quiet when guarded, unless it may have changed the
  // calendar: then the receipt is its reply, or the user would never learn of the change.
  const supplementQuiet = ctx.supplementMode && !(evidence !== null && writeOutcomes.mayHaveMutated);
  const silent = Boolean(
    supplementQuiet ||
      ctx.wasExplicitInvocation === false ||
      (termination === 'waiting' && !writeOutcomes.speechQuestion),
  );
  const needsValidationNotice = responseUnverified && !silent && !evidence && termination !== 'waiting';
  let validationNotice: string | null = null;
  if (needsValidationNotice) {
    validationNotice =
      state.unresolvedWeekdays.length > 0
        ? weekdayMismatchNotice(ctx.user.language, state.unresolvedWeekdays)
        : unverifiedResponseNotice(ctx.user.language, ctx.user.timezone, ctx.isGroup ? [] : toolEvidence);
  }
  const guarded = responseUnverified || evidence !== null || termination === 'waiting' || termination === 'error';
  return { evidence, silent, validationNotice, guarded };
}

/** Rebuilds a guarded draft: the whole request is untrusted, so only notices are written. */
function applyGuard(writer: TelegramStreamWriter, plan: GuardPlan, state: TurnState, ledger: ToolRunLedger): void {
  if (!plan.guarded) return;
  // The whole request is untrusted at this point, including any prose
  // the model narrated in an earlier round before the guard had a
  // reason to fire — only tool-result lines (real actions) stay.
  writer.resetForGuard();
  if (plan.silent) return;
  const { speechQuestion } = ledger.writeOutcomes;
  const waiting = state.termination === 'waiting';
  if (plan.evidence && !waiting) writer.appendText(plan.evidence);
  if (plan.validationNotice) writer.appendText(plan.validationNotice);
  if (waiting && speechQuestion) writer.appendText(speechQuestion);
}

/**
 * A direct private-chat request never ends in silence or a bare "...": weak models answer '[SKIP]'
 * (taught for reactions and group silence) or nothing after real work, and discarding that deleted
 * every trace of the writes. Clarification UI or an unprompted scheduled run is real silence.
 */
export function answersDirectMessage(
  ctx: AgentContext,
  state: TurnState,
  runFailed: boolean,
  plan: GuardPlan,
): boolean {
  return (
    !runFailed &&
    !plan.silent &&
    !ctx.isGroup &&
    !ctx.unprompted &&
    ctx.inputMode !== 'live_call' &&
    state.termination !== 'waiting'
  );
}

/**
 * Replaces an empty or `[SKIP]` draft of a direct request with a fallback notice, unless a tool
 * delivered the answer itself (a reaction, a rendered image) as the turn's whole outcome — never
 * beside a write. Returns the notice, or null when the draft stands.
 */
function replaceSilentDraft(
  env: TurnEnv,
  state: TurnState,
  runFailed: boolean,
  plan: GuardPlan,
  writes: string | null,
  answeredByTool: boolean,
): string | null {
  const { ctx, writer } = env;
  const draft = writer.getText().trim();
  const modelStayedSilent = draft === '' || isSkipText(draft);
  // Every guarded, non-silent exit above appended its own notice (evidence, validation
  // notice or spoken question, each a non-empty string), so its draft is never empty here.
  if (!answersDirectMessage(ctx, state, runFailed, plan) || !modelStayedSilent || answeredByTool) return null;

  const notice = writes ? t(ctx.user.language).ai_unanswered_writes(writes) : t(ctx.user.language).ai_unanswered;
  aiLogger.warn(
    {
      requestId: env.requestId,
      userId: ctx.user.telegram_id,
      termination: state.termination,
      hadWrites: writes !== null,
    },
    'Model left a direct request unanswered — delivering fallback notice',
  );
  writer.resetForGuard();
  writer.appendText(notice);
  return notice;
}

/** Evidence of what happened is durable even in quiet mode; a notice is persisted only when delivered. */
function persistTurnTail(
  env: TurnEnv,
  state: TurnState,
  plan: GuardPlan,
  unansweredNotice: string | null,
  saveTurn: FinishDeps['saveTurn'],
): void {
  if (env.ctx.supplementMode) return;
  const { speechQuestion } = env.ledger.writeOutcomes;
  const say = (content: string) => saveTurn({ role: 'assistant', content });
  if (!plan.guarded && !unansweredNotice) {
    for (const message of state.pendingHistory) saveTurn(message);
  }
  if (state.termination === 'waiting' && speechQuestion) say(speechQuestion);
  if (plan.evidence) say(plan.evidence);
  if (unansweredNotice) say(unansweredNotice);
  if (plan.validationNotice) say(plan.validationNotice);
}

/** Nothing worth showing: remove the placeholder instead of editing it into a bare "...". */
async function discardTurn(env: TurnEnv, state: TurnState, ledger: ToolRunLedger): Promise<AgentRunResult> {
  const deliveryStartedAt = performance.now();
  await env.writer.discard();
  const metrics = env.requestMetrics.snapshot(state.termination, 'discarded', elapsedMs(deliveryStartedAt));
  aiLogger.info(metrics, 'AI request metric');
  return { responseText: '', toolCalls: ledger.allToolCalls, toolResults: ledger.allToolResults, metrics };
}

async function deliverTurn(env: TurnEnv, state: TurnState, ledger: ToolRunLedger): Promise<AgentRunResult> {
  const { ctx, writer } = env;
  let deliveryOutcome: 'delivered' | 'fallback' = 'delivered';
  const deliveryStartedAt = performance.now();
  try {
    await writer.finalize();
  } catch (finalizeErr) {
    deliveryOutcome = 'fallback';
    aiLogger.error({ err: finalizeErr, userId: ctx.user.telegram_id }, 'Writer finalize failed');
    await writer.sendErrorFallback(t(ctx.user.language).ai_send_error);
  }
  const metrics = env.requestMetrics.snapshot(state.termination, deliveryOutcome, elapsedMs(deliveryStartedAt));
  aiLogger.info(metrics, 'AI request metric');

  const msgId = writer.getMessageId();
  if (ctx.onBotResponse && msgId !== null) {
    ctx.onBotResponse(msgId);
  }

  return {
    responseText: ctx.inputMode !== 'text' ? writer.getPlainText() : writer.getText(),
    toolCalls: ledger.allToolCalls,
    toolResults: ledger.allToolResults,
    endCall: ctx.callEndRequested === true,
    metrics,
  };
}

/** Logs the turn's final text and outcome; the model ending the conversation closes its debug session. */
function recordTurnEnd(env: TurnEnv, state: TurnState, deps: FinishDeps): string {
  const { ctx, writer, dbg, ledger } = env;
  const finalText = writer.getText().trim();
  dbg?.logFinal(finalText, ledger.allToolCalls.length);
  if (ledger.allToolCalls.some((tc) => tc.name === 'end_conversation')) deps.endSession();

  aiLogger.info(
    {
      requestId: env.requestId,
      userId: ctx.user.telegram_id,
      chatId: ctx.chatId,
      toolCount: ledger.allToolCalls.length,
      supplementMode: !!ctx.supplementMode,
      termination: state.termination,
    },
    'Agent run complete',
  );
  return finalText;
}

/**
 * Settles a turn whose loop, validation or failure path is over: applies the evidence guard,
 * persists what the user was told, tells them of a failure, and delivers the reply.
 */
export async function finishTurn(
  env: TurnEnv,
  state: TurnState,
  failure: RunFailure,
  deps: FinishDeps,
): Promise<AgentRunResult> {
  const { ctx, writer, ledger } = env;
  const { writeOutcomes } = ledger;
  if (state.responseUnverified && !failure.failed && state.termination !== 'waiting') state.termination = 'unverified';

  const plan = planGuard(ctx, state, failure.failed, ledger);
  applyGuard(writer, plan, state, ledger);
  if (!plan.guarded) correctUtcClockTimesInReply(ctx, writer, state.pendingHistory);

  const writes = writeOutcomes.summary(ctx.user.language, ctx.isGroup);
  const answeredByTool = writes === null && writeOutcomes.toolAnswered;
  const unansweredNotice = replaceSilentDraft(env, state, failure.failed, plan, writes, answeredByTool);
  persistTurnTail(env, state, plan, unansweredNotice, deps.saveTurn);
  if (failure.failed && !plan.evidence && !plan.validationNotice) deps.announceFailure(failure.error, failure.retry);

  if (!failure.failed && !state.responseUnverified && !ctx.supplementMode) {
    // The bot answered — any comeback it promised earlier is now settled.
    aiFailureNotices.clear(ctx.user.telegram_id);
  }

  const finalText = recordTurnEnd(env, state, deps);

  // A failed run with nothing to show must not leave the ⏳ placeholder edited
  // into a bare "..." — that is the silence the user reads as being ignored.
  // A tool that delivered the answer with no text after it is not a bare "..." either.
  const nothingToShow = isSkipText(finalText) || (finalText.length === 0 && (failure.failed || answeredByTool));
  if ((plan.silent && plan.guarded) || nothingToShow) return discardTurn(env, state, ledger);
  return deliverTurn(env, state, ledger);
}
