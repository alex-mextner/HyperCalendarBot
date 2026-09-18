import { Database } from 'bun:sqlite';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ args: process.argv.slice(2), options: { database: { type: 'string' } }, strict: true });
if (!values.database) throw new Error('--database is required; inspection is read-only');
const db = new Database(values.database, { readonly: true, create: false });
try {
  db.exec('PRAGMA query_only=ON; BEGIN;');
  const runtime = db
    .query<{ version: string; equivalent: number }, []>(
      "SELECT sqlite_version() AS version, julianday('2035-01-02T14:00:00+02:00') = julianday('2035-01-02 12:00:00') AS equivalent",
    )
    .get();
  const events = db
    .query<{ activeRows: number; invalidStart: number; invalidEnd: number; invalidOriginal: number }, []>(
      'SELECT COUNT(*) AS activeRows, COALESCE(SUM(julianday(start_at) IS NULL),0) AS invalidStart, COALESCE(SUM(end_at IS NOT NULL AND julianday(end_at) IS NULL),0) AS invalidEnd, COALESCE(SUM(original_start_at IS NOT NULL AND julianday(original_start_at) IS NULL),0) AS invalidOriginal FROM events WHERE is_deleted=0',
    )
    .get();
  const members = db
    .query<{ rows: number; invalidJoined: number }, []>(
      'SELECT COUNT(*) AS rows, COALESCE(SUM(julianday(joined_at) IS NULL),0) AS invalidJoined FROM group_members',
    )
    .get();
  const ok =
    runtime?.equivalent === 1 &&
    events !== null &&
    members !== null &&
    events.invalidStart + events.invalidEnd + events.invalidOriginal + members.invalidJoined === 0;
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), ok, runtime, events, members }, null, 2));
  if (!ok) process.exitCode = 1;
} finally {
  db.close();
}
