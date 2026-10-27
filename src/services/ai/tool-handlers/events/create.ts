// create_event: secretary access and timestamp validation, the past-event gate, then the write and
// its side effects (group notifications, Google push, background location verification).
import { t } from '../../../../config/constants.ts';
import { eventTimestampError } from '../../../../utils/event-timestamps.ts';
import { logger } from '../../../../utils/logger.ts';
import type { AgentContext, ToolResult } from '../../types.ts';
import { checkSecretaryAccess } from '../secretary-access.ts';
import { resolveScope } from '../shared.ts';
import { enqueueGroupNotifications } from './group-notifications.ts';
import { eventToSummary, locationParts, recordChangedDay, timeParts } from './presentation.ts';
import type { CreateEventInput } from './types.ts';

export async function handleCreateEvent(ctx: AgentContext, input: CreateEventInput): Promise<ToolResult> {
  const access = checkSecretaryAccess(
    ctx.user.telegram_id,
    input.owner_id,
    ctx.secretary?.secretaryRepo ?? null,
    'write',
  );
  if (!access.ok) return { success: false, mutationState: 'not_applied', error: access.error };
  const userId = access.effectiveUserId;
  const timestampError = eventTimestampError(input);
  if (timestampError) return { success: false, mutationState: 'not_applied', error: timestampError };
  // Block creation of events in the past — force the agent to confirm with the user first
  if (!input.all_day && !input.force) {
    const eventTime = new Date(input.start_at).getTime();
    const now = Date.now();
    if (eventTime < now) {
      const diffMs = now - eventTime;
      const diffDays = Math.floor(diffMs / 86_400_000);
      const diffLabel = diffDays >= 1 ? `${diffDays} day(s) ago` : `${Math.round(diffMs / 60_000)} minutes ago`;
      return {
        success: false,
        mutationState: 'not_applied',
        error:
          `PAST_EVENT: The requested time (${input.start_at}) is ${diffLabel}. ` +
          'You MUST ask the user via ask_user with options like: ' +
          '["Создать в прошлом", "Перенести на <next reasonable date>"] — ' +
          'include a suggestion for the most likely intended date (e.g. same time tomorrow, or same day next month). ' +
          'The user can also reply with free text to specify a different time. ' +
          'If user confirms past event, call create_event again with force: true.',
      };
    }
  }

  return executeCreateEvent(ctx, input, userId);
}

async function executeCreateEvent(ctx: AgentContext, input: CreateEventInput, userId: number): Promise<ToolResult> {
  try {
    const scope = resolveScope(input, ctx);
    if (scope === 'group' && ctx.groupChatId === undefined) {
      return { success: false, mutationState: 'not_applied', error: 'Group context required for group scope' };
    }
    const event = ctx.eventService.createEvent({
      user_id: userId,
      title: input.title,
      start_at: input.start_at,
      end_at: input.end_at,
      description: input.description,
      location: input.location,
      all_day: input.all_day,
      timezone: ctx.user.timezone,
      recurrence_rule: input.recurrence_rule,
      reminder_minutes: input.reminder_minutes,
      ...(scope === 'group' && {
        owner_type: 'group' as const,
        group_id: ctx.groupChatId!,
        created_by: ctx.user.telegram_id,
      }),
    });
    ctx.createdEventIds ??= new Set();
    ctx.createdEventIds.add(event.id);

    const parts = [`id: ${event.id}`, `title: ${event.title}`];
    parts.push(...timeParts(event.start_at, event.end_at, event.all_day === 1, ctx.user.timezone));
    if (event.description) parts.push(`description: ${event.description}`);
    parts.push(...locationParts(event));

    const groupNotificationsQueued = scope === 'group' ? await enqueueGroupNotifications(ctx, event, 'created') : 0;

    if (scope !== 'group' && ctx.google?.schedulePush) {
      try {
        await ctx.google.schedulePush(userId, event.id, 'create');
      } catch (err) {
        logger.error({ err }, 'schedulePush failed');
      }
    }

    // Trigger background location verification if event has a concrete location
    if (event.location && ctx.locationVerification && !input.location_abstract) {
      ctx.locationVerification
        .verifyEventLocation(event, ctx.user)
        .catch((err) => logger.error({ err, eventId: event.id }, 'Background location verification failed'));
    }

    const groupHint =
      scope === 'group'
        ? groupNotificationsQueued > 0
          ? `The group event is saved and ${groupNotificationsQueued} member notification(s) have been queued for delivery. Do NOT call create_event again for this event.`
          : 'The group event is saved but no member notifications were queued (no registered members or broadcast queue unavailable). Do NOT call create_event again for this event.'
        : undefined;

    recordChangedDay(ctx, event);
    return {
      success: true,
      output: t(ctx.user.language).aiTools.events.eventCreated(parts.join(', ')),
      data: eventToSummary(event, ctx.user.timezone),
      agentHint: groupHint,
    };
  } catch (error) {
    return { success: false, error: `Failed to create event: ${String(error)}` };
  }
}
