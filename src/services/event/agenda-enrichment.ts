// Explicit presentation boundary: copies authorized events and never alters calendar visibility.
import type { AgendaRepository, AgendaViewer } from '../../database/repositories/agenda.repository.ts';
import type { CalendarEvent, EventOccurrence, InvitationStatus } from '../../database/types.ts';

const symbols: Record<InvitationStatus, string> = {
  pending: '⏳',
  accepted: '✅',
  declined: '❌',
  maybe: '❔',
  cancelled: '🚫',
  expired: '⌛',
};
const english: Record<InvitationStatus, string> = {
  pending: 'pending',
  accepted: 'accepted',
  declined: 'declined',
  maybe: 'maybe',
  cancelled: 'cancelled',
  expired: 'expired',
};
const russian: Record<InvitationStatus, string> = {
  pending: 'ожидается ответ',
  accepted: 'принято',
  declined: 'отклонено',
  maybe: 'возможно',
  cancelled: 'отменено',
  expired: 'истекло',
};
function safeName(value: string | null | undefined): string | undefined {
  return value?.replace(/[\p{Cc}\p{Cf}]/gu, '').trim() || undefined;
}
export function enrichAgendaEvents(
  events: CalendarEvent[],
  viewer: AgendaViewer,
  repository?: AgendaRepository,
): CalendarEvent[] {
  const rosters = repository?.read(events, viewer);
  return events.map((event) => {
    const copy = { ...event, displayMetadata: undefined };
    const roster = rosters?.get(event.id);
    if (!roster) return copy;
    const ru = viewer.language === 'ru';
    const labels = ru ? russian : english;
    const status = (value: InvitationStatus) => `${symbols[value]} ${labels[value]}`;
    let invitationStatus: string;
    if (roster.group) {
      const counts = new Map<InvitationStatus, number>();
      for (const row of roster.rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
      invitationStatus = `${ru ? 'Участники' : 'Participants'}: ${roster.rows.length}`;
      if (counts.size)
        invitationStatus += ` (${[...counts].map(([state, count]) => `${status(state)} ${count}`).join(', ')})`;
    } else if (roster.owner) {
      invitationStatus = roster.rows.length
        ? roster.rows
            .map(
              (row) =>
                `${safeName(row.name) ?? safeName(row.username) ?? (ru ? 'Гость' : 'Invitee')}: ${status(row.status)}`,
            )
            .join('; ')
        : ru
          ? 'Нет приглашений'
          : 'No invitations';
    } else {
      const row = roster.rows.find((row) => row.user_id === viewer.userId);
      if (!row) return copy;
      const incomingLabel = row.invitation
        ? ru
          ? 'Ваше приглашение'
          : 'Your invitation'
        : ru
          ? 'Ваше участие'
          : 'Your participation';
      invitationStatus = `${incomingLabel}: ${status(row.status)}; ${ru ? 'Организатор' : 'Organizer'}: ${safeName(row.organizer) ?? (ru ? 'Организатор' : 'Organizer')}`;
    }
    return { ...copy, displayMetadata: { invitationStatus } };
  });
}
export function enrichAgenda(
  occurrences: EventOccurrence[],
  viewer: AgendaViewer,
  repository?: AgendaRepository,
): EventOccurrence[] {
  const events = enrichAgendaEvents(
    occurrences.map((occurrence) => occurrence.event),
    viewer,
    repository,
  );
  return occurrences.map((occurrence, index) => ({ ...occurrence, event: events[index]! }));
}
