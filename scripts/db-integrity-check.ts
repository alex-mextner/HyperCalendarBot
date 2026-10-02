#!/usr/bin/env bun
import { Database } from 'bun:sqlite';
import { z } from 'zod';

const path = process.env.DATABASE_PATH ?? '/app/data/calendar.db';
const db = new Database(path, { readonly: true });
try {
  const quick = z.object({ quick_check: z.string() }).parse(db.query('PRAGMA quick_check').get());
  const foreignKeys = db.query('PRAGMA foreign_key_check').all();
  if (quick.quick_check !== 'ok' || foreignKeys.length !== 0) {
    console.error(JSON.stringify({ quickCheck: quick.quick_check, foreignKeyViolations: foreignKeys.length }));
    process.exit(1);
  }
  console.log('ok\t0');
} finally {
  db.close();
}
