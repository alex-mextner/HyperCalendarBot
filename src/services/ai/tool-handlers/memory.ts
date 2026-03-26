import { cmdLogger } from '../../../utils/logger.ts';
import type { AgentContext, ToolResult } from '../types.ts';

interface RememberUserFactInput {
  type: 'append' | 'rewrite';
  content: string;
}

export function handleRememberUserFact(ctx: AgentContext, input: RememberUserFactInput): ToolResult {
  if (!ctx.birthday?.userMemoryRepo) {
    return { success: false, error: 'Memory storage not available' };
  }

  if (input.type === 'append') {
    ctx.birthday.userMemoryRepo.append(ctx.user.telegram_id, input.content);
  } else {
    ctx.birthday.userMemoryRepo.rewrite(ctx.user.telegram_id, input.content);
  }

  return { success: true, output: 'fact saved' };
}

export function handleSetReaction(ctx: AgentContext, input: { message_id: number; emoji: string }): ToolResult {
  if (!ctx.sender?.setReaction) {
    return { success: false, error: 'Reactions not available' };
  }
  const chatId = ctx.groupChatId ?? ctx.chatId;
  ctx.sender
    .setReaction(chatId, input.message_id, input.emoji)
    .catch((err: unknown) => cmdLogger.error({ err, chatId, messageId: input.message_id }, 'set_reaction failed'));
  return { success: true, output: '' };
}
