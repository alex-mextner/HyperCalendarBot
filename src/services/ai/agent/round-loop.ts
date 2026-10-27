// The agent's main loop: model round, then either a final answer or tool calls, up to MAX_ROUNDS.
import { logger } from '../../../utils/logger.ts';
import { describeWeekdayDateMismatches, type WeekdayDateMismatch } from '../day-references.ts';
import type { StreamRoundResult } from '../streaming.ts';
import type { ModelRound } from './round-support.ts';
import {
  checkRoundWeekdays,
  createRoundCallbacks,
  isSkipText,
  runModelRound,
  skipPersistIdsFor,
} from './round-support.ts';
import { MAX_ROUNDS } from './run-limits.ts';
import { runToolCalls } from './tool-round.ts';
import type { TurnEnv, TurnState } from './turn-state.ts';

const aiLogger = logger.child({ module: 'ai-agent' });

type LoopStep = 'continue' | 'stop';

/** The model's instruction to rewrite a reply whose weekdays contradict its dates. */
function weekdayCorrectionNudge(mismatches: WeekdayDateMismatch[]): string {
  return (
    `[SYSTEM] Your reply was not sent: ${describeWeekdayDateMismatches(mismatches)}. ` +
    'Rewrite the reply so every weekday matches its date. Use the day the user named; if the ' +
    'events you reported belong to another day, read the named day with the calendar tools first.'
  );
}

/**
 * A round without tool calls ends the streaming phase. The assistant turn is NOT persisted yet:
 * validation runs after the loop and may reject and retry, in which case the rejected answer must
 * not reach chat_history.
 *
 * "в среду, 28 сентября" when the 28th is a Monday: the user trusts the weekday name, so such a
 * reply is never delivered as is — the model gets one round to fix it with the real weekdays in
 * hand, if a round is left.
 */
function settleToollessRound(
  env: TurnEnv,
  state: TurnState,
  round: number,
  result: StreamRoundResult,
  mismatches: WeekdayDateMismatch[],
): LoopStep {
  const { ctx, writer } = env;
  const dates = mismatches.map((mismatch) => mismatch.date);

  if (mismatches.length > 0 && !state.weekdaysCorrected && round < MAX_ROUNDS - 1) {
    state.weekdaysCorrected = true;
    aiLogger.warn(
      { userId: ctx.user.telegram_id, dates },
      'Reply pairs weekdays with dates on other weekdays — asking for a correction',
    );
    writer.resetDraft();
    state.currentMessages = [
      ...state.currentMessages,
      result.assistantMessage,
      { role: 'user', content: weekdayCorrectionNudge(mismatches) },
    ];
    return 'continue';
  }

  state.termination = 'normal';
  if (mismatches.length === 0) {
    state.pendingAssistantTurn = result.assistantMessage;
    state.pendingResponseText = result.text;
    return 'stop';
  }
  aiLogger.warn(
    { userId: ctx.user.telegram_id, dates },
    'Corrected reply still pairs weekdays with other dates — replacing it with the real weekdays',
  );
  state.unresolvedWeekdays = mismatches;
  state.responseUnverified = true;
  return 'stop';
}

/** Runs the round's tool calls and decides whether the loop goes on. */
async function settleToolRound(
  env: TurnEnv,
  state: TurnState,
  round: number,
  result: StreamRoundResult,
  exposedThisRound: ModelRound['exposedThisRound'],
): Promise<LoopStep> {
  const { ctx, writer } = env;
  const skipPersistIds = skipPersistIdsFor(result.toolCalls);

  // Hold assistant prose until the final guard can reconcile it with execution evidence.
  if (!ctx.supplementMode) env.saveAssistant(result.assistantMessage, skipPersistIds);

  const outcome = await runToolCalls(env, 'main', round, result.toolCalls, exposedThisRound, skipPersistIds);
  if (outcome.stop) {
    state.termination = outcome.stop.waiting ? 'waiting' : 'stop';
    return 'stop';
  }

  if (isSkipText(writer.getText())) {
    if (!ctx.supplementMode) env.saveResults(outcome.messages, skipPersistIds);
    state.termination = 'silent';
    return 'stop';
  }

  writer.clearToolLabel();
  if (!ctx.supplementMode) env.saveResults(outcome.messages, skipPersistIds);
  writer.commitIntermediate();

  state.currentMessages = [...state.currentMessages, result.assistantMessage, ...outcome.messages];
  return 'continue';
}

/**
 * Rounds of model call and tool execution until the model answers without tools, a tool stops
 * the loop, or MAX_ROUNDS is spent (termination stays `limit`). The state carries what the
 * validation and delivery phases need.
 */
export async function runRoundLoop(env: TurnEnv, state: TurnState): Promise<void> {
  const { ctx, dbg, writer, requestMetrics, requestSignal } = env;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    dbg?.logRound(round);
    requestSignal.throwIfAborted();

    const { result, exposedThisRound } = await runModelRound({
      ctx,
      stream: env.agentStream,
      messages: state.currentMessages,
      callbacks: createRoundCallbacks(writer, requestMetrics),
      exposure: env.exposure,
      signal: () => requestSignal,
    });

    const roundMetrics = result.metrics;
    aiLogger.info(
      {
        requestId: env.requestId,
        provider: roundMetrics?.provider ?? null,
        model: roundMetrics?.model ?? null,
        chain: roundMetrics?.chain ?? null,
        round,
        toolCount: result.toolCalls.length,
      },
      'Agent round complete',
    );
    dbg?.logAiText(result.text);

    const mismatches = checkRoundWeekdays(writer, result.text, ctx.user.timezone);
    const step =
      result.toolCalls.length === 0
        ? settleToollessRound(env, state, round, result, mismatches)
        : await settleToolRound(env, state, round, result, exposedThisRound);
    if (step === 'stop') return;
  }
}
