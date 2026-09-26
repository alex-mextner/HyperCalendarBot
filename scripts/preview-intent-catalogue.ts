// Generates only synthetic fixtures; never reads a production DB or sends requests.
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectIntentSnapshot } from '../src/services/intent/catalog-audit.ts';
import { seedIntents } from '../src/services/intent/seed-catalog.ts';
import { renderIntentCatalogue } from './intent-catalogue-page.ts';

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
  const snapshot = collectIntentSnapshot(db, seedIntents, {
    sourceRevision: 'synthetic',
    capturedAt: '2026-01-01T00:00:00.000Z',
  });
  const out = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'hcb-intent-catalogue-'));
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/index.html`, renderIntentCatalogue(snapshot, true));
  console.log(out);
} finally {
  db.close();
}
