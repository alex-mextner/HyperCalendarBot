#!/usr/bin/env bun
import { Database } from 'bun:sqlite';
import { migrations } from '../src/database/migrations.ts';
import { runMigrations } from '../src/database/schema.ts';

const path = process.env.DATABASE_PATH ?? '/app/data/calendar.db';
const db = new Database(path);
try {
  runMigrations(db, migrations);
} finally {
  db.close();
}
