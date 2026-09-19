import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type { Intent } from '../../database/types.ts';
import { IntentMatcher } from './intent-matcher.ts';
import { WorkflowSchema } from './workflow-schema.ts';
import { validateWorkflow } from './workflow-validator.ts';

export interface CanonicalSeed {
  canonical_name: string;
  pattern: string;
  workflow: object;
  phrases: string[];
  trigger_words: string[];
  source_message: string;
}
export interface SeedReplacementPlan {
  schemaVersion: 1;
  previousFingerprint: string;
  seedFingerprint: string;
  previousCount: number;
  targetCount: number;
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
}
const digest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
export function seedFingerprint(seed: readonly CanonicalSeed[]): string {
  const definitions = seed.map(({ canonical_name, pattern, workflow, phrases, trigger_words, source_message }) => ({
    canonical_name,
    pattern,
    workflow,
    phrases,
    trigger_words,
    source_message,
  }));
  return digest(definitions.sort((a, b) => a.canonical_name.localeCompare(b.canonical_name)));
}

export function intentRows(db: Database): Intent[] {
  return db.query<Intent, []>('SELECT * FROM intents ORDER BY id').all();
}
export function validateCanonicalSeed(seed: readonly CanonicalSeed[]): void {
  if (seed.length < 1 || seed.length > 256) throw new Error('Canonical seed count is out of bounds');
  const names = new Set<string>();
  const rows: Intent[] = [];
  for (const [index, item] of seed.entries()) {
    if (!/^basis\.[a-z0-9_.]+$/.test(item.canonical_name) || names.has(item.canonical_name))
      throw new Error('Canonical names must be unique and namespaced');
    names.add(item.canonical_name);
    const workflow = WorkflowSchema.parse(item.workflow);
    if (workflow.version !== 2) throw new Error(`${item.canonical_name}: explicit workflow v2 required`);
    const errors = validateWorkflow(workflow, item.pattern);
    if (errors.length) throw new Error(`${item.canonical_name}: ${errors.join('; ')}`);
    if (!item.pattern.startsWith('^') || !item.pattern.endsWith('$') || item.pattern.length > 8192)
      throw new Error(`${item.canonical_name}: finite anchored matcher required`);
    if (!item.phrases.length || !item.trigger_words.length) throw new Error('Examples and triggers are required');
    rows.push({
      id: index + 1,
      canonical_name: item.canonical_name,
      phrases: JSON.stringify(item.phrases),
      trigger_words: JSON.stringify(item.trigger_words),
      pattern: item.pattern,
      workflow: JSON.stringify(item.workflow),
      format: 'text',
      status: 'approved',
      source_message: item.source_message,
      created_at: '2000-01-01 00:00:00',
    });
  }
  const matcher = new IntentMatcher();
  matcher.load(rows);
  for (const [index, item] of seed.entries())
    for (const example of new Set([...item.phrases, item.source_message]))
      if (matcher.match(example)?.intentId !== index + 1)
        throw new Error(`${item.canonical_name}: example routing is not unique`);
}
export function planSeedReplacement(db: Database, seed: readonly CanonicalSeed[]): SeedReplacementPlan {
  validateCanonicalSeed(seed);
  const rows = intentRows(db);
  return {
    schemaVersion: 1,
    previousFingerprint: digest(rows),
    seedFingerprint: seedFingerprint(seed),
    previousCount: rows.length,
    targetCount: seed.length,
  };
}
function schemaContains(db: Database, name: string): boolean {
  return db.query('SELECT 1 FROM sqlite_master WHERE type=? AND name=?').get('table', name) !== null;
}
export function assertReplacementWindow(db: Database, now = Date.now()): void {
  if (db.query('SELECT 1 FROM sqlite_master WHERE type=? AND tbl_name=?').get('trigger', 'intents'))
    throw new Error('Intent triggers require separate review');
  if (
    schemaContains(db, 'workflow_sessions') &&
    db.query('SELECT 1 FROM workflow_sessions WHERE created_at>=?').get(now - 300000)
  )
    throw new Error('An active workflow needs to finish before seed replacement');
  for (const { name } of db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()) {
    const quoted = `"${name.replaceAll('"', '""')}"`;
    if (
      db
        .query<{ table: string }, []>(`PRAGMA foreign_key_list(${quoted})`)
        .all()
        .some((key) => key.table === 'intents')
    )
      throw new Error('Foreign-key references to intent IDs require explicit reconciliation');
  }
}
export function installedSeedFingerprint(db: Database): string | null {
  if (!schemaContains(db, 'intent_basis_manifest')) return null;
  return (
    db.query<{ fingerprint: string }, []>('SELECT fingerprint FROM intent_basis_manifest WHERE singleton=1').get()
      ?.fingerprint ?? null
  );
}
/** Requires an independent readable pre-change SQLite snapshot; no calendar table writes. */
export function applySeedReplacement(
  db: Database,
  seed: readonly CanonicalSeed[],
  plan: SeedReplacementPlan,
  backupPath: string,
) {
  validateCanonicalSeed(seed);
  if (seedFingerprint(seed) !== plan.seedFingerprint || seed.length !== plan.targetCount)
    throw new Error('Reviewed target seed changed');
  return db
    .transaction(() => {
      const rows = intentRows(db);
      if (installedSeedFingerprint(db) === plan.seedFingerprint) {
        try {
          const current = rows.map(({ canonical_name, pattern, workflow, phrases, trigger_words, source_message }) => ({
            canonical_name,
            pattern: pattern ?? '',
            workflow: JSON.parse(workflow),
            phrases: JSON.parse(phrases),
            trigger_words: JSON.parse(trigger_words ?? '[]'),
            source_message: source_message ?? '',
          }));
          if (seedFingerprint(current) === plan.seedFingerprint && rows.every((row) => row.status === 'approved'))
            return {
              status: 'already_installed',
              removed: 0,
              installed: rows.length,
              fingerprint: plan.seedFingerprint,
            };
        } catch {
          /* Broken active definitions are not an already installed seed. */
        }
      }
      if (rows.length !== plan.previousCount || digest(rows) !== plan.previousFingerprint)
        throw new Error('Current intent definitions changed after planning');
      assertReplacementWindow(db);
      const backup = new Database(backupPath, { readonly: true, create: false });
      try {
        if (digest(intentRows(backup)) !== plan.previousFingerprint)
          throw new Error('Verified backup does not match the plan');
        const checks = backup.query<{ quick_check: string }, []>('PRAGMA quick_check').all();
        if (checks.length !== 1 || checks[0]?.quick_check !== 'ok') throw new Error('Verified backup is corrupt');
      } finally {
        backup.close();
      }
      const beforeEvents = digest(db.query('SELECT * FROM events ORDER BY id').all());
      const beforeUsers = digest(db.query('SELECT * FROM users ORDER BY telegram_id').all());
      db.exec('DELETE FROM intents');
      const insert = db.prepare(
        'INSERT INTO intents(canonical_name,pattern,workflow,phrases,trigger_words,source_message,format,status) VALUES(?,?,?,?,?,?,?,?)',
      );
      for (const item of seed)
        insert.run(
          item.canonical_name,
          item.pattern,
          JSON.stringify(item.workflow),
          JSON.stringify(item.phrases),
          JSON.stringify(item.trigger_words),
          item.source_message,
          'text',
          'approved',
        );
      db.exec(
        'CREATE TABLE IF NOT EXISTS intent_basis_manifest (singleton INTEGER PRIMARY KEY CHECK(singleton=1), fingerprint TEXT NOT NULL, installed_at TEXT NOT NULL, rule_count INTEGER NOT NULL)',
      );
      db.run(
        "INSERT INTO intent_basis_manifest VALUES(1,?,datetime('now'),?) ON CONFLICT(singleton) DO UPDATE SET fingerprint=excluded.fingerprint,installed_at=excluded.installed_at,rule_count=excluded.rule_count",
        [plan.seedFingerprint, seed.length],
      );
      if (
        digest(db.query('SELECT * FROM events ORDER BY id').all()) !== beforeEvents ||
        digest(db.query('SELECT * FROM users ORDER BY telegram_id').all()) !== beforeUsers
      )
        throw new Error('Unexpected calendar/profile change; rolling back');
      const installed = intentRows(db);
      if (installed.length !== seed.length || installed.some((row) => row.status !== 'approved'))
        throw new Error('Installed catalogue verification failed');
      return {
        status: 'replaced',
        removed: rows.length,
        installed: installed.length,
        fingerprint: plan.seedFingerprint,
      };
    })
    .immediate();
}
