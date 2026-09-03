import { cmdLogger } from '../../../utils/logger.ts';
import type { AgentContext, ToolResult } from '../types.ts';

const TELEGRAM_REACTION_EMOJIS = new Set([
  '❤',
  '👍',
  '👎',
  '🔥',
  '🥰',
  '👏',
  '😁',
  '🤔',
  '🤯',
  '😱',
  '🤬',
  '😢',
  '🎉',
  '🤩',
  '🤮',
  '💩',
  '🙏',
  '👌',
  '🕊',
  '🤡',
  '🥱',
  '🥴',
  '😍',
  '🐳',
  '❤\u200D🔥',
  '🌚',
  '🌭',
  '💯',
  '🤣',
  '⚡',
  '🍌',
  '🏆',
  '💔',
  '🤨',
  '😐',
  '🍓',
  '🍾',
  '💋',
  '🖕',
  '😈',
  '😴',
  '😭',
  '🤓',
  '👻',
  '👨\u200D💻',
  '👀',
  '🎃',
  '🙈',
  '😇',
  '😨',
  '🤝',
  '✍',
  '🤗',
  '🫡',
  '🎅',
  '🎄',
  '☃',
  '💅',
  '🤪',
  '🗿',
  '🆒',
  '💘',
  '🙉',
  '🦄',
  '😘',
  '💊',
  '🙊',
  '😎',
  '👾',
  '🤷\u200D♂',
  '🤷',
  '🤷\u200D♀',
  '😡',
]);

interface RememberUserFactInput {
  type: 'append' | 'rewrite';
  content: string;
}

/**
 * A fact longer than this is refused rather than stored.
 *
 * The prompt section these are read back into is capped at 2 000 characters,
 * and a fact that alone eats a quarter of it is skipped there — which would
 * leave it in the table permanently invisible, unshowable and unfixable, since
 * the model cannot rewrite what it never sees. Refusing costs the model one
 * round and a shorter sentence; storing costs the user a dead row forever.
 */
const MAX_FACT_CHARS = 500;

export function handleRememberUserFact(ctx: AgentContext, input: RememberUserFactInput): ToolResult {
  if (!ctx.birthday?.userMemoryRepo) {
    return { success: false, error: 'Memory storage not available' };
  }

  const content = input.content.trim();
  if (content.length === 0) {
    return { success: false, error: 'Nothing to remember — the fact is empty.' };
  }
  if (content.length > MAX_FACT_CHARS) {
    return {
      success: false,
      error: `Fact too long (${content.length} characters, limit ${MAX_FACT_CHARS}). Keep the essence in one short sentence, or save it as several separate facts.`,
    };
  }

  if (input.type === 'append') {
    ctx.birthday.userMemoryRepo.append(ctx.user.telegram_id, content);
  } else {
    ctx.birthday.userMemoryRepo.rewrite(ctx.user.telegram_id, content);
  }

  return { success: true, output: 'fact saved' };
}

export async function handleSetReaction(
  ctx: AgentContext,
  input: { message_id?: number; emoji: string },
): Promise<ToolResult> {
  if (!ctx.sender?.setReaction) {
    cmdLogger.warn({ chatId: ctx.chatId, hasSender: !!ctx.sender }, 'set_reaction: sender.setReaction unavailable');
    return { success: false, error: 'Reactions not available' };
  }
  // Strip variation selectors (U+FE0E, U+FE0F) — AI models often add them but Telegram rejects them
  const emoji = input.emoji.replace(/[\uFE0E\uFE0F]/g, '');
  if (!TELEGRAM_REACTION_EMOJIS.has(emoji)) {
    return {
      success: false,
      error: `Emoji "${input.emoji}" is not supported by Telegram reactions. Use one of the allowed emojis from the tool description.`,
    };
  }
  const messageId = input.message_id ?? ctx.incomingMessageId;
  if (!messageId) {
    return { success: false, error: 'No message_id provided and no incoming message to react to' };
  }
  const chatId = ctx.groupChatId ?? ctx.chatId;
  try {
    await ctx.sender.setReaction(chatId, messageId, emoji);
    return { success: true, output: '' };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message || err.constructor.name : String(err);
    cmdLogger.error({ err, chatId, messageId, emoji }, 'set_reaction failed');
    return { success: false, error: msg || 'Unknown reaction error' };
  }
}
