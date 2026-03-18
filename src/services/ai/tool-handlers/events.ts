import type { EventOccurrence } from '../../../database/types.ts';
import { logger } from '../../../utils/logger.ts';
import type { AgentContext, ToolResult } from '../types.ts';
import { checkSecretaryAccess } from './secretary-access.ts';
import { resolveScope } from './shared.ts';

const eventsLogger = logger.child({ module: 'ai-tools' });

type Scope = 'personal' | 'group';

interface GetEventsInput {
  start_date: string;
  end_date: string;
  scope?: Scope;
  owner_id?: number;
}

interface CreateEventInput {
  title: string;
  start_at: string;
  end_at?: string;
  description?: string;
  location?: string;
  all_day?: boolean;
  recurrence_rule?: string;
  reminder_minutes?: number[];
  force?: boolean;
  scope?: Scope;
  owner_id?: number;
}

interface UpdateEventInput {
  event_id: number;
  title?: string;
  start_at?: string;
  end_at?: string | null;
  description?: string | null;
  location?: string | null;
  recurrence_rule?: string | null;
  scope?: Scope;
  owner_id?: number;
}

interface DeleteEventInput {
  event_id: number;
  scope?: Scope;
  owner_id?: number;
}

interface GetUpcomingInput {
  limit?: number;
  scope?: Scope;
  owner_id?: number;
}

interface SnoozeEventInput {
  event_id: number;
  minutes?: number;
  scope?: Scope;
  owner_id?: number;
}

interface GetEventInput {
  event_id: number;
  scope?: Scope;
  owner_id?: number;
}

interface SearchEventsInput {
  query: string;
  scope?: Scope;
  owner_id?: number;
}

export function handleGetEvents(ctx: AgentContext, input: GetEventsInput): ToolResult {
  const access = checkSecretaryAccess(ctx.user.telegram_id, input.owner_id, ctx.secretaryRepo ?? null, 'read');
  if (!access.ok) return { success: false, error: access.error };
  const userId = access.effectiveUserId;
  const scope = resolveScope(input, ctx);
  if (scope === 'group' && ctx.groupChatId === undefined) {
    return { success: false, error: 'Group context required for group scope' };
  }
  const occurrences =
    scope === 'group'
      ? ctx.eventService.getEventsInRangeForGroup(ctx.groupChatId!, input.start_date, input.end_date)
      : ctx.eventService.getEventsInRange(userId, input.start_date, input.end_date);

  if (occurrences.length === 0) {
    return { success: true, output: 'No events found in this range.' };
  }

  const lines = occurrences.map((occ) => {
    const e = occ.event;
    const parts = [`id: ${e.id}`, `title: ${e.title}`, `start: ${occ.occurrence_start}`];
    if (occ.occurrence_end) parts.push(`end: ${occ.occurrence_end}`);
    if (e.description) parts.push(`description: ${e.description}`);
    if (e.location) parts.push(`location: ${e.location}`);
    if (e.recurrence_rule) parts.push(`recurrence: ${e.recurrence_rule}`);
    if (e.owner_type === 'group' && e.group_id) {
      const groupTitle = ctx.groupChatRepo?.findByChatId(e.group_id)?.title;
      parts.push(`group: ${groupTitle ?? e.group_id}`);
    }
    if (e.created_by) {
      const creator = ctx.userRepo.findByTelegramId(e.created_by);
      const creatorLabel = creator?.username ? `@${creator.username}` : `id:${e.created_by}`;
      parts.push(`created_by: ${creatorLabel}`);
    }
    return parts.join(', ');
  });

  return { success: true, output: lines.join('\n') };
}

export function handleCreateEvent(ctx: AgentContext, input: CreateEventInput): ToolResult {
  const access = checkSecretaryAccess(ctx.user.telegram_id, input.owner_id, ctx.secretaryRepo ?? null, 'write');
  if (!access.ok) return { success: false, error: access.error };
  const userId = access.effectiveUserId;
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

function executeCreateEvent(ctx: AgentContext, input: CreateEventInput, userId: number): ToolResult {
  try {
    const scope = resolveScope(input, ctx);
    if (scope === 'group' && ctx.groupChatId === undefined) {
      return { success: false, error: 'Group context required for group scope' };
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

    const parts = [`id: ${event.id}`, `title: ${event.title}`, `start: ${event.start_at}`];
    if (event.end_at) parts.push(`end: ${event.end_at}`);
    if (event.description) parts.push(`description: ${event.description}`);
    if (event.location) parts.push(`location: ${event.location}`);

    if (scope === 'group' && ctx.groupChatId && ctx.groupMemberRepo && ctx.sender) {
      const members = ctx.groupMemberRepo.getMembers(ctx.groupChatId);
      const groupTitle = ctx.groupChatRepo?.findByChatId(ctx.groupChatId)?.title;
      const groupLabel = groupTitle ? ` в группе "${groupTitle}"` : ' в группе';
      const notifyText = `📅 Новое событие${groupLabel}:\n*${event.title}*`;
      for (const member of members) {
        if (member.user_id === ctx.user.telegram_id) continue;
        ctx.sender.sendMessage(member.user_id, notifyText, 'Markdown').catch((err) => {
          eventsLogger.error({ error: String(err), userId: member.user_id }, 'Group event notification failed');
        });
      }
    }

    return { success: true, output: `Event created: ${parts.join(', ')}` };
  } catch (error) {
    return { success: false, error: `Failed to create event: ${String(error)}` };
  }
}

export function handleUpdateEvent(ctx: AgentContext, input: UpdateEventInput): ToolResult {
  const access = checkSecretaryAccess(ctx.user.telegram_id, input.owner_id, ctx.secretaryRepo ?? null, 'write');
  if (!access.ok) return { success: false, error: access.error };
  const userId = access.effectiveUserId;
  const scope = resolveScope(input, ctx);
  const { event_id, scope: _, owner_id: _oid, ...updates } = input;
  if (scope === 'group' && ctx.groupChatId === undefined) {
    return { success: false, error: 'Group context required for group scope' };
  }
  const updated =
    scope === 'group'
      ? ctx.eventService.updateEventForGroup(event_id, ctx.groupChatId!, updates)
      : ctx.eventService.updateEvent(event_id, userId, updates);

  if (!updated) {
    return { success: false, error: `Event ${event_id} not found or not owned by you.` };
  }

  const parts = [`id: ${updated.id}`, `title: ${updated.title}`, `start: ${updated.start_at}`];
  if (updated.end_at) parts.push(`end: ${updated.end_at}`);
  if (updated.description) parts.push(`description: ${updated.description}`);
  if (updated.location) parts.push(`location: ${updated.location}`);

  let output = `Event updated: ${parts.join(', ')}`;

  if (ctx.participantRepo) {
    const accepted = ctx.participantRepo
      .getByEvent(event_id)
      .filter((p) => p.status === 'accepted' && p.user_id !== ctx.user.telegram_id);
    if (accepted.length > 0) {
      output += `. This event has ${accepted.length} participant${accepted.length > 1 ? 's' : ''} — notify them if the change is significant (use notify_participants tool).`;
    }
  }

  return { success: true, output };
}

export function handleDeleteEvent(ctx: AgentContext, input: DeleteEventInput): ToolResult {
  const access = checkSecretaryAccess(ctx.user.telegram_id, input.owner_id, ctx.secretaryRepo ?? null, 'write');
  if (!access.ok) return { success: false, error: access.error };
  const userId = access.effectiveUserId;
  const scope = resolveScope(input, ctx);

  if (scope === 'group') {
    if (ctx.groupChatId === undefined) {
      return { success: false, error: 'Group context required for group scope' };
    }
    const event = ctx.eventService.getEventForGroup(input.event_id, ctx.groupChatId);
    if (!event) {
      return { success: false, error: `Event ${input.event_id} not found in group calendar.` };
    }
    ctx.eventService.deleteEventForGroup(input.event_id, ctx.groupChatId!);
    return { success: true, output: `Event "${event.title}" (id: ${event.id}) deleted.` };
  }

  const event = ctx.eventService.getEvent(input.event_id, userId);

  if (!event && ctx.participantRepo) {
    const participant = ctx.participantRepo.findByEventAndUser(input.event_id, userId);
    if (participant && participant.status === 'accepted') {
      ctx.participantRepo.updateStatus(input.event_id, userId, 'declined');
      return {
        success: true,
        output: `You declined the shared event (id: ${input.event_id}). It has been removed from your calendar.`,
      };
    }
  }

  if (!event) {
    return { success: false, error: `Event ${input.event_id} not found or not owned by you.` };
  }

  ctx.eventService.deleteEvent(input.event_id, userId);
  return { success: true, output: `Event "${event.title}" (id: ${event.id}) deleted.` };
}

export function handleSearchEvents(ctx: AgentContext, input: SearchEventsInput): ToolResult {
  const access = checkSecretaryAccess(ctx.user.telegram_id, input.owner_id, ctx.secretaryRepo ?? null, 'read');
  if (!access.ok) return { success: false, error: access.error };
  const userId = access.effectiveUserId;
  const scope = resolveScope(input, ctx);
  if (scope === 'group' && ctx.groupChatId === undefined) {
    return { success: false, error: 'Group context required for group scope' };
  }
  const events =
    scope === 'group'
      ? ctx.eventService.searchEventsForGroup(ctx.groupChatId!, input.query)
      : ctx.eventService.searchEvents(userId, input.query);

  if (events.length === 0) {
    return { success: true, output: 'No events found matching the query.' };
  }

  const lines = events.map((e) => {
    const parts = [`id: ${e.id}`, `title: ${e.title}`, `start: ${e.start_at}`];
    if (e.end_at) parts.push(`end: ${e.end_at}`);
    if (e.location) parts.push(`location: ${e.location}`);
    return parts.join(', ');
  });

  return { success: true, output: lines.join('\n') };
}

export function handleGetUpcoming(ctx: AgentContext, input: GetUpcomingInput): ToolResult {
  const access = checkSecretaryAccess(ctx.user.telegram_id, input.owner_id, ctx.secretaryRepo ?? null, 'read');
  if (!access.ok) return { success: false, error: access.error };
  const userId = access.effectiveUserId;
  const limit = input.limit ?? 5;
  const scope = resolveScope(input, ctx);

  if (scope === 'group' && ctx.groupChatId === undefined) {
    return { success: false, error: 'Group context required for group scope' };
  }

  let upcoming: EventOccurrence[];

  if (scope === 'group') {
    upcoming = ctx.eventService.getUpcomingForGroup(ctx.groupChatId!, limit);
  } else {
    const now = new Date().toISOString();
    const farFuture = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
    const occurrences = ctx.eventService.getEventsInRange(userId, now, farFuture);
    upcoming = occurrences.slice(0, limit);
  }

  if (upcoming.length === 0) {
    return { success: true, output: 'No upcoming events.' };
  }

  const lines = upcoming.map((occ) => {
    const e = occ.event;
    const parts = [`id: ${e.id}`, `title: ${e.title}`, `start: ${occ.occurrence_start}`];
    if (occ.occurrence_end) parts.push(`end: ${occ.occurrence_end}`);
    if (e.location) parts.push(`location: ${e.location}`);
    return parts.join(', ');
  });

  return { success: true, output: `Next ${upcoming.length} events:\n${lines.join('\n')}` };
}

export function handleSnoozeEvent(ctx: AgentContext, input: SnoozeEventInput): ToolResult {
  const access = checkSecretaryAccess(ctx.user.telegram_id, input.owner_id, ctx.secretaryRepo ?? null, 'write');
  if (!access.ok) return { success: false, error: access.error };
  const userId = access.effectiveUserId;
  const scope = resolveScope(input, ctx);
  if (scope === 'group' && ctx.groupChatId === undefined) {
    return { success: false, error: 'Group context required for group scope' };
  }
  const event =
    scope === 'group'
      ? ctx.eventService.getEventForGroup(input.event_id, ctx.groupChatId!)
      : ctx.eventService.getEvent(input.event_id, userId);

  if (!event) {
    return { success: false, error: `Event ${input.event_id} not found or not owned by you.` };
  }

  const minutes = input.minutes ?? 10;
  const newStart = new Date(new Date(event.start_at).getTime() + minutes * 60_000).toISOString();
  const updates: Record<string, string> = { start_at: newStart };

  if (event.end_at) {
    updates.end_at = new Date(new Date(event.end_at).getTime() + minutes * 60_000).toISOString();
  }

  const updated =
    scope === 'group'
      ? ctx.eventService.updateEventForGroup(input.event_id, ctx.groupChatId!, updates)
      : ctx.eventService.updateEvent(input.event_id, userId, updates);

  if (!updated) {
    return { success: false, error: 'Failed to snooze event.' };
  }

  return {
    success: true,
    output: `Event "${updated.title}" snoozed by ${minutes} min. New start: ${updated.start_at}`,
  };
}

export function handleGetEvent(ctx: AgentContext, input: GetEventInput): ToolResult {
  const access = checkSecretaryAccess(ctx.user.telegram_id, input.owner_id, ctx.secretaryRepo ?? null, 'read');
  if (!access.ok) return { success: false, error: access.error };
  const userId = access.effectiveUserId;
  const scope = resolveScope(input, ctx);
  if (scope === 'group' && ctx.groupChatId === undefined) {
    return { success: false, error: 'Group context required for group scope' };
  }
  const event =
    scope === 'group'
      ? ctx.eventService.getEventForGroup(input.event_id, ctx.groupChatId!)
      : ctx.eventService.getEvent(input.event_id, userId);

  if (!event) {
    return { success: false, error: `Event ${input.event_id} not found or not owned by you.` };
  }

  const parts = [`id: ${event.id}`, `title: ${event.title}`, `start: ${event.start_at}`];
  if (event.end_at) parts.push(`end: ${event.end_at}`);
  if (event.description) parts.push(`description: ${event.description}`);
  if (event.location) parts.push(`location: ${event.location}`);
  if (event.recurrence_rule) parts.push(`recurrence: ${event.recurrence_rule}`);
  if (event.all_day) parts.push('all_day: true');
  if (event.owner_type === 'group' && event.group_id) {
    const groupTitle = ctx.groupChatRepo?.findByChatId(event.group_id)?.title;
    parts.push(`group: ${groupTitle ?? event.group_id}`);
  }
  if (event.created_by) {
    const creator = ctx.userRepo.findByTelegramId(event.created_by);
    const creatorLabel = creator?.username ? `@${creator.username}` : `id:${event.created_by}`;
    parts.push(`created_by: ${creatorLabel}`);
  }

  const reminders = ctx.reminderRepo.getByEventId(input.event_id);
  if (reminders.length > 0) {
    parts.push(`reminders: ${reminders.map((r) => `${r.minutes_before}min`).join(', ')}`);
  }

  return { success: true, output: parts.join(', ') };
}

interface NotifyParticipantsInput {
  event_id: number;
  message: string;
}

export function handleNotifyParticipants(ctx: AgentContext, input: NotifyParticipantsInput): ToolResult {
  const event = ctx.eventService.getEvent(input.event_id, ctx.user.telegram_id);
  if (!event) {
    return { success: false, error: `Event ${input.event_id} not found or not owned by you.` };
  }

  if (!ctx.participantRepo) {
    return { success: false, error: 'Participants feature is not configured.' };
  }

  const accepted = ctx.participantRepo
    .getByEvent(input.event_id)
    .filter((p) => p.status === 'accepted' && p.user_id !== ctx.user.telegram_id);

  if (accepted.length === 0) {
    return { success: false, error: 'This event has no accepted participants to notify.' };
  }

  if (ctx.sender) {
    const senderName = ctx.user.first_name ?? ctx.user.username ?? `User ${ctx.user.telegram_id}`;
    const text = `📅 Update on "${event.title}" from ${senderName}:\n${input.message}`;
    for (const p of accepted) {
      ctx.sender.sendMessage(p.user_id, text).catch((err) => {
        eventsLogger.error({ error: String(err), userId: p.user_id }, 'Participant notification failed');
      });
    }
  }

  return {
    success: true,
    output: `Notification sent to ${accepted.length} participant${accepted.length > 1 ? 's' : ''}.`,
  };
}
