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

export async function handleSetReaction(
  ctx: AgentContext,
  input: { message_id?: number; emoji: string },
): Promise<ToolResult> {
  if (!ctx.sender?.setReaction) {
    return { success: false, error: 'Reactions not available' };
  }
  const messageId = input.message_id ?? ctx.incomingMessageId;
  if (!messageId) {
    return { success: false, error: 'No message_id provided and no incoming message to react to' };
  }
  const chatId = ctx.groupChatId ?? ctx.chatId;
  try {
    await ctx.sender.setReaction(chatId, messageId, input.emoji);
    return { success: true, output: '' };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    cmdLogger.error({ err, chatId, messageId }, 'set_reaction failed');
    return { success: false, error: msg };
  }
}
