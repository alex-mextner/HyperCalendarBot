import type { InlineKeyboard } from 'gramio';

export interface DeliverMessageParams {
  targetId: number;
  targetUsername?: string;
  text: string;
  keyboard?: InlineKeyboard;
  fallbackRecipientId: number;
  fallbackText: string;
  botSend: (recipientId: number, text: string, keyboard?: InlineKeyboard) => Promise<{ message_id: number }>;
  mtprotoSend?: (userId: number, text: string, username?: string) => Promise<boolean>;
}

export async function deliverMessage(
  params: DeliverMessageParams,
): Promise<{ delivered: boolean; messageId?: number }> {
  const { targetId, targetUsername, text, keyboard, fallbackRecipientId, fallbackText, botSend, mtprotoSend } = params;

  // 1. Bot API
  try {
    const msg = await botSend(targetId, text, keyboard);
    return { delivered: true, messageId: msg.message_id };
  } catch {
    // continue to fallback
  }

  // 2. MTProto
  if (mtprotoSend) {
    try {
      const ok = await mtprotoSend(targetId, text, targetUsername);
      if (ok) return { delivered: true };
    } catch {
      // continue to fallback
    }
  }

  // 3. Deep link fallback to initiator
  try {
    await botSend(fallbackRecipientId, fallbackText);
  } catch {
    // silent
  }
  return { delivered: false };
}
