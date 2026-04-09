import type Anthropic from '@anthropic-ai/sdk';
import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { z } from 'zod';
import type { ChatHistoryMessage } from '../../database/types.ts';
import { jsonCodec } from '../../utils/json-codec.ts';
import { logger } from '../../utils/logger.ts';
import { buildAddressContext } from '../location/address-context.ts';
import { type ActivityEvent, formatActivityEvent } from './activity-event.ts';
import { createAnthropicClient } from './anthropic-client.ts';
import type { AiDebugLogger, AiDebugRunContext } from './debug-logger.ts';
import { validateResponse } from './response-validator.ts';
import { buildSystemPrompt } from './system-prompt.ts';
import { TelegramStreamWriter } from './telegram-stream.ts';
import { executeTool } from './tool-executor.ts';
import { getToolDefinitions, type UserCapabilities } from './tools.ts';
import type { AgentConfig, AgentContext, TelegramSender } from './types.ts';

const aiLogger = logger.child({ module: 'ai-agent' });

/** Text patterns that mean "stay silent" — works in both groups and DMs. */
function isSkipText(text: string): boolean {
  const trimmed = text.trim();
  const upper = trimmed.toUpperCase();
  return (
    upper.includes('[SKIP]') ||
    upper.includes('[ПРОПУСК]') ||
    upper.includes('[SKIP') ||
    upper.includes('ПРОПУСК]') ||
    trimmed === '...' ||
    trimmed === '…'
  );
}

const MAX_ROUNDS = 15;
const TIMEOUT_MS = 90_000;
const MAX_API_RETRIES = 2;
const RETRY_DELAY_MS = 1500;

interface MessageParam {
  role: 'user' | 'assistant';
  content: string | Anthropic.ContentBlockParam[];
}

function withTimestamp(text: string, createdAt: string, timezone: string): string {
  const local = format(new TZDate(new Date(`${createdAt}Z`), timezone), 'yyyy-MM-dd HH:mm:ss');
  return `[${local}] ${text}`;
}

function sanitizeMessages(messages: MessageParam[]): MessageParam[] {
  // Ensure strict user/assistant alternation required by the API.
  // Uses '...' placeholders so no history is lost.
  const result: MessageParam[] = [];
  for (const msg of messages) {
    const lastRole = result.length > 0 ? result[result.length - 1]!.role : null;
    if (lastRole === null) {
      // First message must be user
      if (msg.role !== 'user') result.push({ role: 'user', content: '...' });
    } else if (lastRole === msg.role) {
      // Same role twice — insert opposite placeholder
      result.push({ role: msg.role === 'user' ? 'assistant' : 'user', content: '...' });
    }
    result.push(msg);
  }
  return result;
}

export interface AgentToolCallRecord {
  name: string;
  input: { [key: string]: unknown };
}

export interface AgentToolResultRecord {
  success: boolean;
  output?: string;
}

export interface AgentRunResult {
  responseText: string;
  toolCalls: AgentToolCallRecord[];
  toolResults: AgentToolResultRecord[];
  endCall?: boolean;
}

export class CalendarBotAgent {
  private client: Anthropic;
  private fallbackClient: Anthropic | null;
  private model: string;
  private fallbackModel: string | null;
  private validationModel: string | null;
  private sender: TelegramSender;
  private debugLogger?: AiDebugLogger;

  constructor(config: AgentConfig, sender: TelegramSender) {
    this.client = createAnthropicClient({ apiKey: config.apiKey, baseURL: config.baseUrl });
    this.model = config.model;
    this.validationModel = config.validationModel ?? null;
    this.sender = sender;
    this.debugLogger = config.debugLogger;
    this.fallbackClient = config.fallback
      ? createAnthropicClient({
          apiKey: config.fallback.apiKey ?? config.apiKey,
          baseURL: config.fallback.baseUrl ?? config.baseUrl,
        })
      : null;
    this.fallbackModel = config.fallback?.model ?? null;
  }

  getSender(): TelegramSender {
    return this.sender;
  }

  buildMessages(
    ctx: AgentContext,
    history: ChatHistoryMessage[],
    caps?: UserCapabilities,
  ): { systemPrompt: string; messages: MessageParam[] } {
    // IMPORTANT: history must already contain the current user message.
    // The universal GramIO middleware in bot/index.ts saves it via ConversationLogger
    // before the pipeline runs, so by the time agent.run() is called, it is present.
    // If this agent is ever called outside that middleware (e.g. from tests or a new entry point),
    // the caller is responsible for saving the message first.
    const systemPrompt = buildSystemPrompt(ctx, caps);

    const relevantHistory =
      ctx.isGroup && ctx.groupChatId ? ctx.chatHistory.getRecentByChat(ctx.groupChatId, 50) : history;

    const messages: MessageParam[] = [];
    const senderCache = new Map<number, string>();

    const ContentBlocksCodec = jsonCodec(
      z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
    );
    const ActivityEventCodec = jsonCodec(z.object({ kind: z.string() }).passthrough());

    for (const msg of relevantHistory) {
      let content: string | Anthropic.ContentBlockParam[];
      const blocksResult = ContentBlocksCodec.safeParse(msg.content);
      if (blocksResult.success) {
        content = blocksResult.data as Anthropic.ContentBlockParam[];
      } else {
        const activityResult = ActivityEventCodec.safeParse(msg.content);
        if (activityResult.success) {
          content = withTimestamp(
            formatActivityEvent(activityResult.data as ActivityEvent),
            msg.created_at,
            ctx.user.timezone,
          );
        } else {
          content = withTimestamp(msg.content, msg.created_at, ctx.user.timezone);
        }
      }
      const role = msg.role === 'tool' ? 'user' : msg.role;

      // For group chats, inject sender name+id into plain text user messages
      if (ctx.isGroup && ctx.groupChatId && msg.role === 'user' && typeof content === 'string') {
        if (!senderCache.has(msg.user_id)) {
          const u = ctx.userRepo.findByTelegramId(msg.user_id);
          senderCache.set(msg.user_id, u?.first_name ?? u?.username ?? 'User');
        }
        const name = senderCache.get(msg.user_id)!;
        const senderTag = `[From: ${name} (id:${msg.user_id})] `;
        const tsPattern = /^(\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] )/;
        content = tsPattern.test(content) ? content.replace(tsPattern, `$1${senderTag}`) : `${senderTag}${content}`;
      }

      messages.push({ role, content } as MessageParam);
    }

    return { systemPrompt, messages: sanitizeMessages(messages) };
  }

  saveAssistantTurn(ctx: AgentContext, contentBlocks: Anthropic.ContentBlockParam[]): void {
    const chatId = ctx.isGroup ? ctx.groupChatId : undefined;
    ctx.conversationLogger.logAiTurn(ctx.user.telegram_id, contentBlocks, chatId);
  }

  saveToolResults(ctx: AgentContext, toolResults: Anthropic.ToolResultBlockParam[]): void {
    const chatId = ctx.isGroup ? ctx.groupChatId : undefined;
    ctx.conversationLogger.logToolResults(ctx.user.telegram_id, toolResults, chatId);
  }

  async run(ctx: AgentContext): Promise<AgentRunResult> {
    aiLogger.info(
      {
        userId: ctx.user.telegram_id,
        chatId: ctx.chatId,
        supplementMode: !!ctx.supplementMode,
        msg: ctx.messageText.slice(0, 100),
      },
      'Agent run started',
    );

    // Preload address context (async) before building messages (sync)
    if (ctx.addressCache && !ctx.preloadedAddressContext) {
      try {
        ctx.preloadedAddressContext = await buildAddressContext(ctx.addressCache, ctx.user.telegram_id);
      } catch (err) {
        aiLogger.warn({ err, userId: ctx.user.telegram_id }, 'Failed to preload address context');
      }
    }

    const caps: UserCapabilities = {
      assistantEnabled: Boolean(ctx.user.assistant_enabled),
    };
    const history = ctx.chatHistory.getRecent(ctx.user.telegram_id, 30);
    const { systemPrompt, messages } = this.buildMessages(ctx, history, caps);

    const dbg: AiDebugRunContext | null =
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
    dbg?.logSystemPrompt(systemPrompt);
    dbg?.logHistory(messages);

    const effectiveSender: TelegramSender = ctx.supplementMode
      ? ({
          sendMessage: async () => ({ message_id: 0 }),
          editMessageText: async () => {},
          sendMessageWithKeyboard: async () => ({ message_id: 0 }),
          sendButtons: async () => ({ message_id: 0 }),
          sendUserPicker: async () => ({ message_id: 0 }),
          sendPhoto: async () => ({ message_id: 0 }),
          sendInvitation: async () => null,
          sendEditProposal: async () => null,
          sendAsUser: async () => false,
          deleteMessage: async () => {},
          setReaction: async () => {},
        } satisfies TelegramSender)
      : this.sender;
    ctx.sender = effectiveSender;
    const writer = new TelegramStreamWriter(effectiveSender, ctx.chatId, ctx.user.language, {
      userTranscript: ctx.inputMode === 'live_call' ? ctx.messageText : undefined,
      noPlaceholder: ctx.isGroup,
    });
    await writer.init();

    // Stream macOS agent chunks into the same writer so they appear live
    // and land in the collapsed blockquote after commitIntermediate().
    // tailText keeps only the last 3500 chars so Telegram never rejects the edit.
    if (ctx.agents) {
      ctx.agents.onAgentChunk = (text: string) => {
        writer.appendText(text);
        writer.tailText(3500);
        writer.flush(false).catch((err) => aiLogger.warn({ err }, 'agent chunk flush failed'));
      };
    }

    const startTime = Date.now();
    const allToolCalls: AgentToolCallRecord[] = [];
    const allToolResults: AgentToolResultRecord[] = [];

    try {
      let currentMessages = [...messages];

      for (let round = 0; round < MAX_ROUNDS; round++) {
        dbg?.logRound(round);

        if (Date.now() - startTime > TIMEOUT_MS) {
          aiLogger.warn({ userId: ctx.user.telegram_id }, 'Agent timeout');
          writer.appendText('\n\n⚠️ Timeout reached.');
          break;
        }

        let hasToolUse = false;
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        const contentBlocks: Anthropic.ContentBlockParam[] = [];

        const makeStreamRequest = (client: Anthropic, model: string) =>
          client.messages.stream({
            model,
            max_tokens: 4096,
            system: [
              {
                type: 'text',
                text: systemPrompt,
                cache_control: { type: 'ephemeral' },
              },
            ],
            messages: currentMessages,
            tools: getToolDefinitions(ctx.inputMode, caps, ctx.supplementMode),
          });

        type StreamType = ReturnType<typeof makeStreamRequest>;
        let stream: StreamType;
        let lastError: unknown;
        let usedFallback = false;

        const consumeStream = async (s: StreamType) => {
          // Register listeners to prevent Anthropic SDK's intentional Promise.reject()
          // for unhandled abort/error events (MessageStream._emit lines 282, 299)
          s.on('abort', (err) => aiLogger.warn({ err }, 'Anthropic stream aborted'));
          s.on('error', (err) => aiLogger.warn({ err }, 'Anthropic stream error'));

          for await (const event of s) {
            if (event.type === 'content_block_delta') {
              if (event.delta.type === 'text_delta') {
                writer.appendText(event.delta.text);
                await writer.flush(false);
              }
            }

            if (event.type === 'content_block_start') {
              if (event.content_block.type === 'tool_use') {
                hasToolUse = true;
                writer.setToolLabel(event.content_block.name);
                await writer.flush(true);
              }
            }

            if (event.type === 'message_delta') {
              if (event.delta.stop_reason === 'tool_use') {
                hasToolUse = true;
              }
            }
          }
        };

        const isRetryableError = (err: unknown): boolean => {
          const s = String(err);
          return (
            s.includes('Network') ||
            s.includes('overloaded') ||
            s.includes('AbortError') ||
            s.includes('connection was closed') ||
            s.includes('529') ||
            s.includes('rate') ||
            s.includes('ECONNRESET')
          );
        };

        // Primary model retry loop
        for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
          try {
            stream = makeStreamRequest(this.client, this.model);
            await consumeStream(stream);
            lastError = undefined;
            break;
          } catch (err) {
            lastError = err;
            if (!isRetryableError(err) || attempt >= MAX_API_RETRIES) break;
            aiLogger.warn({ attempt: attempt + 1, err, userId: ctx.user.telegram_id }, 'API call failed, retrying');
            const baseDelay = RETRY_DELAY_MS * (attempt + 1);
            const jitter = Math.random() * baseDelay;
            await Bun.sleep(baseDelay + jitter);
          }
        }

        // Fallback model: try once if primary exhausted retries
        if (lastError && this.fallbackClient && this.fallbackModel) {
          aiLogger.warn(
            { err: lastError, fallbackModel: this.fallbackModel, userId: ctx.user.telegram_id },
            'Primary model failed, trying fallback',
          );
          try {
            stream = makeStreamRequest(this.fallbackClient, this.fallbackModel);
            await consumeStream(stream);
            lastError = undefined;
            usedFallback = true;
          } catch (fallbackErr) {
            aiLogger.error({ err: fallbackErr, userId: ctx.user.telegram_id }, 'Fallback model also failed');
            // Keep the original lastError — it's more informative
          }
        }

        if (lastError) throw lastError;
        if (usedFallback) {
          aiLogger.info({ userId: ctx.user.telegram_id, model: this.fallbackModel }, 'Used fallback model');
        }

        const finalMessage = await stream!.finalMessage();

        for (const block of finalMessage.content) {
          if (block.type === 'text') {
            contentBlocks.push({ type: 'text', text: block.text });
          } else if (block.type === 'tool_use') {
            contentBlocks.push({
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: block.input,
            });

            aiLogger.info(
              { tool: block.name, input: block.input, userId: ctx.user.telegram_id, chatId: ctx.chatId },
              'Tool call',
            );
            dbg?.logToolCall(block.name, block.input as { [key: string]: unknown });

            writer.setToolLabel(block.name, block.input as { [key: string]: unknown });
            await writer.flush(true);

            const result = await executeTool(ctx, block.name, block.input);

            writer.markToolResult(result.success);
            aiLogger.info(
              {
                tool: block.name,
                success: result.success,
                ...(!result.success && { error: result.error ?? result.output ?? 'Unknown error' }),
                userId: ctx.user.telegram_id,
                chatId: ctx.chatId,
              },
              'Tool result',
            );
            dbg?.logToolResult(block.name, result.success, result.output, result.error);

            allToolCalls.push({ name: block.name, input: block.input as { [key: string]: unknown } });
            allToolResults.push({ success: result.success, output: result.output });

            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: result.success
                ? `${result.output ?? 'OK'}${result.agentHint ? `\n[AGENT: ${result.agentHint}]` : ''}`
                : `Error: ${result.error ?? result.output ?? 'Unknown error'}`,
              is_error: !result.success,
            });

            if (result.stopLoop) {
              // Tool requested to stop and wait for user input
              writer.clearToolLabel();
              if (!ctx.supplementMode) {
                if (contentBlocks.length > 0) {
                  this.saveAssistantTurn(ctx, contentBlocks);
                }
                this.saveToolResults(ctx, toolResults);
              }
              writer.commitIntermediate();
              await writer.finalize();
              dbg?.logFinal(writer.getText().trim(), allToolCalls.length);
              dbg?.flush();
              if (allToolCalls.some((tc) => tc.name === 'end_conversation')) {
                this.debugLogger?.endSession(ctx.chatId);
              }
              return {
                responseText: ctx.inputMode !== 'text' ? writer.getPlainText() : writer.getText(),
                toolCalls: allToolCalls,
                toolResults: allToolResults,
                endCall: ctx.callEndRequested === true,
              };
            }
          }
        }

        writer.clearToolLabel();

        if (contentBlocks.length > 0) {
          this.saveAssistantTurn(ctx, contentBlocks);
        }

        if (!hasToolUse || toolResults.length === 0) {
          const roundText = writer.getText();
          if (!hasToolUse) {
            aiLogger.info(
              { userId: ctx.user.telegram_id, chatId: ctx.chatId, round, textPreview: roundText.slice(0, 300) },
              'AI text-only response (no tool calls)',
            );
            dbg?.logAiText(roundText);
          }
          break;
        }

        // [SKIP] in a round with tool calls — discard immediately so it doesn't
        // leak into intermediateChunks and appear in the finalized message.
        // Intentionally skips saveToolResults: silent tools (set_reaction etc.)
        // don't need history persistence — the side effect already happened.
        if (isSkipText(writer.getText())) {
          await writer.discard();
          dbg?.logFinal('[SKIP] (mid-loop discard)', allToolCalls.length);
          dbg?.flush();
          return { responseText: '', toolCalls: allToolCalls, toolResults: allToolResults };
        }

        writer.commitIntermediate();
        this.saveToolResults(ctx, toolResults);

        currentMessages = [
          ...currentMessages,
          { role: 'assistant' as const, content: contentBlocks },
          { role: 'user' as const, content: toolResults },
        ];
      }
      // Response validation: when no tools were called, verify the response isn't hallucinated
      if (this.validationModel && allToolCalls.length === 0 && !ctx.supplementMode) {
        const responseText = writer.getText().trim();
        if (responseText && !isSkipText(responseText)) {
          const validation = await validateResponse(this.client, this.validationModel, {
            userMessage: ctx.messageText,
            toolCalls: allToolCalls.map((tc) => tc.name),
            response: responseText,
          });

          if (!validation.approved) {
            aiLogger.info(
              { userId: ctx.user.telegram_id, reason: validation.reason },
              'Response validation REJECTED — retrying with tools',
            );

            writer.reset();
            allToolCalls.length = 0;
            allToolResults.length = 0;

            const retryMessages: MessageParam[] = [
              ...messages,
              { role: 'assistant', content: responseText },
              {
                role: 'user',
                content: `[SYSTEM] Your previous response was rejected by the quality validator. Reason: ${validation.reason}. You MUST call the appropriate tools and re-answer the question properly. Do NOT repeat the same mistake.`,
              },
            ];

            const retryResult = await this.runRetryLoop(
              ctx,
              retryMessages,
              systemPrompt,
              writer,
              dbg,
              caps,
              allToolCalls,
              allToolResults,
            );
            if (retryResult) return retryResult;
          }
        }
      }
    } catch (error) {
      aiLogger.error({ err: error, userId: ctx.user.telegram_id }, 'Agent error');

      const lang = ctx.user.language;
      const errorMsg =
        lang === 'ru'
          ? '\n\n⚠️ Произошла ошибка при обработке запроса.'
          : '\n\n⚠️ An error occurred while processing your request.';
      writer.appendText(errorMsg);
    }

    const finalText = writer.getText().trim();
    dbg?.logFinal(finalText, allToolCalls.length);
    dbg?.flush();

    if (allToolCalls.some((tc) => tc.name === 'end_conversation')) {
      this.debugLogger?.endSession(ctx.chatId);
    }

    aiLogger.info(
      {
        userId: ctx.user.telegram_id,
        chatId: ctx.chatId,
        toolCount: allToolCalls.length,
        supplementMode: !!ctx.supplementMode,
      },
      'Agent run complete',
    );

    if (isSkipText(finalText)) {
      await writer.discard();
      return { responseText: '', toolCalls: allToolCalls, toolResults: allToolResults };
    }

    await writer.finalize();

    const msgId = writer.getMessageId();
    if (ctx.onBotResponse && msgId !== null) {
      ctx.onBotResponse(msgId);
    }

    return {
      responseText: ctx.inputMode !== 'text' ? writer.getPlainText() : writer.getText(),
      toolCalls: allToolCalls,
      toolResults: allToolResults,
      endCall: ctx.callEndRequested === true,
    };
  }

  /**
   * Single retry round after validation rejection.
   * Runs one full agent loop iteration with the rejection feedback in context.
   */
  private async runRetryLoop(
    ctx: AgentContext,
    retryMessages: MessageParam[],
    systemPrompt: string,
    writer: TelegramStreamWriter,
    dbg: AiDebugRunContext | null,
    caps: UserCapabilities,
    allToolCalls: AgentToolCallRecord[],
    allToolResults: AgentToolResultRecord[],
  ): Promise<AgentRunResult | null> {
    dbg?.logRound(-1); // special "retry" round marker

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 4096,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: retryMessages,
      tools: getToolDefinitions(ctx.inputMode, caps, ctx.supplementMode),
    });

    stream.on('abort', (err) => aiLogger.warn({ err }, 'Retry stream aborted'));
    stream.on('error', (err) => aiLogger.warn({ err }, 'Retry stream error'));

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        writer.appendText(event.delta.text);
        await writer.flush(false);
      }
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        writer.setToolLabel(event.content_block.name);
        await writer.flush(true);
      }
    }

    const finalMessage = await stream.finalMessage();
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const block of finalMessage.content) {
      if (block.type === 'tool_use') {
        writer.setToolLabel(block.name, block.input as { [key: string]: unknown });
        await writer.flush(true);

        const result = await executeTool(ctx, block.name, block.input);
        writer.markToolResult(result.success);

        allToolCalls.push({ name: block.name, input: block.input as { [key: string]: unknown } });
        allToolResults.push({ success: result.success, output: result.output });

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result.success
            ? `${result.output ?? 'OK'}${result.agentHint ? `\n[AGENT: ${result.agentHint}]` : ''}`
            : `Error: ${result.error ?? result.output ?? 'Unknown error'}`,
          is_error: !result.success,
        });

        if (result.stopLoop) {
          writer.clearToolLabel();
          writer.commitIntermediate();
          await writer.finalize();
          return {
            responseText: ctx.inputMode !== 'text' ? writer.getPlainText() : writer.getText(),
            toolCalls: allToolCalls,
            toolResults: allToolResults,
            endCall: ctx.callEndRequested === true,
          };
        }
      }
    }

    writer.clearToolLabel();

    // If tools were called, feed results back to the model for a text response
    if (toolResults.length > 0) {
      const contentBlocks: Anthropic.ContentBlockParam[] = [];
      for (const block of finalMessage.content) {
        if (block.type === 'text') {
          contentBlocks.push({ type: 'text', text: block.text });
        } else if (block.type === 'tool_use') {
          contentBlocks.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
        }
      }

      writer.commitIntermediate();

      const followUpMessages: MessageParam[] = [
        ...retryMessages,
        { role: 'assistant' as const, content: contentBlocks },
        { role: 'user' as const, content: toolResults },
      ];

      const followUp = this.client.messages.stream({
        model: this.model,
        max_tokens: 4096,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: followUpMessages,
        tools: getToolDefinitions(ctx.inputMode, caps, ctx.supplementMode),
      });

      followUp.on('abort', (err) => aiLogger.warn({ err }, 'Retry follow-up stream aborted'));
      followUp.on('error', (err) => aiLogger.warn({ err }, 'Retry follow-up stream error'));

      for await (const event of followUp) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          writer.appendText(event.delta.text);
          await writer.flush(false);
        }
      }
    }

    // Return null to let the normal finalization path handle it
    return null;
  }
}
