import type { Visibility } from '../../../database/types.ts';
import type { AgentContext, ToolResult } from '../types.ts';

interface ShareEventInput {
  event_id: number;
  target_type: 'user' | 'group';
  target_id: number;
}

interface SendInvitationInput {
  event_id: number;
  invitee_id: number;
}

interface GetInvitationStatusInput {
  event_id: number;
}

interface UpdateSharingSettingsInput {
  default_visibility?: Visibility;
  inline_mode_enabled?: boolean;
  allow_invitations?: boolean;
}

interface ShareAgendaInput {
  period: 'today' | 'tomorrow' | 'week';
  target_type: 'user' | 'group';
  target_id: number;
}

interface SetEventVisibilityInput {
  event_id: number;
  visibility: Visibility;
}

export function handleShareEvent(ctx: AgentContext, input: ShareEventInput): ToolResult {
  if (!ctx.sharedEventRepo) {
    return { success: false, error: 'Sharing is not configured.' };
  }

  const event = ctx.eventService.getEvent(input.event_id, ctx.user.telegram_id);
  if (!event) {
    return { success: false, error: `Event ${input.event_id} not found or not owned by you.` };
  }

  const shared = ctx.sharedEventRepo.create({
    event_id: input.event_id,
    shared_by: ctx.user.telegram_id,
    shared_to_type: input.target_type,
    shared_to_id: input.target_id,
    share_type: 'card',
  });

  return {
    success: true,
    output: `Event "${event.title}" shared (id: ${shared.id}, target: ${input.target_type} ${input.target_id}).`,
  };
}

export function handleSendInvitation(ctx: AgentContext, input: SendInvitationInput): ToolResult {
  if (!ctx.invitationService) {
    return { success: false, error: 'Invitations are not configured.' };
  }

  const result = ctx.invitationService.sendInvitation(input.event_id, ctx.user.telegram_id, input.invitee_id);

  if (!result.success) {
    return { success: false, error: result.error };
  }

  return {
    success: true,
    output: `Invitation sent (id: ${result.invitation!.id}, event: ${input.event_id}, invitee: ${input.invitee_id}).`,
  };
}

export function handleGetInvitationStatus(ctx: AgentContext, input: GetInvitationStatusInput): ToolResult {
  if (!ctx.invitationRepo) {
    return { success: false, error: 'Invitations are not configured.' };
  }

  const event = ctx.eventService.getEvent(input.event_id, ctx.user.telegram_id);
  if (!event) {
    return { success: false, error: `Event ${input.event_id} not found or not owned by you.` };
  }

  const pending = ctx.invitationRepo.getPendingForEvent(input.event_id);
  const accepted = ctx.invitationRepo.getAcceptedForEvent(input.event_id);

  const lines: string[] = [];
  for (const inv of accepted) {
    lines.push(`invitee: ${inv.invitee_id}, status: accepted`);
  }
  for (const inv of pending) {
    lines.push(`invitee: ${inv.invitee_id}, status: ${inv.status}`);
  }

  if (lines.length === 0) {
    return { success: true, output: `No invitations for event "${event.title}".` };
  }

  return {
    success: true,
    output: `Invitations for "${event.title}" (id: ${event.id}):\n${lines.join('\n')}`,
  };
}

export function handleUpdateSharingSettings(ctx: AgentContext, input: UpdateSharingSettingsInput): ToolResult {
  if (!ctx.sharingSettingsRepo) {
    return { success: false, error: 'Sharing settings are not configured.' };
  }

  const patch: Record<string, string | number> = {};
  if (input.default_visibility !== undefined) patch.default_visibility = input.default_visibility;
  if (input.inline_mode_enabled !== undefined) patch.inline_mode_enabled = input.inline_mode_enabled ? 1 : 0;
  if (input.allow_invitations !== undefined) patch.allow_invitations = input.allow_invitations ? 1 : 0;

  if (Object.keys(patch).length === 0) {
    return { success: false, error: 'No settings provided to update.' };
  }

  ctx.sharingSettingsRepo.ensureDefaults(ctx.user.telegram_id);
  ctx.sharingSettingsRepo.update(ctx.user.telegram_id, patch);

  const lines = Object.entries(patch).map(([k, v]) => `${k}: ${v}`);
  return { success: true, output: `Sharing settings updated: ${lines.join(', ')}` };
}

export function handleShareAgenda(ctx: AgentContext, input: ShareAgendaInput): ToolResult {
  if (!ctx.sharingService || !ctx.sharedEventRepo) {
    return { success: false, error: 'Sharing is not configured.' };
  }

  const now = new Date();
  const dates: Date[] = [];

  if (input.period === 'today') {
    dates.push(now);
  } else if (input.period === 'tomorrow') {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    dates.push(tomorrow);
  } else {
    for (let i = 0; i < 7; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      dates.push(d);
    }
  }

  const allEvents = dates.flatMap((date) =>
    ctx.sharingService!.getAgendaForSharing(ctx.user.telegram_id, date, ctx.user.timezone),
  );

  if (allEvents.length === 0) {
    return { success: true, output: `No visible events to share for ${input.period}.` };
  }

  // Record the share
  for (const ev of allEvents) {
    ctx.sharedEventRepo.create({
      event_id: ev.eventId,
      shared_by: ctx.user.telegram_id,
      shared_to_type: input.target_type,
      shared_to_id: input.target_id,
      share_type: 'agenda',
    });
  }

  const lines = allEvents.map((ev) => `- ${ev.displayTitle} (${ev.startAt})`);
  return {
    success: true,
    output: `Agenda for ${input.period} shared with ${input.target_type} ${input.target_id} (${allEvents.length} events):\n${lines.join('\n')}`,
  };
}

export function handleSetEventVisibility(ctx: AgentContext, input: SetEventVisibilityInput): ToolResult {
  if (!ctx.sharingSettingsRepo) {
    return { success: false, error: 'Sharing settings are not configured.' };
  }

  const event = ctx.eventService.getEvent(input.event_id, ctx.user.telegram_id);
  if (!event) {
    return { success: false, error: `Event ${input.event_id} not found or not owned by you.` };
  }

  ctx.sharingSettingsRepo.setEventVisibility(input.event_id, input.visibility);

  return {
    success: true,
    output: `Visibility for "${event.title}" (id: ${event.id}) set to "${input.visibility}".`,
  };
}
