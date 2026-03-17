import type { Database } from 'bun:sqlite';
import type { CreateEditProposalData, EditProposal, EditProposalStatus } from '../types.ts';

export class EditProposalRepository {
  constructor(private db: Database) {}

  create(data: CreateEditProposalData): EditProposal {
    const result = this.db
      .prepare('INSERT INTO edit_proposals (event_id, proposer_id, changes, reason) VALUES (?, ?, ?, ?)')
      .run(data.event_id, data.proposer_id, data.changes, data.reason ?? null);
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

  updateStatus(id: number, status: EditProposalStatus): boolean {
    const result = this.db
      .prepare("UPDATE edit_proposals SET status = ? WHERE id = ? AND status = 'pending'")
      .run(status, id);
    return result.changes > 0;
  }
}
