import { Database } from 'bun:sqlite';
import { z } from 'zod';
import type { GeminiRateLimits } from '../../config/gemini-rate-limits.ts';

const MINUTE_MS = 60_000;
const RETENTION_MS = 172_800_000;
const stores = new Map<string, Database>();
const totals = z.object({ daily: z.number(), minute: z.number(), tokens: z.number() });
const pacificDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
export class GeminiBudgetExceeded extends Error {
  constructor(readonly reason: 'rpm' | 'tpm' | 'rpd') {
    super(`Gemini local ${reason} budget exhausted — request skipped without waiting`);
    this.name = 'GeminiBudgetExceeded';
  }
}
export class GeminiQuotaStorageError extends Error {
  constructor(cause: unknown) {
    super('Gemini local quota store unavailable — no HTTP request admitted', { cause });
    this.name = 'GeminiQuotaStorageError';
  }
}
export function isGeminiLocalSkip(error: unknown): boolean {
  return error instanceof GeminiBudgetExceeded || error instanceof GeminiQuotaStorageError;
}
export function closeGeminiQuotaStores(): void {
  for (const db of stores.values()) db.close();
  stores.clear();
}
function store(path: string): Database {
  const cached = stores.get(path);
  if (cached) return cached;
  if (stores.size >= 4) {
    const oldest = stores.keys().next().value;
    if (oldest !== undefined) {
      stores.get(oldest)?.close();
      stores.delete(oldest);
    }
  }
  const db = new Database(path);
  try {
    db.exec('PRAGMA busy_timeout=20; PRAGMA journal_mode=WAL;');
    db.exec(
      'CREATE TABLE IF NOT EXISTS gemini_usage (scope TEXT NOT NULL, day TEXT NOT NULL, at INTEGER NOT NULL, tokens INTEGER NOT NULL)',
    );
    db.exec('CREATE INDEX IF NOT EXISTS gemini_usage_scope ON gemini_usage(scope,day,at)');
    db.exec('CREATE INDEX IF NOT EXISTS gemini_usage_expiry ON gemini_usage(at)');
    stores.set(path, db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Reserve input tokens BEFORE each HTTP attempt, across keys/models sharing scope+DB. */
export function reserveGeminiBudget(path: string, budget: GeminiRateLimits, tokens: number, now = Date.now()): void {
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error('Invalid Gemini token estimate');
  try {
    const db = store(path);
    const day = pacificDay.format(new Date(now));
    db.transaction(() => {
      db.run('DELETE FROM gemini_usage WHERE at < ?', [now - RETENTION_MS]);
      const usage = totals.parse(
        db
          .query(
            'SELECT COALESCE(SUM(CASE WHEN day=? THEN 1 ELSE 0 END),0) AS daily, COALESCE(SUM(CASE WHEN at > ? THEN 1 ELSE 0 END),0) AS minute, COALESCE(SUM(CASE WHEN at > ? THEN tokens ELSE 0 END),0) AS tokens FROM gemini_usage WHERE scope=?',
          )
          .get(day, now - MINUTE_MS, now - MINUTE_MS, budget.scope),
      );
      if (usage.daily >= budget.rpd) throw new GeminiBudgetExceeded('rpd');
      if (usage.minute >= budget.rpm) throw new GeminiBudgetExceeded('rpm');
      if (usage.tokens + tokens > budget.tpm) throw new GeminiBudgetExceeded('tpm');
      db.run('INSERT INTO gemini_usage(scope,day,at,tokens) VALUES(?,?,?,?)', [budget.scope, day, now, tokens]);
    }).immediate();
  } catch (error) {
    if (isGeminiLocalSkip(error)) throw error;
    throw new GeminiQuotaStorageError(error);
  }
}
