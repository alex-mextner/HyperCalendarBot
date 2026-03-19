import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { TriggerRepository } from '../../../src/services/scheduled/trigger.repository.ts';

function makeDb() {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  return db;
}

describe('TriggerRepository', () => {
  test('create and findEnabled', () => {
    const repo = new TriggerRepository(makeDb());
    const id = repo.create({
      userId: 1,
      topic: 'myCalendar.newEvent',
      action: 'call me',
      label: null,
      condition: null,
      once: false,
    });
    const results = repo.findEnabled(1, 'myCalendar.newEvent');
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe(id);
    expect(results[0]!.action).toBe('call me');
  });

  test('findEnabled excludes disabled', () => {
    const db = makeDb();
    const repo = new TriggerRepository(db);
    const id = repo.create({
      userId: 1,
      topic: 'myCalendar.newEvent',
      action: 'x',
      label: null,
      condition: null,
      once: false,
    });
    repo.disable(id);
    expect(repo.findEnabled(1, 'myCalendar.newEvent')).toHaveLength(0);
  });

  test('incrementFireCount and disable atomically', () => {
    const db = makeDb();
    const repo = new TriggerRepository(db);
    const id = repo.create({
      userId: 1,
      topic: 'myCalendar.newEvent',
      action: 'x',
      label: null,
      condition: null,
      once: true,
    });
    repo.recordFire(id, true);
    const results = repo.findEnabled(1, 'myCalendar.newEvent');
    expect(results).toHaveLength(0); // disabled
    const all = repo.listByUser(1);
    expect(all[0]!.fire_count).toBe(1);
    expect(all[0]!.enabled).toBe(0);
  });

  test('countEnabled respects limit check', () => {
    const db = makeDb();
    const repo = new TriggerRepository(db);
    for (let i = 0; i < 3; i++) {
      repo.create({ userId: 1, topic: 'myCalendar.newEvent', action: 'x', label: null, condition: null, once: false });
    }
    expect(repo.countEnabled(1)).toBe(3);
  });

  test('remove deletes trigger', () => {
    const db = makeDb();
    const repo = new TriggerRepository(db);
    const id = repo.create({
      userId: 1,
      topic: 'myCalendar.newEvent',
      action: 'x',
      label: null,
      condition: null,
      once: false,
    });
    repo.remove(id, 1);
    expect(repo.listByUser(1)).toHaveLength(0);
  });
});
