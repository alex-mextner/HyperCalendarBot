// delete_event and the ask_user delete confirmation: the bot, not the model, lists the events and
// owns the buttons; a delete only runs after that confirmation (or for an event this run created).
import { t, toLang } from '../../../../config/constants.ts';
import type { CalendarEvent } from '../../../../database/types.ts';
import { logger } from '../../../../utils/logger.ts';
import {
  consumeDeleteApproval,
  type DeleteTarget,
  deleteConfirmationKeyboard,
  dropDeleteConfirmation,
  isPastEvent,
  issueDeleteConfirmation,
  renderDeleteConfirmation,
} from '../../delete-confirmation.ts';
import type { AgentContext, ToolResult } from '../../types.ts';
import { checkSecretaryAccess } from '../secretary-access.ts';
import { resolveScope } from '../shared.ts';
import { pushEventToUsers } from './google-push.ts';
import { eventToSummary, recordChangedDay } from './presentation.ts';
import { GROUP_CONTEXT_REQUIRED, notApplied } from './results.ts';
import type { DeleteEventInput } from './types.ts';

/**
 * The event a delete_event call from this user would reach, resolved the same way the delete
 * resolves it: the group calendar in a group, the user's own calendar, a calendar they are a
 * write secretary of, or an event they accepted (the delete then declines it).
 */
function resolveDeleteTarget(ctx: AgentContext, eventId: number, now: number): DeleteTarget | null {
  const actorId = ctx.user.telegram_id;
  const target = (event: CalendarEvent, scope: DeleteTarget['scope'], ownerId?: number): DeleteTarget => ({
    eventId: event.id,
    scope,
    ...(ownerId !== undefined && { ownerId }),
    title: event.title,
    startAt: event.start_at,
    endAt: event.end_at,
    allDay: event.all_day === 1,
    recurring: event.recurrence_rule !== null,
    past: isPastEvent(event, now),
  });
  if (ctx.isGroup && ctx.groupChatId !== undefined) {
    const groupEvent = ctx.eventService.getEventForGroup(eventId, ctx.groupChatId);
    if (groupEvent) return target(groupEvent, 'group');
  }
  const own = ctx.eventService.getEvent(eventId, actorId);
  if (own) return target(own, 'personal');
  const ownerId = ctx.eventService.getEventOwnerId(eventId);
  if (ownerId === null || ownerId === actorId) return null;
  const ownersEvent = ctx.eventService.getEvent(eventId, ownerId);
  if (!ownersEvent) return null;
  if (checkSecretaryAccess(actorId, ownerId, ctx.secretary?.secretaryRepo ?? null, 'write').ok) {
    return target(ownersEvent, 'personal', ownerId);
  }
  const participant = ctx.participantRepo?.findByEventAndUser(eventId, actorId);
  return participant?.status === 'accepted' ? target(ownersEvent, 'personal') : null;
}

/**
 * ask_user with event_ids: the bot, not the model, lists the events with their local dates and
 * owns the buttons, and the callback deletes exactly what the user tapped.
 */
export async function handleDeleteConfirmationRequest(ctx: AgentContext, eventIds: number[]): Promise<ToolResult> {
  const lang = toLang(ctx.user.language);
  const tr = t(lang).aiTools.meta;
  const now = Date.now();
  const targets: DeleteTarget[] = [];
  const missing: number[] = [];
  for (const eventId of new Set(eventIds)) {
    const resolved = resolveDeleteTarget(ctx, eventId, now);
    if (resolved) targets.push(resolved);
    else missing.push(eventId);
  }
  if (missing.length > 0) {
    return { success: false, mutationState: 'not_applied', error: tr.deleteTargetsNotFound(missing.join(', ')) };
  }
  const text = renderDeleteConfirmation(targets, ctx.user.timezone, lang, now);
  // A call has no buttons, and a spoken answer is only the model's reading of it. So the call
  // gets the same list in the private chat, and only a tap there deletes (ctx.chatId is the
  // caller's private chat during a call).
  if (!ctx.sender?.sendMessageWithKeyboard) {
    return { success: false, mutationState: 'not_applied', error: 'Buttons not supported.' };
  }
  const confirmationId = issueDeleteConfirmation(ctx.user.telegram_id, ctx.chatId, targets, now);
  try {
    await ctx.sender.sendMessageWithKeyboard(
      ctx.chatId,
      text,
      deleteConfirmationKeyboard(confirmationId, targets, lang),
    );
  } catch (err) {
    dropDeleteConfirmation(confirmationId);
    logger.error({ err }, 'Failed to send delete confirmation');
    return {
      success: false,
      mutationState: 'not_applied',
      error: 'ASK_USER_DELIVERY_FAILED: failed to send the delete confirmation.',
    };
  }
  if (ctx.inputMode === 'live_call') {
    const spoken = tr.deleteConfirmationSentToChat;
    return {
      success: true,
      mutationState: 'not_applied',
      output: spoken,
      awaitingInput: { kind: 'speech', question: spoken },
      stopLoop: true,
      agentHint: 'Nothing is deleted on the call: the user taps the list in the chat. Do not call delete_event.',
    };
  }
  return {
    success: true,
    mutationState: 'not_applied',
    output: tr.deleteConfirmationSent,
    awaitingInput: { kind: 'chat' },
    stopLoop: true,
    agentHint:
      'The bot deletes exactly what the user taps and then tells you what was deleted. Do not call delete_event for these events.',
  };
}

/**
 * A delete runs only after the user's tap in the bot's list (or for an event this run created, or
 * from an intent workflow). Checked only once the event is known to exist, so a wrong id still
 * gets "not found".
 */
function unconfirmedDeleteRefusal(ctx: AgentContext, eventId: number): ToolResult | null {
  const confirmed =
    ctx.toolOrigin === 'intent_workflow' ||
    ctx.createdEventIds?.has(eventId) === true ||
    consumeDeleteApproval(ctx.user.telegram_id, ctx.chatId, eventId);
  if (confirmed) return null;
  return {
    success: false,
    mutationState: 'not_applied',
    error: t(ctx.user.language).aiTools.meta.deleteNeedsConfirmation,
    agentHint:
      'Call ask_user with event_ids listing every event to delete: the bot shows them with local dates and deletes on the user’s tap. A typed "да" or your own question does not confirm a delete.',
  };
}

function deletedEventResult(ctx: AgentContext, event: CalendarEvent): ToolResult {
  recordChangedDay(ctx, event);
  return {
    success: true,
    effect: { kind: 'event_deleted' },
    output: t(ctx.user.language).aiTools.events.eventDeleted(event.title, event.id),
    data: eventToSummary(event, ctx.user.timezone),
  };
}

async function deleteGroupEvent(ctx: AgentContext, input: DeleteEventInput, groupChatId: number): Promise<ToolResult> {
  const event = ctx.eventService.getEventForGroup(input.event_id, groupChatId);
  if (!event) return notApplied(`Event ${input.event_id} not found in group calendar.`);
  const refusal = unconfirmedDeleteRefusal(ctx, input.event_id);
  if (refusal) return refusal;
  // Remove from all group members' Google Calendars before deleting (parallel)
  const push = ctx.google?.scheduleParticipantPush;
  if (push && ctx.group) {
    const memberIds = ctx.group.groupMemberRepo.getActiveMembers(groupChatId).map((m) => m.user_id);
    await pushEventToUsers(
      push,
      memberIds,
      input.event_id,
      'delete',
      'scheduleParticipantPush group delete failed',
      'userId',
    );
  }
  ctx.eventService.deleteEventForGroup(input.event_id, groupChatId);
  return deletedEventResult(ctx, event);
}

/**
 * Deleting an event the user does not own but accepted only declines it for them; null when this
 * call is not that case (no participation, or not accepted).
 */
async function declineAcceptedEvent(ctx: AgentContext, eventId: number, userId: number): Promise<ToolResult | null> {
  const participantRepo = ctx.participantRepo;
  const participant = participantRepo?.findByEventAndUser(eventId, userId);
  if (!participantRepo || participant?.status !== 'accepted') return null;
  const refusal = unconfirmedDeleteRefusal(ctx, eventId);
  if (refusal) return refusal;
  participantRepo.updateStatus(eventId, userId, 'declined');
  // Remove from this participant's Google Calendar
  if (ctx.google?.scheduleParticipantPush) {
    try {
      await ctx.google.scheduleParticipantPush(userId, eventId, 'delete');
    } catch (err) {
      logger.error({ err, userId, eventId }, 'scheduleParticipantPush decline failed');
    }
  }
  return {
    success: true,
    effect: { kind: 'attendance_declined' },
    output: t(ctx.user.language).aiTools.events.eventDeclined(eventId),
  };
}

async function deleteOwnEvent(
  ctx: AgentContext,
  input: DeleteEventInput,
  userId: number,
  event: CalendarEvent,
): Promise<ToolResult> {
  const refusal = unconfirmedDeleteRefusal(ctx, input.event_id);
  if (refusal) return refusal;

  // Remove from all participants' Google Calendars before deleting (parallel)
  const push = ctx.google?.scheduleParticipantPush;
  if (push && ctx.participantRepo) {
    const participantIds = ctx.participantRepo
      .getByEvent(input.event_id)
      .filter((p) => p.status === 'accepted' && p.user_id !== userId)
      .map((p) => p.user_id);
    await pushEventToUsers(
      push,
      participantIds,
      input.event_id,
      'delete',
      'scheduleParticipantPush delete failed',
      'participantUserId',
    );
  }

  const googleEventId = event.google_event_id ?? undefined;
  ctx.eventService.deleteEvent(input.event_id, userId);

  if (ctx.google?.schedulePush && googleEventId) {
    try {
      await ctx.google.schedulePush(userId, input.event_id, 'delete', { googleEventId });
    } catch (err) {
      logger.error({ err }, 'schedulePush failed');
    }
  }

  return deletedEventResult(ctx, event);
}

export async function handleDeleteEvent(ctx: AgentContext, input: DeleteEventInput): Promise<ToolResult> {
  const access = checkSecretaryAccess(
    ctx.user.telegram_id,
    input.owner_id,
    ctx.secretary?.secretaryRepo ?? null,
    'write',
  );
  if (!access.ok) return notApplied(access.error);
  const userId = access.effectiveUserId;

  if (resolveScope(input, ctx) === 'group') {
    if (ctx.groupChatId === undefined) return notApplied(GROUP_CONTEXT_REQUIRED);
    return deleteGroupEvent(ctx, input, ctx.groupChatId);
  }

  const event = ctx.eventService.getEvent(input.event_id, userId);
  if (event) return deleteOwnEvent(ctx, input, userId, event);
  const declined = await declineAcceptedEvent(ctx, input.event_id, userId);
  return declined ?? notApplied(`Event ${input.event_id} not found or not owned by you.`);
}
