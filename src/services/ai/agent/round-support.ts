// Small helpers shared by the main round loop and the validation-retry loop.
import type OpenAI from 'openai';
import { findWeekdayDateMismatches, type WeekdayDateMismatch } from '../day-references.ts';
import type { AgentRequestMetrics } from '../request-metrics.ts';
import type { aiStreamRound, StreamCallbacks, StreamRoundResult, StreamToolCall } from '../streaming.ts';
import type { TelegramStreamWriter } from '../telegram-stream.ts';
import { SILENT_TOOLS, SKIP_PERSIST_TOOLS } from '../tool-executor.ts';
import { DISCOVERY_TOOL, runRoundRevealingRejectedTools } from '../tool-exposure.ts';
import { getToolDefinitions } from '../tools.ts';
import type { AgentContext } from '../types.ts';
import type { MessageParam } from './message-sanitizer.ts';
import type { ToolExposure } from './tool-round.ts';

/** The request's tool catalog: its mode's tools, with make_call only when a call can be placed. */
export function toolDefinitionsFor(ctx: AgentContext): OpenAI.ChatCompletionTool[] {
  return getToolDefinitions(ctx.inputMode, ctx.supplementMode, { calls: ctx.calls !== undefined });
}

/** Detect [SKIP] / ellipsis-only outputs the bot should discard instead of sending. */
export function isSkipText(text: string): boolean {
  const t = text.trim();
  if (t.length === 0) return false; // empty text is handled separately; not a SKIP
  return t === '[SKIP]' || text.includes('[SKIP]') || t === '...' || t === '…';
}

/**
 * Settles a finished round's streamed prose, held by the writer since its first weekday:
 * consistent prose is released to the screen, prose pairing a weekday with another
 * weekday's date is dropped unseen. Returns the mismatches for the caller to act on.
 */
export function checkRoundWeekdays(
  writer: TelegramStreamWriter,
  text: string,
  timezone: string,
): WeekdayDateMismatch[] {
  const mismatches = findWeekdayDateMismatches(text, new Date(), timezone);
  if (mismatches.length > 0) writer.dropDraftText();
  else writer.releaseDraft();
  return mismatches;
}

/**
 * Tool call IDs that must not be persisted (meta/query tools like get_history).
 * Computed upfront so saveAssistantTurn can strip them from the assistant message
 * before writing to DB, keeping the persisted tool_calls / tool_results in sync.
 */
export function skipPersistIdsFor(toolCalls: readonly StreamToolCall[]): Set<string> {
  return new Set(
    toolCalls.filter((tc) => tc.name === DISCOVERY_TOOL || SKIP_PERSIST_TOOLS.has(tc.name)).map((tc) => tc.id),
  );
}

/** Streams a round's prose and tool labels into the writer, and stamps first visible output. */
export function createRoundCallbacks(
  writer: TelegramStreamWriter,
  requestMetrics: AgentRequestMetrics,
): StreamCallbacks {
  return {
    onTextDelta: (text) => {
      requestMetrics.markVisible();
      writer.appendText(text);
      writer.flush(false).catch(() => {});
    },
    onToolCallStart: (name) => {
      if (name === DISCOVERY_TOOL || SILENT_TOOLS.has(name)) return;
      requestMetrics.markVisible();
      // Only set the label — don't flush. The tool loop flushes
      // sequentially with full input details. Fire-and-forget flush
      // here raced with the tool loop in noPlaceholder (group) mode,
      // creating orphaned messages.
      writer.setToolLabel(name);
    },
    onProviderSwitch: () => {
      writer.resetDraft();
    },
  };
}

/** One model round's outcome and the tool set its successful attempt was actually sent with. */
export interface ModelRound {
  result: StreamRoundResult;
  exposedThisRound: ReadonlySet<string> | undefined;
}

export interface ModelRoundInput {
  ctx: AgentContext;
  stream: typeof aiStreamRound;
  messages: MessageParam[];
  callbacks: StreamCallbacks;
  exposure: ToolExposure | undefined;
  /** Read per provider attempt, so a retry loop can hand each attempt what is left of its budget. */
  signal: () => AbortSignal;
}

/**
 * Runs one model round with the tools the request currently exposes: through the
 * reveal-and-retry recovery in lazy/hybrid schema modes, with the full catalog otherwise.
 */
export async function runModelRound(input: ModelRoundInput): Promise<ModelRound> {
  const { ctx, stream, messages, callbacks, exposure, signal } = input;
  const runRound = (tools: OpenAI.ChatCompletionTool[], deferOutageAlert = false) =>
    stream(
      {
        messages,
        tools,
        maxTokens: 4096,
        temperature: 0.3,
        signal: signal(),
        userId: ctx.user.telegram_id,
        deferOutageAlert,
      },
      callbacks,
    );
  return exposure
    ? await runRoundRevealingRejectedTools(exposure, runRound)
    : {
        result: await runRound(toolDefinitionsFor(ctx)),
        exposedThisRound: undefined,
      };
}
