import type Anthropic from '@anthropic-ai/sdk';
import type { ChatHistoryMessage } from '../../database/types.ts';
import { logger } from '../../utils/logger.ts';
import { type ActivityEvent, formatActivityEvent } from './activity-event.ts';
import { createAnthropicClient } from './anthropic-client.ts';
import { buildSystemPrompt } from './system-prompt.ts';
import { TelegramStreamWriter } from './telegram-stream.ts';
import { executeTool } from './tool-executor.ts';
import { toolDefinitions } from './tools.ts';
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
}

export class CalendarBotAgent {
  private client: Anthropic;
  private model: string;
  private sender: TelegramSender;

  constructor(config: AgentConfig, sender: TelegramSender) {
    this.client = createAnthropicClient({ apiKey: config.apiKey, baseURL: config.baseUrl });
    this.model = config.model;
    this.sender = sender;
  }

  getSender(): TelegramSender {
    return this.sender;
  }

  buildMessages(ctx: AgentContext, history: ChatHistoryMessage[]): { systemPrompt: string; messages: MessageParam[] } {
    const systemPrompt = buildSystemPrompt(ctx);

    const relevantHistory =
      ctx.isGroup && ctx.groupChatId ? ctx.chatHistory.getRecentByChat(ctx.groupChatId, 10) : history;

    const messages: MessageParam[] = [];

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
      messages.push({ role, content } as MessageParam);
    }

    const nowUtc = new Date().toISOString().slice(0, 19).replace('T', ' ');
    messages.push({ role: 'user', content: `[${nowUtc}] ${ctx.messageText}` });

    return { systemPrompt, messages };
  }

  saveUserMessage(ctx: AgentContext): void {
    const chatId = ctx.isGroup ? ctx.groupChatId : undefined;
    ctx.chatHistory.save(ctx.user.telegram_id, 'user', ctx.messageText, chatId);
  }

  saveAssistantTurn(ctx: AgentContext, contentBlocks: Anthropic.ContentBlockParam[]): void {
    const chatId = ctx.isGroup ? ctx.groupChatId : undefined;
    ctx.chatHistory.save(ctx.user.telegram_id, 'assistant', JSON.stringify(contentBlocks), chatId);
  }

  saveToolResults(ctx: AgentContext, toolResults: Anthropic.ToolResultBlockParam[]): void {
    const chatId = ctx.isGroup ? ctx.groupChatId : undefined;
    ctx.chatHistory.save(ctx.user.telegram_id, 'tool', JSON.stringify(toolResults), chatId);
  }

  async run(ctx: AgentContext): Promise<AgentRunResult> {
    const history = ctx.chatHistory.getRecent(ctx.user.telegram_id);
    const { systemPrompt, messages } = this.buildMessages(ctx, history);

    ctx.sender = this.sender;
    const writer = new TelegramStreamWriter(this.sender, ctx.chatId, ctx.user.language);
    await writer.init();

    this.saveUserMessage(ctx);

    const startTime = Date.now();
    const allToolCalls: AgentToolCallRecord[] = [];
    const allToolResults: AgentToolResultRecord[] = [];

    try {
      let currentMessages = [...messages];

      for (let round = 0; round < MAX_ROUNDS; round++) {
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
            tools: toolDefinitions,
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

            aiLogger.info({ tool: block.name, input: block.input, userId: ctx.user.telegram_id }, 'Tool call');

            writer.setToolLabel(block.name, block.input as Record<string, unknown>);
            await writer.flush(true);

            const result = await executeTool(ctx, block.name, block.input as Record<string, unknown>);

            writer.markToolResult(result.success);
            aiLogger.info({ tool: block.name, success: result.success, userId: ctx.user.telegram_id }, 'Tool result');

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
              if (contentBlocks.length > 0) {
                this.saveAssistantTurn(ctx, contentBlocks);
              }
              this.saveToolResults(ctx, toolResults);
              writer.commitIntermediate();
              await writer.finalize();
              return { responseText: writer.getText(), toolCalls: allToolCalls, toolResults: allToolResults };
            }
          }
        }

        writer.clearToolLabel();

        if (contentBlocks.length > 0) {
          this.saveAssistantTurn(ctx, contentBlocks);
        }

        if (!hasToolUse || toolResults.length === 0) {
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
      const errStr = String(error);
      aiLogger.error({ error: errStr, userId: ctx.user.telegram_id }, 'Agent error');

      const lang = ctx.user.language;
      const errorMsg =
        lang === 'ru'
          ? '\n\n⚠️ Произошла ошибка при обработке запроса.'
          : '\n\n⚠️ An error occurred while processing your request.';
      writer.appendText(errorMsg);
    }

    const finalText = writer.getText().trim();
    if (ctx.isGroup && finalText === '[SKIP]') {
      await writer.discard();
      return { responseText: '', toolCalls: allToolCalls, toolResults: allToolResults };
    }

    await writer.finalize();

    const msgId = writer.getMessageId();
    if (ctx.onBotResponse && msgId !== null) {
      ctx.onBotResponse(msgId);
    }

    return { responseText: writer.getText(), toolCalls: allToolCalls, toolResults: allToolResults };
  }
}
