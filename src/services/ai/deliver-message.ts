import { type InlineKeyboard, TelegramError } from 'gramio';
import { botLogger } from '../../utils/logger.ts';

/** Strip any URL from a log string — a delivery error message could embed the invitation
 *  deep-link (`https://t.me/Bot?start=i_...`), and URLs are not useful diagnostics here.
 *  Also strips a scheme-less `t.me/...` token, since an invitation deep-link can appear
 *  without an `https://` prefix. */
export function redactUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, '[link redacted]').replace(/\bt\.me\/\S+/gi, '[link redacted]');
}

/**
 * Build a log-safe view of a delivery error.
 *
 * The fallback `botSend` carries `fallbackText`, which for an invitation is the deep-link
 * URL + event title. A thrown Telegram/API error commonly attaches the full request body
 * (`err.params` / `err.body`) as enumerable own properties; pino's `err` serializer would
 * copy those into the logs, turning log access into a disclosure path. This reads ONLY
 * known scalar fields, never the raw error object, and redacts any URL from the message —
 * sanitized by default for every error type, not just GramIO's `TelegramError`.
 */
export function describeDeliveryError(err: unknown): { name: string; message: string; code?: number } {
  if (err instanceof TelegramError) {
    return { name: err.method, message: redactUrls(err.message), code: err.code };
  }
  if (err instanceof Error) {
    return { name: err.name, message: redactUrls(err.message) };
  }
  return { name: 'NonError', message: 'unknown delivery error' };
}

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
): Promise<{ delivered: boolean; messageId?: number; fallbackSent?: boolean }> {
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
    return { delivered: false, fallbackSent: true };
  } catch (err) {
    botLogger.warn({ err: describeDeliveryError(err) }, 'deep-link fallback delivery failed');
    return { delivered: false, fallbackSent: false };
  }
}
