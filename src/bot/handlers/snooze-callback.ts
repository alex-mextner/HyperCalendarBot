// src/bot/handlers/snooze-callback.ts
// Handles "snooze:5:{eventId}" callback — reschedules a reminder for now + N minutes.

import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { EventReminderRepository } from '../../database/repositories/event-reminder.repository.ts';
import type { BotCallbackContext } from '../types.ts';

export async function handleSnoozeCallback(
  ctx: BotCallbackContext,
  userId: number,
  eventId: number,
  minutes: number,
  reminderRepo: Pick<EventReminderRepository, 'insert' | 'getLastSentForEvent'>,
  eventRepo: Pick<EventRepository, 'findById'>,
  now: Date = new Date(),
): Promise<void> {
  const event = eventRepo.findById(eventId, userId);

  if (!event) {
    await ctx.answer({ text: 'Event not found' });
    return;
  }

  if (event.user_id !== userId) {
    await ctx.answer({ text: 'Not authorized' });
    return;
  }

  const remindAt = new Date(now.getTime() + minutes * 60_000);
  const label = minutes < 60 ? `${minutes} min` : `${minutes / 60}h`;

  // Carry over occurrence times from the original reminder so getDue
  // displays the correct occurrence time (not the recurring template time).
  const lastSent = reminderRepo.getLastSentForEvent(eventId, userId);

  reminderRepo.insert({
    event_id: eventId,
    user_id: userId,
    remind_at_utc: remindAt.toISOString(),
    interval_minutes: minutes,
    interval_label: label,
    occurrence_start: lastSent?.occurrence_start ?? undefined,
    occurrence_end: lastSent?.occurrence_end ?? undefined,
  });

  await ctx.answer({ text: '⏰' });
  await ctx.editText(ctx.message?.text ?? '', { reply_markup: undefined }).catch(() => {});
}
