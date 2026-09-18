// Usage: bun --no-env-file scripts/intent-catalog-report.ts --db existing.db --out /private/report --revision SHA
// Never imports or runs seed-intents.ts. Output is private aggregate data, not a new website route.
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { collectIntentSnapshot } from '../src/services/intent/catalog-audit.ts';
import { seedIntents } from '../src/services/intent/seed-catalog.ts';
import { renderIntentCatalogue } from './intent-catalogue-page.ts';

const args = process.argv.slice(2);
function flag(name: string) {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
}
const path = flag('--db');
const output = flag('--out');
const revision = flag('--revision');
if (!path || (!output && !args.includes('--stdout')) || !revision || !existsSync(path))
  throw new Error('Provide --db existing-file --out private-directory --revision source-sha');
const db = new Database(path, { readonly: true });
try {
  db.exec('PRAGMA query_only=ON');
  const snapshot = collectIntentSnapshot(db, seedIntents, { sourceRevision: revision });
  if (args.includes('--stdout')) {
    console.log(JSON.stringify(snapshot));
  } else {
    const dir = resolve(output!);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    for (const [name, content] of [
      ['intents-snapshot.json', JSON.stringify(snapshot, null, 2)],
      ['intents.html', renderIntentCatalogue(snapshot)],
    ] as const) {
      const file = resolve(dir, name);
      writeFileSync(file, content, { mode: 0o600 });
      chmodSync(file, 0o600);
    }
    console.log(
      JSON.stringify({
        output: dir,
        total: snapshot.totals.database,
        seeds: snapshot.totals.seed,
        rawMessagesExported: false,
      }),
    );
  }
} finally {
  db.close();
}
