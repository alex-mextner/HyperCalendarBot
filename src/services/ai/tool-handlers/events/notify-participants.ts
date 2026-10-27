// notify_participants: broadcasts the organizer's message to accepted participants, each in their
// own language. Reports only what was queued, never that anyone received it.
import { t } from '../../../../config/constants.ts';
import type { AgentContext, ToolResult } from '../../types.ts';
import { eventsLogger, type NotifyParticipantsInput } from './types.ts';

export async function handleNotifyParticipants(ctx: AgentContext, input: NotifyParticipantsInput): Promise<ToolResult> {
  const event = ctx.eventService.getEvent(input.event_id, ctx.user.telegram_id);
  if (!event) {
    return { success: false, error: `Event ${input.event_id} not found or not owned by you.` };
  }

  if (!ctx.participantRepo) {
    return { success: false, error: 'Participants feature is not configured.' };
  }

  if (!ctx.broadcast) {
    return { success: false, error: 'Broadcast queue is not configured; cannot notify participants.' };
  }

  const accepted = ctx.participantRepo
    .getByEvent(input.event_id)
    .filter((p) => p.status === 'accepted' && p.user_id !== ctx.user.telegram_id);

  if (accepted.length === 0) {
    return { success: false, error: 'This event has no accepted participants to notify.' };
  }

  const senderName = ctx.user.first_name ?? ctx.user.username ?? `User ${ctx.user.telegram_id}`;
  // Per-recipient localization: each recipient gets the notification in their own language
  const jobs = accepted.map((p) => {
    const recipientUser = ctx.userRepo.findByTelegramId(p.user_id);
    const recipientLang = (recipientUser?.language ?? 'en') as 'en' | 'ru';
    const text = t(recipientLang).aiTools.events.participantUpdate(event.title, senderName, input.message);
    return {
      recipientId: p.user_id,
      text,
      origin: `notify_participants:${input.event_id}`,
    };
  });

  try {
    await ctx.broadcast.enqueueBatch(jobs);
  } catch (err) {
    eventsLogger.error(
      { err, eventId: input.event_id, count: jobs.length },
      'Failed to enqueue participant notifications',
    );
    return { success: false, error: 'NOTIFY_PARTICIPANTS_ENQUEUE_FAILED' };
  }

  const output = t(ctx.user.language).aiTools.events.notificationQueued(jobs.length);

  return {
    success: true,
    output,
    agentHint: `${jobs.length} notifications queued for delivery via the broadcast worker. Do NOT call notify_participants again for this event with the same message.`,
  };
}
