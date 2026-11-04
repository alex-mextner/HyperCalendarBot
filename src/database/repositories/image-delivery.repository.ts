// Durable bookkeeping of asynchronous AI pictures (migration 070). ImageDelivery writes the state
// BEFORE it acts (a send is recorded `sending` before the Telegram call), so a process killed at any
// point leaves a row that says how far the picture got; reconciliation at the next start decides from it.
import type { Database } from 'bun:sqlite';

export type ImageDeliveryState =
  | 'queued'
  | 'rendered'
  | 'sending'
  | 'delivered'
  | 'failed'
  | 'expired'
  | 'unknown'
  | 'superseded';

export interface ImageDeliveryRow {
  id: string;
  chat_id: number;
  language: string;
  kind: string;
  label: string;
  job_type: string;
  slot: string;
  payload_hash: string;
  rebuilds: number;
  job_json: string | null;
  state: ImageDeliveryState;
  message_id: number | null;
  note_sent: number;
  created_at: number;
  expires_at: number;
  updated_at: number;
}

export interface NewImageDelivery {
  id: string;
  chatId: number;
  language: string;
  kind: string;
  label: string;
  jobType: string;
  /** What the picture shows; a later request for the same slot is deduplicated or supersedes this one, also after a restart. */
  slot: string;
  /** Hash of the render data this row's `jobJson` was built from. */
  payloadHash: string;
  jobJson: string;
  createdAt: number;
  expiresAt: number;
}

const COLUMNS =
  'id, chat_id, language, kind, label, job_type, slot, payload_hash, rebuilds, job_json, state, message_id, note_sent, created_at, expires_at, updated_at';
const TERMINAL = "('delivered','failed','expired','unknown','superseded')";
/** Terminal rows are bookkeeping only; they are pruned after a week. */
export const IMAGE_DELIVERY_RETENTION_MS = 7 * 86_400_000;

export class ImageDeliveryRepository {
  constructor(private readonly db: Database) {}

  /**
   * False when a delivery with this id exists in ANY state: the id is deterministic (chat, Telegram
   * request, kind, slot, payload), so a replay of the same request is a duplicate. A finished row is not
   * replaced: an `unknown` one (the upload may have landed) or a `delivered` one must never allow a
   * second send, and its recorded message id must survive. Rows are pruned after a week.
   */
  insert(row: NewImageDelivery): boolean {
    // IMMEDIATE takes the write lock at the start, so a second connection cannot slip in between the read and the insert.
    return this.db
      .transaction(() => {
        const existing = this.db
          .query<{ id: string }, [string]>('SELECT id FROM image_deliveries WHERE id = ?')
          .get(row.id);
        if (existing) return false;
        this.db.run(
          `INSERT INTO image_deliveries
           (id, chat_id, language, kind, label, job_type, slot, payload_hash, job_json, state, message_id, note_sent, created_at, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, 0, ?, ?, ?)`,
          [
            row.id,
            row.chatId,
            row.language,
            row.kind,
            row.label,
            row.jobType,
            row.slot,
            row.payloadHash,
            row.jobJson,
            row.createdAt,
            row.expiresAt,
            row.createdAt,
          ],
        );
        return true;
      })
      .immediate();
  }

  get(id: string): ImageDeliveryRow | null {
    return this.db.query<ImageDeliveryRow, [string]>(`SELECT ${COLUMNS} FROM image_deliveries WHERE id = ?`).get(id);
  }

  /**
   * Moves a delivery forward (`queued` -> `rendered` -> `sending`) and says whether it did. Never backward
   * and never out of a terminal state, so a redelivered job cannot turn a `sending` row (the upload may
   * have landed) back into `rendered`. `advance(id, 'sending')` is the claim on the send: only the caller
   * that gets `true` may upload.
   */
  advance(id: string, state: 'rendered' | 'sending', at: number): boolean {
    const from = state === 'rendered' ? "('queued')" : "('queued','rendered')";
    return (
      this.db.run(`UPDATE image_deliveries SET state = ?, updated_at = ? WHERE id = ? AND state IN ${from}`, [
        state,
        at,
        id,
      ]).changes === 1
    );
  }

  /**
   * Records a rebuild BEFORE its render starts: the row's job, payload hash and job-id counter now describe
   * the rebuilt picture, so a process that dies meanwhile resumes that job and not the stale one already
   * rendered. Only a row whose upload was not claimed can be rebuilt; false when it was not in such a state.
   */
  rebuilt(id: string, job: { jobJson: string; payloadHash: string; rebuilds: number }, at: number): boolean {
    return (
      this.db.run(
        `UPDATE image_deliveries SET job_json = ?, payload_hash = ?, rebuilds = ?, updated_at = ?
         WHERE id = ? AND state IN ('queued','rendered')`,
        [job.jobJson, job.payloadHash, job.rebuilds, at, id],
      ).changes === 1
    );
  }

  /**
   * Ends a delivery: the payload is dropped, the message id kept. Terminal rows are never changed again.
   * `expired` and `superseded` say "never uploaded", so they only apply before the upload was claimed: a
   * `sending` row (the upload may have landed) can still end `delivered`, `unknown` or `failed`. False when
   * the row was not in a state that allows the move.
   */
  finish(
    id: string,
    state: 'delivered' | 'failed' | 'expired' | 'unknown' | 'superseded',
    at: number,
    messageId?: number,
  ): boolean {
    const from =
      state === 'expired' || state === 'superseded' ? "('queued','rendered')" : "('queued','rendered','sending')";
    return (
      this.db.run(
        `UPDATE image_deliveries SET state = ?, message_id = ?, job_json = NULL, updated_at = ?
         WHERE id = ? AND state IN ${from}`,
        [state, messageId ?? null, at, id],
      ).changes === 1
    );
  }

  /**
   * The claim on the one note of a failed or expired delivery, recorded BEFORE the note is sent: a note is
   * at most once. Only the caller that gets `true` sends it. A delivered, uncertain or superseded row never
   * yields one: the user must not be told a picture failed that arrived or may have.
   */
  markNoteSent(id: string): boolean {
    return (
      this.db.run(
        "UPDATE image_deliveries SET note_sent = 1 WHERE id = ? AND note_sent = 0 AND state IN ('failed','expired')",
        [id],
      ).changes === 1
    );
  }

  /** Deliveries a previous process left unfinished. */
  unfinished(): ImageDeliveryRow[] {
    return this.db
      .query<ImageDeliveryRow, []>(
        `SELECT ${COLUMNS} FROM image_deliveries WHERE state IN ('queued','rendered','sending') ORDER BY created_at`,
      )
      .all();
  }

  /** Failed or expired deliveries whose user was never told (the process died between `finish` and the note). */
  unnotified(): ImageDeliveryRow[] {
    return this.db
      .query<ImageDeliveryRow, []>(
        `SELECT ${COLUMNS} FROM image_deliveries WHERE state IN ('failed','expired') AND note_sent = 0 ORDER BY created_at`,
      )
      .all();
  }

  pruneOlderThan(before: number): void {
    this.db.run(`DELETE FROM image_deliveries WHERE state IN ${TERMINAL} AND updated_at < ?`, [before]);
  }
}
