import type { Database } from 'bun:sqlite';
import type { CalendarProposal, CreateProposalData, ProposalStatus } from '../types.ts';

export class CalendarProposalRepository {
  constructor(private db: Database) {}

  create(data: CreateProposalData): CalendarProposal {
    const result = this.db
      .prepare(
        `INSERT INTO calendar_proposals
          (group_chat_id, group_chat_title, proposer_id, target_id, action, payload, summary, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        data.group_chat_id,
        data.group_chat_title ?? null,
        data.proposer_id,
        data.target_id,
        data.action,
        data.payload,
        data.summary,
        data.expires_at,
      );
    return this.findById(Number(result.lastInsertRowid))!;
  }

  findById(id: number): CalendarProposal | null {
    return (
      (this.db.prepare('SELECT * FROM calendar_proposals WHERE id = ?').get(id) as CalendarProposal | null) ?? null
    );
  }

  updateStatus(id: number, status: ProposalStatus): boolean {
    const result = this.db
      .prepare(`UPDATE calendar_proposals SET status = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(status, id);
    return result.changes > 0;
  }

  setGroupMessageId(id: number, messageId: number): void {
    this.db.prepare(`UPDATE calendar_proposals SET group_message_id = ? WHERE id = ?`).run(messageId, id);
  }

  setDmMessageId(id: number, messageId: number): void {
    this.db.prepare(`UPDATE calendar_proposals SET dm_message_id = ? WHERE id = ?`).run(messageId, id);
  }

  getExpired(): CalendarProposal[] {
    return this.db
      .prepare(`SELECT * FROM calendar_proposals WHERE status = 'pending' AND expires_at < datetime('now')`)
      .all() as CalendarProposal[];
  }

  expirePending(): CalendarProposal[] {
    const toExpire = this.db
      .prepare(`SELECT * FROM calendar_proposals WHERE status = 'pending' AND expires_at < datetime('now')`)
      .all() as CalendarProposal[];
    if (toExpire.length > 0) {
      this.db
        .prepare(
          `UPDATE calendar_proposals SET status = 'expired', updated_at = datetime('now')
           WHERE status = 'pending' AND expires_at < datetime('now')`,
        )
        .run();
    }
    return toExpire;
  }
}
