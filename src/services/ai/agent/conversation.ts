// Builds the model's view of a conversation from chat_history rows: parsed messages, tool results
// condensed by the summarizer, group speakers tagged, and a retry's question restored.
import type { ChatHistoryMessage } from '../../../database/types.ts';
import type { HistorySummarizer } from '../history-summarizer.ts';
import type { aiStreamRound } from '../streaming.ts';
import type { AgentContext } from '../types.ts';
import { parseHistoryRow, tagSender } from './history-rows.ts';
import { isToolMessage, type MessageParam } from './message-sanitizer.ts';

/** In a group the conversation is the group's own, whoever sent each row. */
export function relevantHistoryRows(
  ctx: AgentContext,
  history: ChatHistoryMessage[],
  limit: number,
): ChatHistoryMessage[] {
  return ctx.isGroup && ctx.groupChatId ? ctx.chatHistory.getRecentByChat(ctx.groupChatId, limit) : history;
}

async function condenseToolResult(
  summarizer: HistorySummarizer | undefined,
  rowId: number,
  msg: MessageParam,
  measuredStream: typeof aiStreamRound | undefined,
  signal: AbortSignal | undefined,
): Promise<MessageParam> {
  if (!summarizer || !isToolMessage(msg) || typeof msg.content !== 'string') return msg;
  const condensed = await summarizer.condenseMessage(rowId, msg.tool_call_id, msg.content, measuredStream, signal);
  return condensed === msg.content ? msg : { ...msg, content: condensed };
}

/**
 * For group chats: plain-text user messages carry the sender's name and id so the model can
 * distinguish speakers. Names are looked up once per sender.
 */
function tagGroupSpeaker(
  ctx: AgentContext,
  row: ChatHistoryMessage,
  msg: MessageParam,
  senderCache: Map<number, string>,
): MessageParam {
  if (!ctx.isGroup || !ctx.groupChatId || msg.role !== 'user' || typeof msg.content !== 'string') return msg;
  if (!senderCache.has(row.user_id)) {
    const u = ctx.userRepo.findByTelegramId(row.user_id);
    senderCache.set(row.user_id, u?.first_name ?? u?.username ?? 'User');
  }
  const name = senderCache.get(row.user_id)!;
  return { role: 'user', content: tagSender(msg.content, name, row.user_id) };
}

export interface HistoryBuildOptions {
  summarizer?: HistorySummarizer;
  measuredStream?: typeof aiStreamRound;
  signal?: AbortSignal;
}

/** Every stored row as model messages, in stored order. */
export async function buildHistoryMessages(
  ctx: AgentContext,
  rows: ChatHistoryMessage[],
  opts: HistoryBuildOptions,
): Promise<MessageParam[]> {
  const messages: MessageParam[] = [];
  const senderCache = new Map<number, string>();
  for (const row of rows) {
    opts.signal?.throwIfAborted();
    for (const parsed of parseHistoryRow(row, ctx.user.timezone)) {
      const msg = await condenseToolResult(opts.summarizer, row.id, parsed, opts.measuredStream, opts.signal);
      messages.push(tagGroupSpeaker(ctx, row, msg, senderCache));
    }
  }
  return messages;
}

/**
 * A backoff retry re-runs the original message, but nothing re-saves it to
 * chat_history — the newest stored turn is the bot's own "one sec". Without
 * this the model is asked to continue from its own stall phrase and has no
 * idea which question it still owes an answer to.
 * `stored` is the newest-last list as saved, before regrouping moved anything to the end.
 */
export function withRetryQuestion(ctx: AgentContext, stored: MessageParam[], ordered: MessageParam[]): MessageParam[] {
  if ((ctx.retryAttempt ?? 0) === 0 || ctx.messageText.trim().length === 0) return ordered;
  const last = stored[stored.length - 1];
  const alreadyAsked =
    last?.role === 'user' && typeof last.content === 'string' && last.content.includes(ctx.messageText);
  if (alreadyAsked) return ordered;
  return [...ordered, { role: 'user', content: ctx.messageText }];
}

/**
 * A supplement reviews the answer the rule system has just sent, and that answer is the newest
 * stored turn: the conversation ends on an assistant message. Claude 5.5 refuses such a request
 * ("does not support assistant message prefill", HTTP 400); with z.ai and Hugging Face out it
 * failed the whole chain (#895). The review instruction lives in the system prompt, so this turn
 * only asks the model to carry it out; it names no tool, so a renamed tool cannot make it stale.
 * A conversation that already ends on a user message (a group's newest row, a normal turn) is kept.
 */
export function withSupplementTurn(ctx: AgentContext, messages: MessageParam[]): MessageParam[] {
  if (!ctx.supplementMode || messages.at(-1)?.role !== 'assistant') return messages;
  return [
    ...messages,
    {
      role: 'user',
      content: 'Review the auto-response above as the Supplement Mode instructions say.',
    },
  ];
}
