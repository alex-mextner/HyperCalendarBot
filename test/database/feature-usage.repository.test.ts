import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../src/database/migrations.ts';
import { FeatureUsageRepository } from '../../src/database/repositories/feature-usage.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';

describe('FeatureUsageRepository', () => {
  let db: Database;
  let repo: FeatureUsageRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run('PRAGMA foreign_keys = ON');
    runMigrations(db, migrations);
    repo = new FeatureUsageRepository(db);
  });

  test('record creates a new entry', () => {
    repo.record(42, 'events_create');
    const row = repo.getOne(42, 'events_create');
    expect(row).not.toBeNull();
    expect(row!.use_count).toBe(1);
    expect(row!.feature_key).toBe('events_create');
  });

  test('record increments count on duplicate', () => {
    repo.record(42, 'events_create');
    repo.record(42, 'events_create');
    repo.record(42, 'events_create');
    const row = repo.getOne(42, 'events_create');
    expect(row!.use_count).toBe(3);
  });

  test('getForUser returns all features for a user', () => {
    repo.record(42, 'events_create');
    repo.record(42, 'reminders');
    repo.record(42, 'sharing');
    const rows = repo.getForUser(42);
    expect(rows).toHaveLength(3);
    const keys = rows.map((r) => r.feature_key).sort();
    expect(keys).toEqual(['events_create', 'reminders', 'sharing']);
  });

  test('getForUser returns empty array for unknown user', () => {
    expect(repo.getForUser(999)).toEqual([]);
  });

  test('getOne returns null for missing feature', () => {
    expect(repo.getOne(42, 'nonexistent')).toBeNull();
  });

  test('getStaleFeatures returns features used long ago with enough count', () => {
    repo.record(42, 'events_create');
    // Manually set last_used_at to 60 days ago and count to 10
    db.run(
      "UPDATE feature_usage SET use_count = 10, last_used_at = datetime('now', '-60 days') WHERE feature_key = 'events_create'",
    );
    repo.record(42, 'reminders'); // fresh, count=1

    const stale = repo.getStaleFeatures(42, 5, 30);
    expect(stale).toHaveLength(1);
    expect(stale[0]!.feature_key).toBe('events_create');
  });

  test('getStaleFeatures excludes recently used features', () => {
    repo.record(42, 'events_create');
    // count is high but last_used_at is now
    db.run("UPDATE feature_usage SET use_count = 20 WHERE feature_key = 'events_create'");

    const stale = repo.getStaleFeatures(42, 5, 30);
    expect(stale).toHaveLength(0);
  });

  test('getStaleFeatures excludes low-count features even if old', () => {
    repo.record(42, 'events_create');
    db.run("UPDATE feature_usage SET last_used_at = datetime('now', '-60 days') WHERE feature_key = 'events_create'");

    const stale = repo.getStaleFeatures(42, 5, 30);
    expect(stale).toHaveLength(0); // count=1, below minCount=5
  });

  test('getStaleFeatures includes feature past the threshold day', () => {
    repo.record(42, 'events_create');
    db.run(
      "UPDATE feature_usage SET use_count = 5, last_used_at = datetime('now', '-31 days') WHERE feature_key = 'events_create'",
    );

    const stale = repo.getStaleFeatures(42, 5, 30);
    expect(stale).toHaveLength(1);
    expect(stale[0]!.feature_key).toBe('events_create');
  });

  test('getStaleFeatures excludes feature within threshold window', () => {
    repo.record(42, 'events_create');
    db.run(
      "UPDATE feature_usage SET use_count = 10, last_used_at = datetime('now', '-29 days') WHERE feature_key = 'events_create'",
    );

    const stale = repo.getStaleFeatures(42, 5, 30);
    expect(stale).toHaveLength(0);
  });

  test('getStaleFeatures includes feature at exactly minCount threshold', () => {
    repo.record(42, 'sharing');
    db.run(
      "UPDATE feature_usage SET use_count = 5, last_used_at = datetime('now', '-60 days') WHERE feature_key = 'sharing'",
    );

    const stale = repo.getStaleFeatures(42, 5, 30);
    expect(stale).toHaveLength(1);
  });

  test('getStaleFeatures excludes feature one below minCount', () => {
    repo.record(42, 'sharing');
    db.run(
      "UPDATE feature_usage SET use_count = 4, last_used_at = datetime('now', '-60 days') WHERE feature_key = 'sharing'",
    );

    const stale = repo.getStaleFeatures(42, 5, 30);
    expect(stale).toHaveLength(0);
  });

  test('getStaleFeatures with minCount=0 returns any old feature', () => {
    repo.record(42, 'reminders');
    db.run(
      "UPDATE feature_usage SET use_count = 1, last_used_at = datetime('now', '-60 days') WHERE feature_key = 'reminders'",
    );

    const stale = repo.getStaleFeatures(42, 0, 30);
    expect(stale).toHaveLength(1);
  });

  test('getStaleFeatures returns empty for user with no usage', () => {
    const stale = repo.getStaleFeatures(999, 5, 30);
    expect(stale).toEqual([]);
  });

  test('different users have separate data', () => {
    repo.record(42, 'events_create');
    repo.record(99, 'events_create');
    repo.record(99, 'events_create');

    expect(repo.getOne(42, 'events_create')!.use_count).toBe(1);
    expect(repo.getOne(99, 'events_create')!.use_count).toBe(2);
  });
});
