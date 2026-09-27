// Generates only synthetic fixtures; never reads a production DB or sends requests.
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectIntentSnapshot, type IntentSnapshot } from '../src/services/intent/catalog-audit.ts';
import { seedIntents } from '../src/services/intent/seed-catalog.ts';
import { renderIntentCatalogue } from './intent-catalogue-page.ts';

/** Every shipped seed as an approved row in a throwaway in-memory database. */
export function syntheticIntentSnapshot(): IntentSnapshot {
  const db = new Database(':memory:');
  try {
    db.exec(
      'CREATE TABLE intents (id INTEGER PRIMARY KEY, canonical_name TEXT, phrases TEXT, trigger_words TEXT, pattern TEXT, workflow TEXT, format TEXT, status TEXT, created_at TEXT)',
    );
    for (const [i, s] of seedIntents.entries())
      db.query('INSERT INTO intents VALUES(?,?,?,?,?,?,?,?,?)').run(
        i + 1,
        s.canonical_name,
        JSON.stringify(s.phrases),
        JSON.stringify(s.trigger_words),
        s.pattern,
        JSON.stringify(s.workflow),
        'text',
        'approved',
        '2026-01-01 00:00:00',
      );
    return collectIntentSnapshot(db, seedIntents, {
      sourceRevision: 'synthetic',
      capturedAt: '2026-01-01T00:00:00.000Z',
    });
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const out = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'hcb-intent-catalogue-'));
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/index.html`, renderIntentCatalogue(syntheticIntentSnapshot(), true));
  console.log(out);
}
