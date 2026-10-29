import type { ChatHistoryMessage } from '../../database/types.ts';
import { logger } from '../../utils/logger.ts';
import { hasPersistablePayload, withoutSkippedToolCalls } from './agent/assistant-turn.ts';
import {
  buildHistoryMessages,
  relevantHistoryRows,
  withRetryQuestion,
  withSupplementTurn,
} from './agent/conversation.ts';
import { announceFailure } from './agent/failure-announcement.ts';
import { agentGiveUpMessage, aiFailureNotices } from './agent/failure-notices.ts';
import { AssistantMessageCodec, tagSender } from './agent/history-rows.ts';
import { createMeasuredStream, type StreamPurpose } from './agent/measured-stream.ts';
import {
  isToolMessage,
  type MessageParam,
  regroupToolCallBlocks,
  sanitizeMessages,
} from './agent/message-sanitizer.ts';
import { settleFinalResponse } from './agent/response-validation.ts';
import { type RetryOutcome, storeRetryAfterFailure } from './agent/retry-store.ts';
import { runRoundLoop } from './agent/round-loop.ts';
import { toolDefinitionsFor } from './agent/round-support.ts';
import { AGENT_DRAIN_SETTLE_MS, RETRY_STORE_TIMEOUT_MS, TIMEOUT_MS } from './agent/run-limits.ts';
import type { AgentRunResult, AgentToolCallRecord, AgentToolResultRecord } from './agent/run-types.ts';
import { toolCallKey, toolResultContent } from './agent/tool-call-key.ts';
import type { ToolRunLedger } from './agent/tool-round.ts';
import { finishTurn } from './agent/turn-finish.ts';
import { createTurnState, type RunFailure, type TurnEnv, type TurnState } from './agent/turn-state.ts';
import { createTurnWriter, senderForTurn } from './agent/turn-writer.ts';
import { resolveTurnDayReferences } from './day-reference-guard.ts';
import type { AiDebugLogger, AiDebugRunContext } from './debug-logger.ts';
import type { HistorySummarizer } from './history-summarizer.ts';
import { waitForAbort } from './provider-deadline.ts';
import { AgentRequestMetrics } from './request-metrics.ts';
import { aiStreamRound } from './streaming.ts';
import { assembleSystemPrompt, buildSystemPromptParts, type SystemPromptParts } from './system-prompt.ts';
import { WRITE_TOOLS } from './tool-executor.ts';
import { createToolExposure } from './tool-exposure.ts';
import type { ToolSchemaMode } from './tool-schema-mode.ts';
import type { AgentConfig, AgentContext, TelegramSender } from './types.ts';
import { WriteOutcomes } from './write-outcomes.ts';

export type { FailureNotice, FailureNoticeKind, FailureNoticeOptions } from './agent/failure-notices.ts';
export {
  AGENT_DRAIN_SETTLE_MS,
  AssistantMessageCodec,
  agentGiveUpMessage,
  aiFailureNotices,
  tagSender,
  toolCallKey,
  toolResultContent,
};
export type { AgentRunResult, AgentToolCallRecord, AgentToolResultRecord };

const aiLogger = logger.child({ module: 'ai-agent' });

export class CalendarBotAgent {
  private toolSchemaMode: ToolSchemaMode;
  private sender: TelegramSender;
  private debugLogger?: AiDebugLogger;
  private streamImpl: typeof aiStreamRound;
  private summarizer?: HistorySummarizer;
  private requestTimeoutMs: number;
  private readonly retryStoreTimeoutMs: number;
  /** Aborts every in-flight and later run once the process starts shutting down. */
  private readonly shutdown = new AbortController();
  /** Runs not yet settled, including their debug-log flush — what a shutdown drain waits for. */
  private readonly inFlight = new Set<Promise<AgentRunResult>>();

  constructor(
    config: AgentConfig,
    sender: TelegramSender,
    opts?: { streamImpl?: typeof aiStreamRound; requestTimeoutMs?: number; retryStoreTimeoutMs?: number },
  ) {
    this.toolSchemaMode = config.toolSchemaMode ?? 'full';
    this.sender = sender;
    this.debugLogger = config.debugLogger;
    this.streamImpl = opts?.streamImpl ?? aiStreamRound;
    this.summarizer = config.summarizer;
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? TIMEOUT_MS;
    this.retryStoreTimeoutMs = opts?.retryStoreTimeoutMs ?? RETRY_STORE_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1 || this.requestTimeoutMs > TIMEOUT_MS)
      throw new Error(`requestTimeoutMs must be between 1 and ${TIMEOUT_MS}`);
  }

  getSender(): TelegramSender {
    return this.sender;
  }

  async buildMessages(
    ctx: AgentContext,
    history: ChatHistoryMessage[],
    measuredStream?: typeof aiStreamRound,
    signal?: AbortSignal,
  ): Promise<{ systemParts: SystemPromptParts; messages: MessageParam[] }> {
    // IMPORTANT: history must already contain the current user message.
    // The chat-logging middleware (bot/middleware/chat-logging.ts) saves it via ConversationLogger
    // before the pipeline runs, so by the time agent.run() is called, it is present.
    const systemParts = buildSystemPromptParts(ctx);
    const rows = relevantHistoryRows(ctx, history, 50);
    const messages = await buildHistoryMessages(ctx, rows, { summarizer: this.summarizer, measuredStream, signal });
    // The retry question is judged against the newest saved row, before regrouping moved anything to the end.
    const ordered = withRetryQuestion(ctx, messages, regroupToolCallBlocks(messages));
    return { systemParts, messages: withSupplementTurn(ctx, sanitizeMessages(ordered)) };
  }

  saveAssistantTurn(ctx: AgentContext, assistantMessage: MessageParam, skipIds?: Set<string>): void {
    const msgToSave = withoutSkippedToolCalls(assistantMessage, skipIds);
    if (!hasPersistablePayload(msgToSave)) return;
    const chatId = ctx.isGroup ? ctx.groupChatId : undefined;
    // The conversation logger stores the full JSON payload under role='assistant'.
    // We stringify manually here so parseHistoryRow can round-trip the value.
    ctx.conversationLogger.logAiTurn(ctx.user.telegram_id, msgToSave, chatId);
  }

  saveToolResults(ctx: AgentContext, toolResults: MessageParam[], skipIds?: Set<string>): void {
    const toSave = skipIds?.size
      ? toolResults.filter((m) => !isToolMessage(m) || !skipIds.has(m.tool_call_id))
      : toolResults;
    if (toSave.length === 0) return;
    const chatId = ctx.isGroup ? ctx.groupChatId : undefined;
    ctx.conversationLogger.logToolResults(ctx.user.telegram_id, toSave, chatId);
  }

  /**
   * Shutdown hook: abort every in-flight run and wait until each has taken its
   * failure path — user notice, durable retry or write evidence, debug log — so
   * nothing is still writing when the caller closes the queues and the database.
   * Runs that start while it waits (a queue job, a handler finishing its download)
   * fail fast and are waited for too. Anything still running after `settleMs` is
   * logged and left behind.
   */
  async drain(settleMs: number): Promise<void> {
    this.shutdown.abort(new Error('Bot is shutting down'));
    if (this.inFlight.size === 0) return;
    const initialInFlight = this.inFlight.size;
    const deadline = Promise.withResolvers<'timeout'>();
    const timer = setTimeout(() => deadline.resolve('timeout'), settleMs);
    try {
      while (this.inFlight.size > 0) {
        const outcome = await Promise.race([Promise.allSettled([...this.inFlight]), deadline.promise]);
        if (outcome === 'timeout') break;
      }
      const stillRunning = this.inFlight.size;
      if (stillRunning > 0)
        aiLogger.warn({ initialInFlight, stillRunning }, 'Agent runs abandoned at shutdown deadline');
      else aiLogger.info({ initialInFlight }, 'Agent runs drained for shutdown');
    } finally {
      clearTimeout(timer);
    }
  }

  run(ctx: AgentContext): Promise<AgentRunResult> {
    // Registers the exact promise the caller holds, synchronously: the drain must wait for every turn.
    let dbg: AiDebugRunContext | null = null;
    try {
      dbg =
        this.debugLogger?.createRunContext(
          ctx.user.telegram_id,
          ctx.chatId,
          ctx.user.username,
          ctx.user.first_name,
          ctx.groupTitle ?? null,
          !!ctx.supplementMode,
          ctx.messageText,
          ctx.supplementAutoResponse,
        ) ?? null;
    } catch (err) {
      // Debug logging is evidence, not a dependency: the turn still runs without it.
      aiLogger.warn({ err, userId: ctx.user.telegram_id }, 'AI debug log unavailable for this turn');
    }
    const turn = this.runTurn(ctx, dbg).finally(() => {
      this.inFlight.delete(turn);
      // Every exit leaves the turn's evidence, including one that threw after its failure path.
      dbg?.flush();
    });
    this.inFlight.add(turn);
    return turn;
  }

  /**
   * Loads what the model is asked to continue from: the history with this turn's day references
   * resolved, condensed by the summarizer, behind the system prompt for the request's tool mode.
   */
  private async startConversation(env: TurnEnv, state: TurnState, summaryStream: typeof aiStreamRound): Promise<void> {
    const { ctx, dbg, requestSignal } = env;
    const history = ctx.chatHistory.getRecent(ctx.user.telegram_id, 30);
    // A bare "Да" answers the ask_user of the conversation it was saved to: the group's own.
    const turnHistory = relevantHistoryRows(ctx, history, 30);
    ctx.dayReferences = resolveTurnDayReferences(ctx.messageText, turnHistory, new Date(), ctx.user.timezone);
    const { systemParts, messages: rawHistoryMessages } = await waitForAbort(
      () => this.buildMessages(ctx, history, summaryStream, requestSignal),
      requestSignal,
    );
    const summarizer = this.summarizer;
    const historyMessages = summarizer
      ? await waitForAbort(
          () => summarizer.condenseHistory(rawHistoryMessages, summaryStream, requestSignal),
          requestSignal,
        )
      : rawHistoryMessages;
    const activePrompt = assembleSystemPrompt(systemParts, env.exposure?.prompt);
    dbg?.logSystemPrompt(activePrompt);
    dbg?.logHistory(historyMessages);
    state.currentMessages = [{ role: 'system', content: activePrompt }, ...historyMessages];
  }

  private async runTurn(ctx: AgentContext, dbg: AiDebugRunContext | null): Promise<AgentRunResult> {
    const startTime = Date.now();
    const requestSignal = AbortSignal.any([AbortSignal.timeout(this.requestTimeoutMs), this.shutdown.signal]);
    const requestMetrics = new AgentRequestMetrics();
    const requestId = requestMetrics.requestId;
    aiLogger.info(
      {
        requestId,
        userId: ctx.user.telegram_id,
        chatId: ctx.chatId,
        supplementMode: !!ctx.supplementMode,
        msg: ctx.messageText.slice(0, 100),
      },
      'Agent run started',
    );

    const streamFor = (purpose: StreamPurpose) =>
      createMeasuredStream({ streamImpl: this.streamImpl, requestSignal, requestMetrics, requestId }, purpose);
    const summaryStream = streamFor('history');

    const exposure =
      this.toolSchemaMode !== 'full' && ctx.inputMode !== 'live_call'
        ? createToolExposure(toolDefinitionsFor(ctx), this.toolSchemaMode)
        : undefined;

    const effectiveSender = senderForTurn(ctx, this.sender);
    ctx.sender = effectiveSender;
    const writer = createTurnWriter(ctx, effectiveSender);

    const state = createTurnState();
    const ledger: ToolRunLedger = {
      allToolCalls: [],
      allToolResults: [],
      toolEvidence: [],
      seenToolCallKeys: new Set<string>(),
      writeOutcomes: new WriteOutcomes(WRITE_TOOLS),
    };
    const env: TurnEnv = {
      ctx,
      writer,
      dbg,
      requestMetrics,
      requestId,
      exposure,
      ledger,
      saveResults: (messages, skipIds) => this.saveToolResults(ctx, messages, skipIds),
      saveAssistant: (message, skipIds) => {
        if ('tool_calls' in message && message.tool_calls?.length) {
          this.saveAssistantTurn(ctx, { ...message, content: null }, skipIds);
        } else {
          state.pendingHistory.push(message);
        }
      },
      startTime,
      requestTimeoutMs: this.requestTimeoutMs,
      retryStream: streamFor('retry'),
      requestSignal,
      agentStream: streamFor('agent'),
      validatorStream: streamFor('validator'),
    };

    const failure: RunFailure = { failed: false, error: undefined, retry: 'not_stored' };
    try {
      await writer.init();
      await this.startConversation(env, state, summaryStream);
      await runRoundLoop(env, state);
      await settleFinalResponse(env, state);
    } catch (error) {
      aiLogger.error({ err: error, userId: ctx.user.telegram_id }, 'Agent error');
      failure.failed = true;
      failure.error = error;
      state.termination = 'error';
      failure.retry = await storeRetryAfterFailure(
        ctx,
        error,
        { responseUnverified: state.responseUnverified, mayHaveMutated: ledger.writeOutcomes.mayHaveMutated },
        this.retryStoreTimeoutMs,
      );
    }

    return finishTurn(env, state, failure, {
      saveTurn: (message) => this.saveAssistantTurn(ctx, message),
      announceFailure: (error, retry) => this.announceFailure(ctx, error, writer, retry),
      endSession: () => this.debugLogger?.endSession(ctx.chatId),
    });
  }

  private announceFailure(ctx: AgentContext, error: unknown, writer: TurnEnv['writer'], retry: RetryOutcome): void {
    announceFailure({
      ctx,
      error,
      writer,
      retry,
      shuttingDown: this.shutdown.signal.aborted,
      saveTurn: (text) => this.saveAssistantTurn(ctx, { role: 'assistant', content: text }),
    });
  }
}
