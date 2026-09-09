import { t } from '../../../config/constants.ts';
import { cmdLogger } from '../../../utils/logger.ts';
import { collapseToOneLine } from '../../../utils/text.ts';
import { MEMORY_FACT_MAX_CHARS } from '../prompt-sections.ts';
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

export function handleRememberUserFact(ctx: AgentContext, input: RememberUserFactInput): ToolResult {
  // These refusals reach the user verbatim when a learned intent replays this
  // step, so they are written for a person and go through t(lang) like every
  // other string the bot can say.
  const msg = t(ctx.user.language).aiTools.memory;
  if (!ctx.birthday?.userMemoryRepo) {
    return { success: false, error: msg.storageUnavailable };
  }

  // Collapsed to a single line, not merely trimmed — see collapseToOneLine for
  // what a fact carrying its own newlines would do to the prompt.
  const content = collapseToOneLine(input.content);
  if (content.length === 0) {
    return { success: false, error: msg.empty };
  }
  if (content.length > MEMORY_FACT_MAX_CHARS) {
    return { success: false, error: msg.tooLong(content.length, MEMORY_FACT_MAX_CHARS) };
  }

  if (input.type === 'append') {
    ctx.birthday.userMemoryRepo.append(ctx.user.telegram_id, content);
  } else {
    ctx.birthday.userMemoryRepo.rewrite(ctx.user.telegram_id, content);
  }

  return { success: true, output: msg.saved };
}

// These refusals reach the user verbatim when a learned intent replays this
// step, so they are written for a person and go through t(lang) like every
// other string the bot can say.
export async function handleSetReaction(
  ctx: AgentContext,
  input: { message_id?: number; emoji: string },
): Promise<ToolResult> {
  const msg = t(ctx.user.language).aiTools.reaction;
  if (!ctx.sender?.setReaction) {
    cmdLogger.warn({ chatId: ctx.chatId, hasSender: !!ctx.sender }, 'set_reaction: sender.setReaction unavailable');
    return { success: false, error: msg.notAvailable };
  }
  // Strip variation selectors (U+FE0E, U+FE0F) — AI models often add them but Telegram rejects them
  const emoji = input.emoji.replace(/[\uFE0E\uFE0F]/g, '');
  if (!TELEGRAM_REACTION_EMOJIS.has(emoji)) {
    return {
      success: false,
      error: msg.emojiNotSupported(input.emoji),
    };
  }
  const messageId = input.message_id ?? ctx.incomingMessageId;
  if (!messageId) {
    return { success: false, error: msg.noMessageTarget };
  }
  const chatId = ctx.groupChatId ?? ctx.chatId;
  try {
    await ctx.sender.setReaction(chatId, messageId, emoji);
    return { success: true, output: '' };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message || err.constructor.name : String(err);
    cmdLogger.error({ err, chatId, messageId, emoji }, 'set_reaction failed');
    return { success: false, error: errMsg || 'Unknown reaction error' };
  }
}
