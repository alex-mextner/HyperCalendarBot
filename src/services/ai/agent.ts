import type Anthropic from '@anthropic-ai/sdk';
import type { ChatHistoryMessage } from '../../database/types.ts';
import { logger } from '../../utils/logger.ts';
import { type ActivityEvent, formatActivityEvent } from './activity-event.ts';
import { createAnthropicClient } from './anthropic-client.ts';
import type { AiDebugLogger, AiDebugRunContext } from './debug-logger.ts';
import { buildSystemPrompt } from './system-prompt.ts';
import { TelegramStreamWriter } from './telegram-stream.ts';
import { executeTool } from './tool-executor.ts';
import { getToolDefinitions, type UserCapabilities } from './tools.ts';
import type { AgentConfig, AgentContext, TelegramSender } from './types.ts';

const aiLogger = logger.child({ module: 'ai-agent' });

const MAX_ROUNDS = 15;
const TIMEOUT_MS = 90_000;
const MAX_API_RETRIES = 2;
const RETRY_DELAY_MS = 1500;

interface MessageParam {
  role: 'user' | 'assistant';
  content: string | Anthropic.ContentBlockParam[];
}

function withTimestamp(text: string, createdAt: string): string {
  const ts = createdAt.slice(0, 19);
  return `[${ts}] ${text}`;
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
  input: Record<string, unknown>;
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
  private model: string;
  private sender: TelegramSender;
  private debugLogger?: AiDebugLogger;

  constructor(config: AgentConfig, sender: TelegramSender) {
    this.client = createAnthropicClient({ apiKey: config.apiKey, baseURL: config.baseUrl });
    this.model = config.model;
    this.sender = sender;
    this.debugLogger = config.debugLogger;
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
      ctx.isGroup && ctx.groupChatId ? ctx.chatHistory.getRecentByChat(ctx.groupChatId, 30) : history;

    const messages: MessageParam[] = [];
    const senderCache = new Map<number, string>();

    for (const msg of relevantHistory) {
      let content: string | Anthropic.ContentBlockParam[];
      try {
        const parsed = JSON.parse(msg.content);
        if (Array.isArray(parsed)) {
          content = parsed as Anthropic.ContentBlockParam[];
        } else if (parsed !== null && typeof parsed === 'object' && typeof parsed.kind === 'string') {
          content = withTimestamp(formatActivityEvent(parsed as ActivityEvent), msg.created_at);
        } else {
          content = withTimestamp(msg.content, msg.created_at);
        }
      } catch {
        content = withTimestamp(msg.content, msg.created_at);
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

    const caps: UserCapabilities = {
      assistantEnabled: Boolean(ctx.user.assistant_enabled),
      agentConnected: ctx.agentRegistry?.isConnected(ctx.user.telegram_id) ?? false,
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
    ctx.onAgentChunk = (text: string) => {
      writer.appendText(text);
      writer.tailText(3500);
      writer.flush(false).catch((err) => aiLogger.warn({ err }, 'agent chunk flush failed'));
    };

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

        const streamRequest = () =>
          this.client.messages.stream({
            model: this.model,
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

        let stream: ReturnType<typeof streamRequest>;
        let lastError: unknown;
        for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
          try {
            stream = streamRequest();
            for await (const event of stream) {
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
            lastError = undefined;
            break;
          } catch (err) {
            lastError = err;
            const isRetryable = String(err).includes('Network') || String(err).includes('overloaded');
            if (!isRetryable || attempt >= MAX_API_RETRIES) break;
            aiLogger.warn(
              { attempt: attempt + 1, err: err, userId: ctx.user.telegram_id },
              'API call failed, retrying',
            );
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
          }
        }
        if (lastError) throw lastError;

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
            dbg?.logToolCall(block.name, block.input as Record<string, unknown>);

            writer.setToolLabel(block.name, block.input as Record<string, unknown>);
            await writer.flush(true);

            const result = await executeTool(ctx, block.name, block.input as Record<string, unknown>);

            writer.markToolResult(result.success);
            aiLogger.info(
              { tool: block.name, success: result.success, userId: ctx.user.telegram_id, chatId: ctx.chatId },
              'Tool result',
            );
            dbg?.logToolResult(block.name, result.success, result.output, result.error);

            allToolCalls.push({ name: block.name, input: block.input as Record<string, unknown> });
            allToolResults.push({ success: result.success, output: result.output });

            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: result.success
                ? `${result.output ?? 'OK'}${result.agentHint ? `\n[AGENT: ${result.agentHint}]` : ''}`
                : `Error: ${result.error}`,
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

        writer.commitIntermediate();
        this.saveToolResults(ctx, toolResults);

        currentMessages = [
          ...currentMessages,
          { role: 'assistant' as const, content: contentBlocks },
          { role: 'user' as const, content: toolResults },
        ];
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

    if (ctx.isGroup && finalText === '[SKIP]') {
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
}
