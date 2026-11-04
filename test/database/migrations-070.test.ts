import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migrations } from '../../src/database/migrations.ts';
import {
  ImageDeliveryRepository,
  type NewImageDelivery,
} from '../../src/database/repositories/image-delivery.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';

const base: NewImageDelivery = {
  id: 'img-1',
  chatId: 5,
  language: 'en',
  kind: 'day',
  label: '2026-11-02',
  jobType: 'daily-agenda',
  slot: 'day:user:5:2026-11-02:en',
  payloadHash: '123',
  jobJson: '{}',
  createdAt: 1_000,
  expiresAt: 151_000,
};

function repo() {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  return { db, repo: new ImageDeliveryRepository(db) };
}

describe('070_image_deliveries', () => {
  test('creates the table with its state constraint', () => {
    const { db } = repo();
    expect(migrations.map((m) => m.name)).toContain('070_image_deliveries');
    db.run(
      "INSERT INTO image_deliveries (id, chat_id, language, kind, label, job_type, slot, payload_hash, state, created_at, expires_at, updated_at) VALUES ('a', 1, 'en', 'day', 'x', 'daily-agenda', 's', 'h', 'queued', 1, 2, 1)",
    );
    expect(() => db.run("UPDATE image_deliveries SET state = 'bogus'")).toThrow();
  });
});

describe('ImageDeliveryRepository', () => {
  test('keeps the slot and the payload hash, so a recovered delivery still dedupes against a later request', () => {
    const { repo: r } = repo();
    r.insert(base);
    expect(r.get('img-1')).toMatchObject({ slot: 'day:user:5:2026-11-02:en', payload_hash: '123' });
    expect(r.unfinished()[0]).toMatchObject({ slot: 'day:user:5:2026-11-02:en', payload_hash: '123' });
    r.finish('img-1', 'delivered', 2_000, 5);
    expect(r.get('img-1')).toMatchObject({ slot: 'day:user:5:2026-11-02:en', payload_hash: '123' });
  });

  test('a rebuild is recorded before its render: a restart resumes the rebuilt job, not the stale one', () => {
    const { repo: r } = repo();
    r.insert(base);
    expect(r.get('img-1')).toMatchObject({ rebuilds: 0, job_json: '{}' });
    expect(r.rebuilt('img-1', { jobJson: '{"v":2}', payloadHash: '456', rebuilds: 1 }, 2_000)).toBe(true);
    expect(r.unfinished()[0]).toMatchObject({ job_json: '{"v":2}', payload_hash: '456', rebuilds: 1 });
    r.advance('img-1', 'rendered', 3_000);
    expect(r.rebuilt('img-1', { jobJson: '{"v":3}', payloadHash: '789', rebuilds: 2 }, 3_500)).toBe(true);
    expect(r.get('img-1')).toMatchObject({ state: 'rendered', rebuilds: 2 });
  });

  test('a row whose upload was claimed, or that ended, is never rebuilt', () => {
    const { repo: r } = repo();
    r.insert(base);
    r.insert({ ...base, id: 'img-2' });
    r.advance('img-1', 'sending', 2_000);
    r.finish('img-2', 'failed', 2_000);
    expect(r.rebuilt('img-1', { jobJson: '{"v":2}', payloadHash: '456', rebuilds: 1 }, 3_000)).toBe(false);
    expect(r.rebuilt('img-2', { jobJson: '{"v":2}', payloadHash: '456', rebuilds: 1 }, 3_000)).toBe(false);
    expect(r.get('img-1')).toMatchObject({ job_json: '{}', payload_hash: '123', rebuilds: 0 });
    expect(r.get('img-2')).toMatchObject({ job_json: null, rebuilds: 0 });
  });

  test('an id already recorded in any state is a duplicate, so a replay never sends twice', () => {
    const { repo: r } = repo();
    expect(r.insert(base)).toBe(true);
    expect(r.insert(base)).toBe(false);
    r.advance('img-1', 'sending', 2_000);
    expect(r.insert(base)).toBe(false);
    r.finish('img-1', 'unknown', 3_000); // the upload may have landed
    expect(r.insert(base)).toBe(false);
    expect(r.get('img-1')?.state).toBe('unknown');
  });

  test('a replay of a delivered request keeps the recorded Telegram message id', () => {
    const { repo: r } = repo();
    r.insert(base);
    r.finish('img-1', 'delivered', 3_000, 77);
    expect(r.insert(base)).toBe(false);
    expect(r.get('img-1')).toMatchObject({ state: 'delivered', message_id: 77 });
  });

  test('a terminal row never changes again and drops its payload', () => {
    const { repo: r } = repo();
    r.insert(base);
    r.finish('img-1', 'delivered', 2_000, 77);
    r.finish('img-1', 'failed', 3_000);
    r.advance('img-1', 'sending', 4_000);
    expect(r.get('img-1')).toMatchObject({
      state: 'delivered',
      message_id: 77,
      job_json: null,
    });
  });

  test('transitions only move forward and advance(sending) is a single claim', () => {
    const { repo: r } = repo();
    r.insert(base);
    expect(r.advance('img-1', 'rendered', 2_000)).toBe(true);
    expect(r.advance('img-1', 'rendered', 2_100)).toBe(false); // a second attempt cannot re-record it
    expect(r.advance('img-1', 'sending', 3_000)).toBe(true);
    expect(r.advance('img-1', 'sending', 3_100)).toBe(false); // the second claimant must not upload
    expect(r.advance('img-1', 'rendered', 3_200)).toBe(false); // a redelivered job cannot undo `sending`
    expect(r.get('img-1')?.state).toBe('sending');
  });

  test('a terminal row cannot be claimed, and finish says whether it took effect', () => {
    const { repo: r } = repo();
    r.insert(base);
    expect(r.finish('img-1', 'expired', 2_000)).toBe(true);
    expect(r.advance('img-1', 'sending', 3_000)).toBe(false);
    expect(r.finish('img-1', 'delivered', 4_000, 9)).toBe(false);
    expect(r.get('img-1')).toMatchObject({ state: 'expired', message_id: null });
  });

  test('unnotified lists failed and expired rows whose note was never recorded', () => {
    const { repo: r } = repo();
    for (const id of ['a', 'b', 'c', 'd']) r.insert({ ...base, id });
    r.finish('a', 'failed', 2_000);
    r.finish('b', 'expired', 2_000);
    r.finish('c', 'unknown', 2_000); // an uncertain send: the user is never told it failed
    r.markNoteSent('b');
    expect(r.unnotified().map((row) => row.id)).toEqual(['a']);
  });

  test('a row whose upload was claimed is never ended as expired or superseded', () => {
    const { repo: r } = repo();
    r.insert(base);
    r.advance('img-1', 'sending', 2_000);
    expect(r.finish('img-1', 'expired', 3_000)).toBe(false);
    expect(r.finish('img-1', 'superseded', 3_000)).toBe(false);
    expect(r.get('img-1')?.state).toBe('sending');
    expect(r.finish('img-1', 'delivered', 4_000, 41)).toBe(true); // the upload that landed is still recorded
    expect(r.get('img-1')).toMatchObject({ state: 'delivered', message_id: 41 });
  });

  test('the note is claimed once: the second caller must not send it', () => {
    const { repo: r } = repo();
    r.insert(base);
    r.finish('img-1', 'failed', 2_000);
    expect(r.markNoteSent('img-1')).toBe(true);
    expect(r.markNoteSent('img-1')).toBe(false);
  });

  test('a delivered or uncertain row never yields a failure note', () => {
    const { repo: r } = repo();
    r.insert(base);
    r.insert({ ...base, id: 'img-2' });
    r.finish('img-1', 'delivered', 2_000, 5);
    r.finish('img-2', 'unknown', 2_000);
    expect(r.markNoteSent('img-1')).toBe(false);
    expect(r.markNoteSent('img-2')).toBe(false);
  });

  test('unfinished lists only live rows; terminal rows are pruned by age', () => {
    const { repo: r } = repo();
    r.insert(base);
    r.insert({ ...base, id: 'img-2' });
    r.finish('img-2', 'failed', 2_000);
    expect(r.unfinished().map((row) => row.id)).toEqual(['img-1']);
    r.pruneOlderThan(10_000);
    expect(r.get('img-2')).toBeNull();
    expect(r.get('img-1')).not.toBeNull();
  });
});
