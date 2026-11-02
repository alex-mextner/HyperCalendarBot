// create_event: secretary access and timestamp validation, the past-event gate, then the write and
// its side effects (group notifications, Google push, background location verification).
import { t } from '../../../../config/constants.ts';
import type { CalendarEvent } from '../../../../database/types.ts';
import { eventTimestampError } from '../../../../utils/event-timestamps.ts';
import { logger } from '../../../../utils/logger.ts';
import type { AgentContext, ToolResult } from '../../types.ts';
import { checkSecretaryAccess } from '../secretary-access.ts';
import { resolveScope, type Scope } from '../shared.ts';
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

/** The receipt for a create that found its event already saved: the same event, reported as created once. */
function alreadyExistsReceipt(ctx: AgentContext, event: CalendarEvent): ToolResult {
  const parts = [`id: ${event.id}`, `title: ${event.title}`];
  parts.push(...timeParts(event.start_at, event.end_at, event.all_day === 1, ctx.user.timezone));
  if (event.description) parts.push(`description: ${event.description}`);
  parts.push(...locationParts(event));
  recordChangedDay(ctx, event);
  return {
    success: true,
    // The call succeeded and the event exists, but this run wrote nothing: an interrupted run must not
    // report a creation or hold back its retry on account of it.
    mutationState: 'not_applied',
    alreadyExists: { entity: 'event', id: event.id },
    output: t(ctx.user.language).aiTools.events.eventAlreadyExists(parts.join(', ')),
    data: eventToSummary(event, ctx.user.timezone),
    agentHint:
      'This event was already saved moments ago (same title, start and end); nothing new was created. ' +
      'Do NOT call create_event again for it: tell the user it is in the calendar, once. ' +
      'Only if the user explicitly asked for a second identical event, call create_event again with allow_duplicate: true.',
  };
}

/** Same title on the same day as an event that is not this request's repeat: nothing was written, the model must choose. */
function sameDayConflict(ctx: AgentContext, event: CalendarEvent): ToolResult {
  const when = timeParts(event.start_at, event.end_at, event.all_day === 1, ctx.user.timezone).join(', ');
  return {
    success: false,
    mutationState: 'not_applied',
    // Written for the person: a workflow that cannot choose shows it as it is.
    error: t(ctx.user.language).aiTools.events.eventSameDay(event.title, event.id, when),
    agentHint:
      'SAME_DAY_EVENT: to move or change that event call update_event with its id (do not create a new event ' +
      'and leave the old one). If the user really wants a second event with this title that day, ask them, and ' +
      'on a clear yes call create_event again with allow_duplicate: true.',
  };
}

function groupSavedHint(notificationsQueued: number): string {
  return notificationsQueued > 0
    ? `The group event is saved and ${notificationsQueued} member notification(s) have been queued for delivery. Do NOT call create_event again for this event.`
    : 'The group event is saved but no member notifications were queued (no registered members or broadcast queue unavailable). Do NOT call create_event again for this event.';
}

/** Calendar push and background location check of a created event; neither may fail the create. */
async function afterCreateEffects(
  ctx: AgentContext,
  input: CreateEventInput,
  event: CalendarEvent,
  scope: Scope,
  userId: number,
): Promise<void> {
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
}

async function executeCreateEvent(ctx: AgentContext, input: CreateEventInput, userId: number): Promise<ToolResult> {
  try {
    const scope = resolveScope(input, ctx);
    if (scope === 'group' && ctx.groupChatId === undefined) {
      return { success: false, mutationState: 'not_applied', error: 'Group context required for group scope' };
    }
    const data = {
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
    };
    // A repeat of a request saved moments ago (a second run of the same chat, a retry after a lost reply)
    // is answered with the saved event; only the model's explicit allow_duplicate makes a second copy.
    const { event, outcome } = input.allow_duplicate
      ? { event: ctx.eventService.createEvent(data), outcome: 'created' as const }
      : ctx.eventService.createEventIfNew(data);
    if (outcome === 'duplicate') return alreadyExistsReceipt(ctx, event);
    if (outcome === 'same_day') return sameDayConflict(ctx, event);
    ctx.createdEventIds ??= new Set();
    ctx.createdEventIds.add(event.id);
    const parts = [`id: ${event.id}`, `title: ${event.title}`];
    parts.push(...timeParts(event.start_at, event.end_at, event.all_day === 1, ctx.user.timezone));
    if (event.description) parts.push(`description: ${event.description}`);
    parts.push(...locationParts(event));

    const groupNotificationsQueued = scope === 'group' ? await enqueueGroupNotifications(ctx, event, 'created') : 0;

    await afterCreateEffects(ctx, input, event, scope, userId);

    const groupHint = scope === 'group' ? groupSavedHint(groupNotificationsQueued) : undefined;

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
