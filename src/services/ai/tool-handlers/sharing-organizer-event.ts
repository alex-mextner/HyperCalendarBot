// Which event an invitation tool may act on for a given organizer. For the caller's own calendar this is
// everything the caller sees (the group events of their chats included, as before). For a calendar a
// secretary manages it is only what the owner organises personally: EventService.getEvent also returns
// the group events the owner merely sees as a member, and the secretary's delegation never covered those.
import type { CalendarEvent } from '../../../database/types.ts';
import type { AgentContext, ToolResult } from '../types.ts';

export function getEventForOrganizer(ctx: AgentContext, eventId: number, organizerId: number): CalendarEvent | null {
  const event = ctx.eventService.getEvent(eventId, organizerId);
  if (organizerId === ctx.user.telegram_id) return event;
  return event && event.owner_type !== 'group' && event.user_id === organizerId ? event : null;
}

export function eventNotInOwnerCalendar(eventId: number, ownerId: number): ToolResult {
  return {
    success: false,
    mutationState: 'not_applied',
    error: `Event ${eventId} not found in the calendar of user ${ownerId}.`,
  };
}
