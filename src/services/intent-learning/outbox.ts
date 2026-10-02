// Durable admin notifications for lifecycle transitions only (proposal ready, needs revision,
// activated, conflict, provider pause). Each transition is keyed once; polls and retries never add rows.
import { z } from 'zod';
import { jsonCodec } from '../../utils/json-codec.ts';
import { cmdLogger } from '../../utils/logger.ts';
import type { LearningContext } from './context.ts';

export type NotificationKind = 'proposal_ready' | 'needs_admin_revision' | 'activated' | 'conflict' | 'worker_paused';

export interface AdminNotification {
  id: number;
  kind: NotificationKind;
  text: string;
  proposalId?: number;
  jobId?: number;
  /** First 16 hex characters of the proposal hash; enough for `approve` from a chat button. */
  hashPrefix?: string;
}

const PayloadJson = jsonCodec(
  z.object({
    text: z.string(),
    proposalId: z.number().optional(),
    jobId: z.number().optional(),
    hashPrefix: z.string().optional(),
  }),
);

export function queueNotification(
  ctx: LearningContext,
  kind: NotificationKind,
  dedupKey: string,
  payload: Omit<AdminNotification, 'id' | 'kind'>,
): void {
  ctx.store.run(
    "INSERT OR IGNORE INTO outbox(dedup_key, kind, payload, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
    [dedupKey, kind, JSON.stringify(payload), ctx.now()],
  );
}

interface OutboxRow {
  id: number;
  kind: NotificationKind;
  payload: string;
}

/** Sends pending notifications in order; a failed send stays pending for the next drain. */
export async function drainOutbox(
  ctx: LearningContext,
  send: (notification: AdminNotification) => Promise<void>,
  limit = 10,
): Promise<{ sent: number; failed: number }> {
  const rows = ctx.store
    .query<OutboxRow, [number]>("SELECT id, kind, payload FROM outbox WHERE status = 'pending' ORDER BY id LIMIT ?")
    .all(limit);
  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    const payload = PayloadJson.safeParse(row.payload);
    if (!payload.success) {
      cmdLogger.error(
        { outboxId: row.id },
        'Intent-learning outbox row is unreadable; marking it sent to stop retries',
      );
      ctx.store.run("UPDATE outbox SET status = 'sent', sent_at = ? WHERE id = ?", [ctx.now(), row.id]);
      continue;
    }
    try {
      await send({ id: row.id, kind: row.kind, ...payload.data });
      ctx.store.run("UPDATE outbox SET status = 'sent', sent_at = ? WHERE id = ?", [ctx.now(), row.id]);
      sent++;
    } catch (err) {
      ctx.store.run('UPDATE outbox SET attempts = attempts + 1 WHERE id = ?', [row.id]);
      cmdLogger.warn({ err, outboxId: row.id }, 'Intent-learning admin notification failed; kept pending');
      failed++;
    }
  }
  return { sent, failed };
}
