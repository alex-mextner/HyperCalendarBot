// Sidecar SQLite file holding the learning queue, artifacts, proposals, the revision ledger, the
// persisted rate bucket, audit and the admin outbox. The main calendar database is never migrated.
import { Database } from 'bun:sqlite';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

export const SIDECAR_SCHEMA_VERSION = '1';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_key TEXT NOT NULL,
  actor_id INTEGER NOT NULL,
  chat_id INTEGER NOT NULL,
  message_id INTEGER,
  dedup_key TEXT NOT NULL UNIQUE,
  request TEXT NOT NULL,
  previous_ai_response TEXT NOT NULL,
  tool_calls TEXT NOT NULL,
  tool_results TEXT NOT NULL,
  recent_messages TEXT NOT NULL,
  eligible INTEGER NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS samples_scope ON samples(scope_key, last_seen);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('scoped', 'corpus')),
  status TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('generate', 'verify')),
  round INTEGER NOT NULL DEFAULT 1,
  transient_failures INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL,
  lease_hash TEXT,
  lease_expires_at INTEGER,
  lease_started_at INTEGER,
  lease_worker TEXT,
  proposal_id INTEGER,
  last_review TEXT,
  last_error_class TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, due_at, created_at, id);
CREATE TABLE IF NOT EXISTS job_samples (
  job_id INTEGER NOT NULL,
  sample_id INTEGER NOT NULL,
  required INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (job_id, sample_id)
);
CREATE TABLE IF NOT EXISTS stage_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  stage TEXT NOT NULL,
  round INTEGER NOT NULL,
  worker_id TEXT NOT NULL,
  lease_hash TEXT NOT NULL,
  session_id TEXT UNIQUE,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT
);
CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  stage TEXT NOT NULL,
  round INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  body TEXT NOT NULL,
  outcome TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS artifacts_session ON artifacts(session_id);
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER,
  origin TEXT NOT NULL CHECK (origin IN ('worker', 'manual')),
  status TEXT NOT NULL,
  hash TEXT NOT NULL,
  body TEXT NOT NULL,
  validation TEXT NOT NULL,
  base_fingerprint TEXT NOT NULL,
  target_fingerprint TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  review TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  decided_by TEXT
);
CREATE TABLE IF NOT EXISTS revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id INTEGER NOT NULL,
  root_fingerprint TEXT,
  base_fingerprint TEXT NOT NULL,
  target_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('activating', 'active', 'abandoned', 'conflict')),
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  acked_at INTEGER
);
CREATE INDEX IF NOT EXISTS revisions_target ON revisions(target_fingerprint, status);
CREATE TABLE IF NOT EXISTS lease_starts (at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS lease_starts_at ON lease_starts(at);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  job_id INTEGER,
  proposal_id INTEGER,
  detail TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dedup_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sent')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
`;

/** Opens (creating if needed) the sidecar with owner-only permissions. `:memory:` is for tests. */
export function openLearningStore(path: string): Database {
  const onDisk = path !== ':memory:';
  if (onDisk) {
    mkdirSync(dirname(path), { recursive: true });
    // Created 0600 before SQLite touches it: the -wal and -shm files copy the mode.
    closeSync(openSync(path, 'a', 0o600));
  }
  const db = new Database(path, { create: true });
  try {
    if (onDisk) chmodSync(path, 0o600);
    db.exec('PRAGMA busy_timeout = 3000');
    if (onDisk) db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA);
    db.run('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)', ['schema_version', SIDECAR_SCHEMA_VERSION]);
    const version = db.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?').get('schema_version');
    if (version?.value !== SIDECAR_SCHEMA_VERSION) throw new Error('Unsupported intent-learning sidecar schema');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function readMeta(db: Database, key: string): string | null {
  return db.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

export function writeMeta(db: Database, key: string, value: string): void {
  db.run('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
    key,
    value,
  ]);
}

export function appendAudit(
  db: Database,
  entry: {
    at: number;
    actor: string;
    action: string;
    jobId?: number | null;
    proposalId?: number | null;
    detail?: string;
  },
): void {
  db.run('INSERT INTO audit(at, actor, action, job_id, proposal_id, detail) VALUES (?, ?, ?, ?, ?, ?)', [
    entry.at,
    entry.actor,
    entry.action,
    entry.jobId ?? null,
    entry.proposalId ?? null,
    entry.detail ?? '',
  ]);
}
