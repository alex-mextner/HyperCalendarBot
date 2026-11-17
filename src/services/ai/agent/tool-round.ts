// Executes one model round's tool calls in order: duplicate short-circuit, execution, ledger
// bookkeeping and the tool-role messages fed back to the model. Shared by the main round loop and
// the validation-retry loop, which differ only in what they log.
import { logger } from '../../../utils/logger.ts';
import type { AiDebugRunContext } from '../debug-logger.ts';
import { type AgentRequestMetrics, elapsedMs } from '../request-metrics.ts';
import type { ToolEvidence } from '../response-grounding.ts';
import type { StreamToolCall } from '../streaming.ts';
import type { TelegramStreamWriter } from '../telegram-stream.ts';
import { type ExecutedToolResult, executeTool, isReadOnlyCall, SILENT_TOOLS } from '../tool-executor.ts';
import { type createToolExposure, DISCOVERY_TOOL } from '../tool-exposure.ts';
import type { AgentContext, ToolResult } from '../types.ts';
import type { WriteOutcomes } from '../write-outcomes.ts';
import type { MessageParam } from './message-sanitizer.ts';
import type { AgentToolCallRecord, AgentToolResultRecord } from './run-types.ts';
import { DUPLICATE_MARKER, toolCallKey, toolResultContent } from './tool-call-key.ts';

const aiLogger = logger.child({ module: 'ai-agent' });

export type ToolExposure = ReturnType<typeof createToolExposure>;

/**
 * What a run has executed so far, shared by the main loop and the validation retry so each
 * respects the other's calls: dedup keys, caller-visible records, validator evidence and write outcomes.
 */
export interface ToolRunLedger {
  allToolCalls: AgentToolCallRecord[];
  allToolResults: AgentToolResultRecord[];
  /** What each executed call returned, including structured data, for the validator and the notice. */
  toolEvidence: ToolEvidence[];
  /** Keys of calls already executed in this run; identical repeats are answered, not executed. */
  seenToolCallKeys: Set<string>;
  writeOutcomes: WriteOutcomes;
}

export interface ToolRoundEnv {
  ctx: AgentContext;
  writer: TelegramStreamWriter;
  dbg: AiDebugRunContext | null;
  requestMetrics: AgentRequestMetrics;
  requestId: string;
  exposure: ToolExposure | undefined;
  ledger: ToolRunLedger;
  saveResults: (messages: MessageParam[], skipIds?: Set<string>) => void;
}

/** Which loop is executing: the retry loop logs less, as it always has. */
export type ToolLoopPhase = 'main' | 'retry';

export interface ToolRoundOutcome {
  /** One tool-role message per executed or short-circuited call, in call order. */
  messages: MessageParam[];
  /** Set when a call asked to end the loop; `waiting` marks a call that awaits the user. */
  stop: { waiting: boolean } | null;
}

type ToolInput = { [key: string]: unknown };

function parseToolInput(tc: StreamToolCall, phase: ToolLoopPhase): ToolInput {
  try {
    return JSON.parse(tc.arguments) as ToolInput;
  } catch (err) {
    const message = phase === 'main' ? 'Failed to parse tool arguments' : 'Failed to parse tool arguments (retry)';
    aiLogger.error({ err, tool: tc.name, arguments: tc.arguments }, message);
    return {};
  }
}

/**
 * A repeat of an executed call is answered with a synthetic DUPLICATE result instead of invoking
 * the handler again: it would repeat user-visible side effects (photo sends, notifications) when
 * the model loops.
 */
function answerDuplicate(
  env: ToolRoundEnv,
  phase: ToolLoopPhase,
  round: number,
  tc: StreamToolCall,
  input: ToolInput,
): MessageParam {
  const message =
    phase === 'main'
      ? 'Duplicate tool call skipped (in-run dedup)'
      : 'Duplicate tool call skipped (in-run dedup, retry loop)';
  aiLogger.warn({ tool: tc.name, input, userId: env.ctx.user.telegram_id, round }, message);
  env.dbg?.logToolResult(tc.name, true, DUPLICATE_MARKER, undefined);
  if (tc.name !== DISCOVERY_TOOL) {
    env.ledger.allToolCalls.push({ name: tc.name, input });
    env.ledger.allToolResults.push({ success: true, output: DUPLICATE_MARKER });
  }
  return { role: 'tool', tool_call_id: tc.id, content: DUPLICATE_MARKER };
}

function recordExecuted(ledger: ToolRunLedger, name: string, input: ToolInput, toolResult: ToolResult): void {
  ledger.allToolCalls.push({ name, input });
  ledger.allToolResults.push({ success: toolResult.success, output: toolResult.output });
  ledger.toolEvidence.push({
    name,
    input,
    success: toolResult.success,
    output: toolResult.output,
    data: toolResult.data,
    alreadyExists: toolResult.alreadyExists,
  });
}

async function executeFresh(
  env: ToolRoundEnv,
  phase: ToolLoopPhase,
  tc: StreamToolCall,
  input: ToolInput,
  dedupKey: string,
  exposedThisRound: ReadonlySet<string> | undefined,
  checkRequestActive: () => void,
): Promise<ExecutedToolResult> {
  const { ctx, writer, dbg, requestMetrics, exposure, ledger } = env;
  try {
    if (tc.name !== DISCOVERY_TOOL && !SILENT_TOOLS.has(tc.name)) {
      // Group chats: never surface raw tool arguments (invitee_id, owner_id, etc.) in the
      // execution log — same "hide targets from other members" contract as the write receipt's
      // ReceiptView.hideTargets (ctx.isGroup).
      writer.setToolLabel(tc.name, ctx.isGroup ? undefined : input);
      await writer.flush(true);
    }
  } finally {
    // No handler has started: an expired flush must not turn into a late write.
    checkRequestActive();
  }

  const toolStartedAt = performance.now();
  const toolResult =
    (exposure && exposedThisRound ? exposure.intercept(tc.name, input, exposedThisRound) : undefined) ??
    (await executeTool(ctx, tc.name, input));
  const toolElapsedMs = elapsedMs(toolStartedAt);
  requestMetrics.recordTool(toolElapsedMs);
  if (phase === 'main') {
    aiLogger.info(
      {
        requestId: env.requestId,
        tool: tc.name,
        durationMs: toolElapsedMs,
        success: toolResult.success,
        disposition: toolResult.disposition,
      },
      'Tool call complete',
    );
  }
  ledger.writeOutcomes.record(tc.name, input, toolResult, ctx.isGroup, ctx.user.timezone);

  // Record dedup key only after a successful execution — failed calls
  // must not block retries with a synthetic DUPLICATE result.
  if (toolResult.disposition === 'executed') {
    ledger.seenToolCallKeys.add(dedupKey);
  }

  if (tc.name !== DISCOVERY_TOOL) writer.markToolResult(toolResult.success);
  dbg?.logToolResult(tc.name, toolResult.success, toolResult.output, toolResult.error);

  if (tc.name !== DISCOVERY_TOOL) recordExecuted(ledger, tc.name, input, toolResult);
  return toolResult;
}

/**
 * Runs the calls of one round. The first call that asks to stop the loop ends the round: its
 * result, and those before it, are persisted and the rest are not run.
 */
export async function runToolCalls(
  env: ToolRoundEnv,
  phase: ToolLoopPhase,
  round: number,
  toolCalls: readonly StreamToolCall[],
  exposedThisRound: ReadonlySet<string> | undefined,
  skipPersistIds: Set<string>,
): Promise<ToolRoundOutcome> {
  const { ctx, writer, dbg, ledger } = env;
  const messages: MessageParam[] = [];
  const checkRequestActive = () => {
    const signal = ctx.requestSignal;
    if (!signal?.aborted) return;
    if (!ctx.supplementMode) {
      const answeredIds = new Set(
        messages.flatMap((message) => (message.role === 'tool' ? [message.tool_call_id] : [])),
      );
      // This runs only before dispatch or after its actual result was recorded. Every
      // unanswered call is therefore still unstarted; never infer this in a catch after dispatch.
      // Complete the history block so sanitization retains the real completed prefix.
      const unstarted: MessageParam[] = toolCalls
        .filter((call) => !answeredIds.has(call.id))
        .map((call) => ({
          role: 'tool',
          tool_call_id: call.id,
          content: toolResultContent({
            success: false,
            mutationState: 'not_applied',
            error: 'Request ended before this tool was dispatched. No operation was performed.',
          }),
        }));
      env.saveResults([...messages, ...unstarted], skipPersistIds);
    }
    signal.throwIfAborted();
  };

  for (const tc of toolCalls) {
    checkRequestActive();
    const input = parseToolInput(tc, phase);
    if (phase === 'main') {
      aiLogger.info({ tool: tc.name, input, userId: ctx.user.telegram_id, chatId: ctx.chatId }, 'Tool call');
      dbg?.logToolCall(tc.name, input);
    }

    // Delivery and profile contact save already ran in the picker. A receipt continuation is
    // read-only from its first tool call, including provider fallback and every prose rewrite.
    // Enforce this before dispatch or dedup; neither model arguments nor loop phase grant writes.
    if (ctx.invitationDeliveryReceipts?.length && tc.name !== DISCOVERY_TOOL && !isReadOnlyCall(tc.name, input)) {
      const refused: ExecutedToolResult = {
        success: false,
        error:
          'This tool call is not permitted in a picker continuation. Report the existing outcomes or use read tools. An explicit new user request is required before sending or changing anything else.',
        mutationState: 'not_applied',
        disposition: 'failed',
      };
      aiLogger.warn({ requestId: env.requestId, tool: tc.name }, 'Blocked unauthorized picker continuation action');
      dbg?.logToolResult(tc.name, false, undefined, refused.error);
      // The continuation did not request another calendar write. Keep the refusal as tool
      // evidence without turning the existing picker outcome into a failed write receipt.
      recordExecuted(ledger, tc.name, input, refused);
      messages.push({ role: 'tool', tool_call_id: tc.id, content: toolResultContent(refused) });
      continue;
    }

    const dedupKey = toolCallKey(tc.name, input);
    if (ledger.seenToolCallKeys.has(dedupKey)) {
      messages.push(answerDuplicate(env, phase, round, tc, input));
      continue;
    }

    const toolResult = await executeFresh(env, phase, tc, input, dedupKey, exposedThisRound, checkRequestActive);
    messages.push({ role: 'tool', tool_call_id: tc.id, content: toolResultContent(toolResult) });
    // A completed write/acknowledgement is recorded before the request can stop this round.
    checkRequestActive();

    if (toolResult.stopLoop) {
      // commitIntermediate() is skipped on purpose: this round's prose (the model's final,
      // not-yet-validated claim) must never be folded into the trusted "⚙️ Execution log" as if
      // it were a tool result. finalize()'s own trailing sweep still commits already-marked toolLines.
      writer.clearToolLabel();
      if (!ctx.supplementMode && messages.length > 0) env.saveResults(messages, skipPersistIds);
      return { messages, stop: { waiting: toolResult.disposition === 'waiting' } };
    }
  }
  return { messages, stop: null };
}
