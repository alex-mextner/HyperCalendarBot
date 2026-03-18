import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { SecretaryRepository } from '../../../src/database/repositories/secretary.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('SecretaryRepository', () => {
  let repo: SecretaryRepository;
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
    repo = new SecretaryRepository(db);
    const users = new UserRepository(db);
    for (const id of [1, 2, 5, 7, 10, 11, 12, 20, 99]) {
      users.create({ telegram_id: id });
    }
  });

  test('upsert creates new pending record', () => {
    const rec = repo.upsert({ owner_id: 1, secretary_id: 2, permission: 'read' });
    expect(rec.status).toBe('pending');
    expect(rec.permission).toBe('read');
  });

  test('upsert reuses existing pending record < 7 days', () => {
    const a = repo.upsert({ owner_id: 1, secretary_id: 2, permission: 'read' });
    const b = repo.upsert({ owner_id: 1, secretary_id: 2, permission: 'write' });
    expect(a.id).toBe(b.id);
  });

  test('updateStatus changes status', () => {
    const rec = repo.upsert({ owner_id: 1, secretary_id: 2, permission: 'write' });
    const ok = repo.updateStatus(rec.id, 'active');
    expect(ok).toBe(true);
    expect(repo.findById(rec.id)!.status).toBe('active');
  });

  test('getActiveSecretaryFor returns only active entries for secretary', () => {
    repo.upsert({ owner_id: 10, secretary_id: 99, permission: 'write' });
    repo.updateStatus(repo.upsert({ owner_id: 10, secretary_id: 99, permission: 'write' }).id, 'active');
    const result = repo.getActiveSecretaryFor(99);
    expect(result.length).toBeGreaterThan(0);
  });

  test('getSecretariesForOwner returns all non-revoked for owner', () => {
    repo.upsert({ owner_id: 5, secretary_id: 11, permission: 'read' });
    repo.upsert({ owner_id: 5, secretary_id: 12, permission: 'write' });
    const list = repo.getSecretariesForOwner(5);
    expect(list.length).toBe(2);
  });

  test('countActive returns count of active secretaries for owner', () => {
    const r = repo.upsert({ owner_id: 7, secretary_id: 20, permission: 'read' });
    repo.updateStatus(r.id, 'active');
    expect(repo.countActive(7)).toBe(1);
  });

  test('upsert ON CONFLICT resets declined/revoked to pending and returns correct row', () => {
    // Create initial record and decline it
    const first = repo.upsert({ owner_id: 1, secretary_id: 2, permission: 'read' });
    repo.updateStatus(first.id, 'declined');

    // Insert another record so lastInsertRowid would point to a different id if the bug exists
    repo.upsert({ owner_id: 5, secretary_id: 11, permission: 'read' });

    // Upsert again — triggers ON CONFLICT DO UPDATE on the declined row
    const reset = repo.upsert({ owner_id: 1, secretary_id: 2, permission: 'write' });

    expect(reset.id).toBe(first.id);
    expect(reset.status).toBe('pending');
    expect(reset.permission).toBe('write');
  });
});
