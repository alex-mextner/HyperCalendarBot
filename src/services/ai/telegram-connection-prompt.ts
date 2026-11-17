import { InlineKeyboard } from 'gramio';
import { t } from '../../config/constants.ts';
import { logger } from '../../utils/logger.ts';
import type { AgentContext, ToolResult } from './types.ts';

/** The button enters the ordinary login wizard; it never resumes or repeats an invitation write. */
export async function offerTelegramConnection(ctx: AgentContext): Promise<ToolResult> {
  const tr = t(ctx.user.language).connectTelegram;
  const error = tr.lookupNeedsConnection;
  // A picker continuation only reports existing delivery. Even a read must not open a
  // login wizard or stop the explanation while waiting for unrelated user input.
  if (ctx.invitationDeliveryReceipts?.length || !ctx.sender?.sendMessageWithKeyboard) {
    return { success: false, mutationState: 'not_applied', error };
  }
  try {
    await ctx.sender.sendMessageWithKeyboard(
      ctx.user.telegram_id,
      error,
      new InlineKeyboard().text(tr.btnReconnect, 'stg:tg_connect'),
    );
  } catch (err) {
    logger.warn({ err }, 'Could not send the private Telegram reconnect prompt');
    return { success: false, mutationState: 'not_applied', error };
  }
  return {
    success: true,
    mutationState: 'not_applied',
    awaitingInput: { kind: 'chat' },
    stopLoop: true,
    output: error,
    agentHint:
      'The private reconnect button was sent. No recipient lookup or invitation write completed. Wait for the user.',
  };
}
