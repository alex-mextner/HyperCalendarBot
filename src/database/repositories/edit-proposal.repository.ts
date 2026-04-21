import type { Database } from 'bun:sqlite';
import type { CreateEditProposalData, EditProposal, EditProposalStatus } from '../types.ts';

export class EditProposalRepository {
  constructor(private db: Database) {}

  create(data: CreateEditProposalData): EditProposal {
    const result = this.db
      .prepare(
        `INSERT INTO edit_proposals (event_id, proposer_id, changes, reason, expires_at, original_values, source)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.event_id,
        data.proposer_id,
        data.changes,
        data.reason ?? null,
        data.expires_at ?? null,
        data.original_values ?? null,
        data.source ?? 'manual',
      );
    return this.findById(Number(result.lastInsertRowid))!;
  }

  findById(id: number): EditProposal | null {
    return (this.db.prepare('SELECT * FROM edit_proposals WHERE id = ?').get(id) as EditProposal | null) ?? null;
  }

  getPendingForEvent(eventId: number): EditProposal[] {
    return this.db
      .prepare("SELECT * FROM edit_proposals WHERE event_id = ? AND status = 'pending' ORDER BY created_at DESC")
      .all(eventId) as EditProposal[];
  }

  getPendingByProposerAndEvent(proposerId: number, eventId: number): EditProposal | null {
    return (
      (this.db
        .prepare(
          "SELECT * FROM edit_proposals WHERE proposer_id = ? AND event_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
        )
        .get(proposerId, eventId) as EditProposal | null) ?? null
    );
  }

  getExpired(): EditProposal[] {
    return this.db
      .prepare(
        "SELECT * FROM edit_proposals WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < datetime('now')",
      )
      .all() as EditProposal[];
  }

  updateStatus(id: number, status: EditProposalStatus): boolean {
    const result = this.db
      .prepare("UPDATE edit_proposals SET status = ? WHERE id = ? AND status = 'pending'")
      .run(status, id);
    return result.changes > 0;
  }

  updateChanges(id: number, changes: string, originalValues: string, expiresAt: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE edit_proposals SET changes = ?, original_values = ?, expires_at = ? WHERE id = ? AND status = 'pending'",
      )
      .run(changes, originalValues, expiresAt, id);
    return result.changes > 0;
  }

  setMessageInfo(
    id: number,
    data: {
      organizer_message_id?: number;
      organizer_chat_id?: number;
      participant_message_id?: number;
      participant_chat_id?: number;
    },
  ): void {
    const fields: string[] = [];
    const values: (number | null)[] = [];
    for (const [k, v] of Object.entries(data)) {
      if (v !== undefined) {
        fields.push(`${k} = ?`);
        values.push(v);
      }
    }
    if (fields.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE edit_proposals SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }
}
