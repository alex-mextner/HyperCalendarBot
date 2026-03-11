// src/database/schema.ts
import type { Database } from 'bun:sqlite';
import { dbLogger } from '../utils/logger.ts';

export interface Migration {
  name: string;
  up: (db: Database) => void;
}

export function runMigrations(db: Database, migrations: Migration[]): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set((db.prepare('SELECT name FROM migrations').all() as { name: string }[]).map((r) => r.name));

  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;

    dbLogger.info({ migration: migration.name }, 'Applying migration');
    db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO migrations (name) VALUES (?)').run(migration.name);
    })();
    dbLogger.info({ migration: migration.name }, 'Migration applied');
  }
}
