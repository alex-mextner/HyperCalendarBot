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
        WITH ranked AS (
          SELECT *, ROW_NUMBER() OVER (
            PARTITION BY event_id, invitee_id ORDER BY created_at DESC, id DESC
          ) AS recipient_rank
          FROM invitations WHERE event_id IN (${privateIds.map(() => '?').join(',')})
        )
        SELECT 1 AS invitation, i.event_id, i.invitee_id AS user_id, i.status, u.first_name AS name,
          COALESCE(u.username, i.invitee_username) AS username, o.first_name AS organizer
        FROM ranked i JOIN events e ON e.id = i.event_id
        LEFT JOIN users u ON u.telegram_id = i.invitee_id LEFT JOIN users o ON o.telegram_id = i.inviter_id
        WHERE i.recipient_rank = 1 AND e.owner_type = 'user'
          AND (e.user_id = ? OR i.invitee_id = ?)
        ORDER BY i.id
      `)
            .all(...privateIds, viewer.userId, viewer.userId)
        : [];
      const indexRows = (rows: RosterRow[]) => {
        const index = new Map<number, RosterRow[]>();
        for (const row of rows) {
          const id = row.event_id;
          const bucket = index.get(id);
          if (bucket) bucket.push(row);
          else index.set(id, [row]);
        }
        return index;
      };
      const participantsByEvent = indexRows(participants);
      const invitationsByEvent = indexRows(invitations);
      for (const source of sources) {
        const group = source.owner_type === 'group';
        if (viewer.groupId !== undefined && (!group || source.group_id !== viewer.groupId)) continue;
        const own = source.user_id === viewer.userId && !group;
        const participantRows = [
          ...(participantsByEvent.get(source.master_id ?? -1) ?? []),
          ...(participantsByEvent.get(source.id) ?? []),
        ];
        if (
          !group &&
          !own &&
          !participantRows.some((row) => row.user_id === viewer.userId && row.status === 'accepted')
        )
          continue;
        const rows = new Map<number, RosterRow>();
        // Instance rows override inherited master rows, and invitation status replaces duplicate attendance.
        for (const id of [source.master_id, source.id]) {
          for (const row of participantsByEvent.get(id ?? -1) ?? []) rows.set(row.user_id, row);
          for (const row of invitationsByEvent.get(id ?? -1) ?? []) rows.set(row.user_id, row);
        }
        result.set(source.id, { group, owner: own, rows: [...rows.values()] });
      }
    }
    return result;
  }
}
