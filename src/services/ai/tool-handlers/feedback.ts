import { t } from '../../../config/constants.ts';
import type { FeedbackType } from '../../../database/types.ts';
import { cmdLogger } from '../../../utils/logger.ts';
import type { AgentContext, ToolResult } from '../types.ts';

interface SendFeedbackInput {
  type: FeedbackType;
  message: string;
}

export function handleSendFeedback(ctx: AgentContext, input: SendFeedbackInput): ToolResult {
  if (!ctx.botAdminId) {
    return { success: false, error: 'Feedback system is not configured (no admin ID).' };
  }

  if (!ctx.feedbackRepo) {
    return { success: false, error: 'Feedback system is not available.' };
  }

  const openCount = ctx.feedbackRepo.countOpenThreads(ctx.user.telegram_id);
  if (openCount >= 3) {
    return {
      success: false,
      error: 'Maximum 3 open feedback threads. Please wait for previous threads to be resolved.',
    };
  }

  const subject = input.message.slice(0, 50) + (input.message.length > 50 ? '...' : '');
  const threadId = ctx.feedbackRepo.createThread({
    user_id: ctx.user.telegram_id,
    type: input.type,
    subject,
  });

  ctx.feedbackRepo.addMessage({
    thread_id: threadId,
    sender: 'user',
    text: input.message,
  });

  if (ctx.sendMessageToChat) {
    const username = ctx.user.username
      ? `@${ctx.user.username}`
      : (ctx.user.first_name ?? `ID:${ctx.user.telegram_id}`);
    const typeEmoji = { bug: '🐛', feature: '💡', question: '❓', other: '💬' }[input.type] ?? '💬';
    const text = `${typeEmoji} Feedback #${threadId} (${input.type}) от ${username}\n\n«${input.message}»`;

    ctx
      .sendMessageToChat(ctx.botAdminId, text, {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '↩️ Reply', callback_data: `fb_reply:${threadId}` },
              { text: '✅ Close', callback_data: `fb_close:${threadId}` },
            ],
          ],
        },
      })
      .catch((err: unknown) => {
        cmdLogger.error({ err: err }, 'Failed to send feedback notification to admin');
      });
  }

  return { success: true, output: t(ctx.user.language).aiTools.feedback.feedbackSent };
}
