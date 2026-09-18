// scripts/seed-intents.ts — seed standard intents into calendar.db
// Run: bun scripts/seed-intents.ts

import { Database } from 'bun:sqlite';
import { seedIntents as intents } from '../src/services/intent/seed-catalog.ts';

const db = new Database('data/calendar.db');

const upsert = db.prepare(`
  INSERT INTO intents (canonical_name, phrases, trigger_words, pattern, workflow, format, status, source_message, created_at)
  VALUES (?, ?, ?, ?, ?, 'text', 'approved', ?, datetime('now'))
  ON CONFLICT(canonical_name) DO UPDATE SET
    phrases       = excluded.phrases,
    trigger_words = excluded.trigger_words,
    pattern       = excluded.pattern,
    workflow      = excluded.workflow,
    format        = 'text',
    status        = 'approved'
`);

let added = 0;
let updated = 0;

for (const intent of intents) {
  const existing = db.query('SELECT id FROM intents WHERE canonical_name = ?').get(intent.canonical_name);
  upsert.run(
    intent.canonical_name,
    JSON.stringify(intent.phrases),
    JSON.stringify(intent.trigger_words),
    intent.pattern,
    JSON.stringify(intent.workflow),
    intent.source_message,
  );
  if (existing) {
    console.log(`↺  updated: ${intent.canonical_name}`);
    updated++;
  } else {
    console.log(`+  added:   ${intent.canonical_name}`);
    added++;
  }
}

console.log(`\nDone: ${added} added, ${updated} updated.`);
const total = (db.query('SELECT COUNT(*) as n FROM intents').get() as { n: number }).n;
console.log(`Total intents in DB: ${total}`);
