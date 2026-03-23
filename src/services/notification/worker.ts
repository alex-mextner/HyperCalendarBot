import type { NotificationLogRepository } from '../../database/repositories/notification-log.repository.ts';
import { notifyLogger } from '../../utils/logger.ts';

export function parseTelegramError(err: unknown): { code: number; retryAfter?: number } | null {
  if (typeof err !== 'object' || err === null) return null;
  const obj = err as { code?: unknown; payload?: unknown };
  if (typeof obj.code !== 'number') return null;
  const payload = obj.payload;
  const retryAfter =
    typeof payload === 'object' && payload !== null ? (payload as { retry_after?: number }).retry_after : undefined;
  return { code: obj.code, retryAfter };
}

export interface NotificationJobData {
  logId: number;
  telegramId: number;
  type: string;
  payload: string;
}

export interface ReminderKeyboard {
  inline_keyboard: { text: string; callback_data: string }[][];
}

export async function processNotification(
  data: NotificationJobData,
  logRepo: NotificationLogRepository,
  sendMessage: (telegramId: number, text: string) => Promise<void>,
  sendWithKeyboard?: (telegramId: number, text: string, keyboard: ReminderKeyboard) => Promise<void>,
): Promise<void> {
  const log = logRepo.getById(data.logId);
  if (!log || log.status === 'sent') return;

  try {
    const text = log.payload ?? 'Notification';

    if (sendWithKeyboard && (data.type === 'event_reminder' || data.type === 'event_reminder_batch')) {
      const parsed = JSON.parse(text) as { event_id?: number };
      const eventId = parsed.event_id;
      if (eventId !== undefined) {
        const keyboard: ReminderKeyboard = {
          inline_keyboard: [[{ text: '⏰ +5 мин', callback_data: `snooze:5:${eventId}` }]],
        };
        await sendWithKeyboard(data.telegramId, text, keyboard);
        logRepo.markSent(data.logId);
        notifyLogger.info({ logId: data.logId, type: data.type }, 'Notification sent');
        return;
      }
    }

    await sendMessage(data.telegramId, text);
    logRepo.markSent(data.logId);
    notifyLogger.info({ logId: data.logId, type: data.type }, 'Notification sent');
  } catch (err) {
    notifyLogger.error({ logId: data.logId, err: err }, 'Notification delivery failed');
    throw err;
  }
}
