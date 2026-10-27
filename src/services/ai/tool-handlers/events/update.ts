// update_event and snooze_event: edits to an existing event (own, group or delegated calendar) with
// the Google/participant pushes, location re-verification and the honest write-outcome reporting
// (an unreadable result is `uncertain`, never replayed).
import { t } from '../../../../config/constants.ts';
import { CLEARED_LOCATION, RESOLVED_PLACE_COLUMNS } from '../../../../database/repositories/event.repository.ts';
import type { CalendarEvent, EventParticipant, UpdateEventData } from '../../../../database/types.ts';
import { eventTimestampError } from '../../../../utils/event-timestamps.ts';
import { logger } from '../../../../utils/logger.ts';
import type { AgentContext, ToolResult } from '../../types.ts';
import { checkSecretaryAccess } from '../secretary-access.ts';
import { resolveScope } from '../shared.ts';
import { pushEventToUsers } from './google-push.ts';
import { enqueueGroupNotifications } from './group-notifications.ts';
import { eventToSummary, locationParts, recordChangedDay, timeParts } from './presentation.ts';
import { GROUP_CONTEXT_REQUIRED, notApplied } from './results.ts';
import type { Scope, SnoozeEventInput, UpdateEventInput } from './types.ts';

/** The event as the caller may write it: the group's event in group scope, else the user's own. */
function findWritableEvent(ctx: AgentContext, scope: Scope, userId: number, eventId: number): CalendarEvent | null {
  return scope === 'group'
    ? ctx.eventService.getEventForGroup(eventId, ctx.groupChatId!)
    : ctx.eventService.getEvent(eventId, userId);
}

function applyEventUpdate(
  ctx: AgentContext,
  scope: Scope,
  userId: number,
  eventId: number,
  updates: UpdateEventData,
): CalendarEvent | null {
  return scope === 'group'
    ? ctx.eventService.updateEventForGroup(eventId, ctx.groupChatId!, updates)
    : ctx.eventService.updateEvent(eventId, userId, updates);
}

/** The columns this call may change: never the confirmed-place ones, and a removed location clears them too. */
function editableFields(input: UpdateEventInput): UpdateEventData {
  const { event_id: _eventId, scope: _scope, owner_id: _ownerId, ...fields } = input;
  // A confirmed place comes only from the creator's tap or pin through the verification service,
  // never from the model (#620); a new text is reset and asked about below
  for (const column of RESOLVED_PLACE_COLUMNS) Reflect.deleteProperty(fields, column);
  // Removing the location also drops a place a pin set on an event without typed text
  return fields.location === null ? { ...fields, ...CLEARED_LOCATION } : fields;
}

function updatedEventParts(ctx: AgentContext, updated: CalendarEvent): string[] {
  const parts = [`id: ${updated.id}`, `title: ${updated.title}`];
  parts.push(...timeParts(updated.start_at, updated.end_at, updated.all_day === 1, ctx.user.timezone));
  if (updated.description) parts.push(`description: ${updated.description}`);
  parts.push(...locationParts(updated));
  return parts;
}

function acceptedParticipantIds(participants: EventParticipant[], ownerId: number): number[] {
  return participants.filter((p) => p.status === 'accepted' && p.user_id !== ownerId).map((p) => p.user_id);
}

/**
 * Google Calendar pushes for an edited event: the owner's own calendar (personal scope), every
 * accepted participant, and in group scope every active member.
 * Group events are pushed to every active member by default; a declined RSVP ("Not going") is the
 * opt-out, so members who explicitly declined are skipped — otherwise an edit would re-create the
 * event they removed from their calendar. Members with no RSVP row are undecided, not declined, so
 * they still receive it.
 */
async function pushUpdateToGoogle(
  ctx: AgentContext,
  scope: Scope,
  userId: number,
  updated: CalendarEvent,
  participants: EventParticipant[],
): Promise<void> {
  if (scope !== 'group' && ctx.google?.schedulePush) {
    try {
      await ctx.google.schedulePush(userId, updated.id, 'update');
    } catch (err) {
      logger.error({ err }, 'schedulePush failed');
    }
  }
  const push = ctx.google?.scheduleParticipantPush;
  if (!push) return;
  const acceptedIds = acceptedParticipantIds(participants, userId);
  if (acceptedIds.length > 0) {
    await pushEventToUsers(
      push,
      acceptedIds,
      updated.id,
      'update',
      'scheduleParticipantPush failed',
      'participantUserId',
    );
  }
  if (scope === 'group' && ctx.group) {
    const declined = new Set(participants.filter((p) => p.status === 'declined').map((p) => p.user_id));
    const memberIds = ctx.group.groupMemberRepo
      .getActiveMembers(ctx.groupChatId!)
      .filter((m) => m.user_id !== ctx.user.telegram_id && !declined.has(m.user_id))
      .map((m) => m.user_id);
    await pushEventToUsers(push, memberIds, updated.id, 'update', 'scheduleParticipantPush group failed', 'userId');
  }
}

/** Re-render the invitation cards, then (for a new concrete location) verify it in the background. */
async function refreshLocationAfterUpdate(
  ctx: AgentContext,
  input: UpdateEventInput,
  beforeUpdate: CalendarEvent,
  updated: CalendarEvent,
): Promise<void> {
  if (!ctx.locationVerification) return;
  // Before the question below: a place the creator confirms from it re-renders the cards again,
  // and this edit's render must not land after that one
  await ctx.locationVerification.refreshInvitationCards(beforeUpdate, updated);
  if (input.location && !input.location_abstract) {
    ctx.locationVerification
      .verifyEventLocation(updated, ctx.user)
      .catch((err) => logger.error({ err, eventId: updated.id }, 'Background location verification failed'));
  }
}

function groupUpdateHint(notificationsQueued: number): string {
  return notificationsQueued > 0
    ? `The group event is updated and ${notificationsQueued} member notification(s) have been queued for delivery. Do NOT call update_event again with identical arguments.`
    : 'The group event is updated but no member notifications were queued (no registered members or broadcast queue unavailable). Do NOT call update_event again with identical arguments.';
}

export async function handleUpdateEvent(ctx: AgentContext, input: UpdateEventInput): Promise<ToolResult> {
  const access = checkSecretaryAccess(
    ctx.user.telegram_id,
    input.owner_id,
    ctx.secretary?.secretaryRepo ?? null,
    'write',
  );
  if (!access.ok) return notApplied(access.error);
  const userId = access.effectiveUserId;
  const scope = resolveScope(input, ctx);
  const eventId = input.event_id;
  const updates = editableFields(input);
  if (scope === 'group' && ctx.groupChatId === undefined) return notApplied(GROUP_CONTEXT_REQUIRED);
  const beforeUpdate = findWritableEvent(ctx, scope, userId, eventId);
  if (!beforeUpdate) return notApplied(`Event ${eventId} not found or not owned by you.`);
  const timestampError = eventTimestampError(input);
  if (timestampError) return notApplied(timestampError);
  const updated = applyEventUpdate(ctx, scope, userId, eventId, updates);

  if (!updated) {
    return {
      success: false,
      mutationState: 'uncertain',
      error: 'Update was attempted but its result could not be read back. Do not replay automatically.',
    };
  }

  const parts = updatedEventParts(ctx, updated);

  const groupNotificationsQueued = scope === 'group' ? await enqueueGroupNotifications(ctx, updated, 'updated') : 0;
  // Fetch participants once — used for the accepted-push, the declined-skip, and the hint
  const participants = ctx.participantRepo ? ctx.participantRepo.getByEvent(eventId) : [];
  await pushUpdateToGoogle(ctx, scope, userId, updated, participants);

  const acceptedCount = acceptedParticipantIds(participants, userId).length;
  let output = t(ctx.user.language).aiTools.events.eventUpdated(parts.join(', '));
  if (acceptedCount > 0) output += t(ctx.user.language).aiTools.events.participantHint(acceptedCount);

  await refreshLocationAfterUpdate(ctx, input, beforeUpdate, updated);

  recordChangedDay(ctx, beforeUpdate);
  recordChangedDay(ctx, updated);
  return {
    success: true,
    output,
    agentHint: scope === 'group' ? groupUpdateHint(groupNotificationsQueued) : undefined,
    data: eventToSummary(updated, ctx.user.timezone),
  };
}

export function handleSnoozeEvent(ctx: AgentContext, input: SnoozeEventInput): ToolResult {
  const access = checkSecretaryAccess(
    ctx.user.telegram_id,
    input.owner_id,
    ctx.secretary?.secretaryRepo ?? null,
    'write',
  );
  if (!access.ok) return notApplied(access.error);
  const userId = access.effectiveUserId;
  const scope = resolveScope(input, ctx);
  if (scope === 'group' && ctx.groupChatId === undefined) return notApplied(GROUP_CONTEXT_REQUIRED);
  const event = findWritableEvent(ctx, scope, userId, input.event_id);

  if (!event) {
    return { success: false, error: `Event ${input.event_id} not found or not owned by you.` };
  }

  const minutes = input.minutes ?? 10;
  const newStart = new Date(new Date(event.start_at).getTime() + minutes * 60_000).toISOString();
  const updates: UpdateEventData = { start_at: newStart };

  if (event.end_at) {
    updates.end_at = new Date(new Date(event.end_at).getTime() + minutes * 60_000).toISOString();
  }

  const updated = applyEventUpdate(ctx, scope, userId, input.event_id, updates);

  if (!updated) {
    return { success: false, error: 'Failed to snooze event.' };
  }

  recordChangedDay(ctx, event);
  recordChangedDay(ctx, updated);

  // Snoozing shifts the start by minutes, so even an all-day event now has an exact instant.
  const newStartParts = timeParts(updated.start_at, null, false, ctx.user.timezone);

  return {
    success: true,
    output: t(ctx.user.language).aiTools.events.snoozed(updated.title, minutes, newStartParts.join(', ')),
  };
}
