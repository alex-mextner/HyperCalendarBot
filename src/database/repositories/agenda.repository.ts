// Batched presentation reads for events already selected by the calendar visibility policy.
// Private invitation rows are never queried for group presentation.
import type { Database } from 'bun:sqlite';
import type { CalendarEvent, InvitationStatus, ParticipantStatus } from '../types.ts';

export interface AgendaViewer {
  userId: number;
  groupId?: number;
  language?: 'en' | 'ru';
}
interface Source {
  id: number;
  user_id: number;
  owner_type: 'user' | 'group';
  group_id: number | null;
  master_id: number | null;
}
interface RosterRow {
  invitation: number;
  event_id: number;
  user_id: number;
  status: InvitationStatus | ParticipantStatus;
  name: string | null;
  username: string | null;
  organizer: string | null;
}
export interface AgendaRoster {
  group: boolean;
  owner: boolean;
  rows: RosterRow[];
}

export class AgendaRepository {
  constructor(private db: Database) {}

  read(events: CalendarEvent[], viewer: AgendaViewer): Map<number, AgendaRoster> {
    const result = new Map<number, AgendaRoster>();
    const ids = [...new Set(events.map((event) => event.id))];
    for (let offset = 0; offset < ids.length; offset += 300) {
      const batch = ids.slice(offset, offset + 300);
      const storedSources = this.db
        .query<Source, number[]>(`
        SELECT e.id, e.user_id, e.owner_type, e.group_id, p.id AS master_id
        FROM events e LEFT JOIN events p ON p.id = e.parent_event_id
          AND p.recurrence_rule IS NOT NULL AND p.is_deleted = 0 AND p.is_cancelled = 0
          AND p.user_id = e.user_id AND p.owner_type = e.owner_type AND p.group_id IS e.group_id
        WHERE e.id IN (${batch.map(() => '?').join(',')}) AND e.is_deleted = 0 AND e.is_cancelled = 0
      `)
        .all(...batch);
      const sources = storedSources.filter(
        (source) =>
          viewer.groupId === undefined || (source.owner_type === 'group' && source.group_id === viewer.groupId),
      );
      const sourceIds = [
        ...new Set(sources.flatMap((source) => [source.id, ...(source.master_id ? [source.master_id] : [])])),
      ];
      if (!sourceIds.length) continue;
      const placeholders = sourceIds.map(() => '?').join(',');
      // Owners can inspect their roster; other personal viewers get only their own row.
      const participants = this.db
        .query<RosterRow, number[]>(`
        SELECT 0 AS invitation, ep.event_id, ep.user_id, ep.status, u.first_name AS name, u.username, o.first_name AS organizer
        FROM event_participants ep JOIN events e ON e.id = ep.event_id
        LEFT JOIN users u ON e.owner_type = 'user' AND u.telegram_id = ep.user_id
        LEFT JOIN users o ON e.owner_type = 'user' AND o.telegram_id = e.user_id
        WHERE ep.event_id IN (${placeholders}) AND ep.role != 'organizer'
          AND (e.owner_type = 'group' OR e.user_id = ? OR ep.user_id = ?)
      `)
        .all(...sourceIds, viewer.userId, viewer.userId);
      const privateSources = viewer.groupId === undefined ? sources.filter((s) => s.owner_type !== 'group') : [];
      const privateIds = [...new Set(privateSources.flatMap((s) => [s.id, ...(s.master_id ? [s.master_id] : [])]))];
      const invitations = privateIds.length
        ? this.db
            .query<RosterRow, number[]>(`
        SELECT 1 AS invitation, i.event_id, i.invitee_id AS user_id, i.status, u.first_name AS name,
          COALESCE(u.username, i.invitee_username) AS username, o.first_name AS organizer
        FROM invitations i JOIN events e ON e.id = i.event_id
        LEFT JOIN users u ON u.telegram_id = i.invitee_id LEFT JOIN users o ON o.telegram_id = i.inviter_id
        WHERE i.event_id IN (${privateIds.map(() => '?').join(',')}) AND e.owner_type = 'user'
          AND (e.user_id = ? OR i.invitee_id = ?)
          AND NOT EXISTS (
            SELECT 1 FROM invitations newer
            WHERE newer.event_id = i.event_id AND newer.invitee_id = i.invitee_id
              AND (newer.created_at > i.created_at OR (newer.created_at = i.created_at AND newer.id > i.id))
          )
        ORDER BY i.id
      `)
            .all(...privateIds, viewer.userId, viewer.userId)
        : [];
      for (const source of sources) {
        const group = source.owner_type === 'group';
        if (viewer.groupId !== undefined && (!group || source.group_id !== viewer.groupId)) continue;
        const relevant = (row: RosterRow) => row.event_id === source.id || row.event_id === source.master_id;
        const own = source.user_id === viewer.userId && !group;
        const participantRows = participants.filter(relevant);
        if (
          !group &&
          !own &&
          !participantRows.some((row) => row.user_id === viewer.userId && row.status === 'accepted')
        )
          continue;
        const rows = new Map<number, RosterRow>();
        // Instance rows override inherited master rows, and invitation status replaces duplicate attendance.
        for (const id of [source.master_id, source.id]) {
          for (const row of participantRows.filter((row) => row.event_id === id)) rows.set(row.user_id, row);
          for (const row of invitations.filter((row) => row.event_id === id)) rows.set(row.user_id, row);
        }
        result.set(source.id, { group, owner: own, rows: [...rows.values()] });
      }
    }
    return result;
  }
}
