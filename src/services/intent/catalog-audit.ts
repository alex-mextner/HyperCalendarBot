import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type { Intent } from '../../database/types.ts';
import { IntentMatcher } from './intent-matcher.ts';
import type { seedIntents } from './seed-catalog.ts';
import { WorkflowSchema } from './workflow-schema.ts';
import { validateWorkflow } from './workflow-validator.ts';

type Seed = (typeof seedIntents)[number];
type Raw = Pick<
  Intent,
  'id' | 'canonical_name' | 'phrases' | 'trigger_words' | 'pattern' | 'workflow' | 'format' | 'status' | 'created_at'
>;
export const CATALOGUE_LIMIT = 5000;
export const MAX_INPUT_LENGTH = 16000;
export const MAX_INTENT_ROWS = 2000;
export const MAX_HISTORY_LIMIT = 20000;
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function hash(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}
function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
function calls(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const w = value as { steps?: unknown; tools?: unknown };
  const rows = Array.isArray(w.steps) ? w.steps : Array.isArray(w.tools) ? w.tools : [];
  return [
    ...new Set(
      rows.flatMap((row: unknown) => {
        if (!row || typeof row !== 'object') return [];
        const r = row as { call?: unknown; name?: unknown };
        const name = r.call ?? r.name;
        return typeof name === 'string' && /^[a-z][a-z0-9_]{0,80}$/.test(name) ? [name] : [];
      }),
    ),
  ];
}
function definition(raw: Raw) {
  return {
    phrases: parse(raw.phrases),
    trigger_words: parse(raw.trigger_words),
    pattern: raw.pattern,
    workflow: parse(raw.workflow),
    format: raw.format,
  };
}
function seedDefinition(seed: Seed) {
  return {
    phrases: seed.phrases,
    trigger_words: seed.trigger_words,
    pattern: seed.pattern,
    workflow: seed.workflow,
    format: 'text',
  };
}
function matcher(seeds: Seed[]): IntentMatcher {
  const m = new IntentMatcher();
  m.load(
    seeds.map(
      (s, i) =>
        ({
          id: i + 1,
          canonical_name: s.canonical_name,
          phrases: JSON.stringify(s.phrases),
          trigger_words: JSON.stringify(s.trigger_words),
          pattern: s.pattern,
          workflow: JSON.stringify(s.workflow),
          format: 'text',
          status: 'approved',
          source_message: null,
          created_at: '',
        }) satisfies Intent,
    ),
  );
  return m;
}
export function auditDefinition(seed: Seed) {
  const parsed = WorkflowSchema.safeParse(seed.workflow);
  const errors = parsed.success ? validateWorkflow(parsed.data, seed.pattern) : [];
  const required = [
    ...new Set([...JSON.stringify(seed.workflow).matchAll(/\{\{(\$\d+)(?:\||\}\})/g)].map((m) => m[1]!)),
  ];
  const m = matcher([seed]);
  let matched = 0;
  let missing = 0;
  for (const phrase of seed.phrases) {
    const result = m.match(phrase);
    if (result) {
      matched++;
      if (required.some((c) => result.captures[c] === undefined)) missing++;
    }
  }
  return {
    schemaValid: parsed.success,
    contractErrors: errors.length,
    tools: calls(seed.workflow),
    requiredCaptures: required,
    exampleCount: seed.phrases.length,
    examplesMatched: matched,
    examplesMissingCaptures: missing,
  };
}
function tableExists(db: Database, table: string): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
}
function extendWindow(window: { first: string | null; last: string | null }, timestamp: string): void {
  if (window.first === null || timestamp < window.first) window.first = timestamp;
  if (window.last === null || timestamp > window.last) window.last = timestamp;
}
function count(db: Database, sql: string): number {
  return (db.query(sql).get() as { n: number }).n;
}
export function collectIntentSnapshot(
  db: Database,
  seeds: Seed[],
  options: { sourceRevision: string; maxHistory?: number; capturedAt?: string },
) {
  const maxHistory = options.maxHistory ?? CATALOGUE_LIMIT;
  if (!Number.isSafeInteger(maxHistory) || maxHistory < 1 || maxHistory > MAX_HISTORY_LIMIT)
    throw new Error('maxHistory must be 1..20000');
  const ownsTransaction = !db.inTransaction;
  if (ownsTransaction) db.exec('BEGIN');
  try {
    if (count(db, 'SELECT COUNT(*) n FROM intents') > MAX_INTENT_ROWS)
      throw new Error('Intent catalogue exceeds 2000 rows; use a bounded migration audit');
    const raw = db
      .query(
        'SELECT id,canonical_name,phrases,trigger_words,pattern,workflow,format,status,created_at FROM intents ORDER BY id',
      )
      .all() as Raw[];
    const logsAvailable = tableExists(db, 'user_action_log');
    const historyAvailable = tableExists(db, 'chat_history');
    const byName = new Map(raw.map((r) => [r.canonical_name, r]));
    const knownNames = new Set(seeds.map((s) => s.canonical_name));
    const records = logsAvailable
      ? (db
          .query(
            "SELECT action_name, COUNT(*) n, MIN(created_at) first, MAX(created_at) last FROM user_action_log WHERE action_type='intent_match' GROUP BY action_name",
          )
          .all() as { action_name: string; n: number; first: string; last: string }[])
      : [];
    const matches = new Map(records.map((r) => [r.action_name, r]));
    const inputColumn =
      logsAvailable &&
      (db.query('PRAGMA table_info(user_action_log)').all() as { name: string }[]).some(
        (c) => c.name === 'input_summary',
      );
    const evidence = inputColumn
      ? (db
          .query(
            "SELECT input_summary,action_name FROM user_action_log WHERE action_type='intent_match' AND input_summary IS NOT NULL ORDER BY created_at DESC,rowid DESC LIMIT ?",
          )
          .all(CATALOGUE_LIMIT) as { input_summary: string; action_name: string }[])
      : [];
    const currentMatcher = matcher(seeds);
    let evidenceOversized = 0;
    let evidenceMatched = 0;
    let evidenceSame = 0;
    for (const row of evidence) {
      if (row.input_summary.length > MAX_INPUT_LENGTH) {
        evidenceOversized++;
        continue;
      }
      const hit = currentMatcher.match(row.input_summary);
      if (hit) {
        evidenceMatched++;
        if (seeds[hit.intentId - 1]?.canonical_name === row.action_name) evidenceSame++;
      }
    }

    const logWindow = logsAvailable
      ? (db.query('SELECT MIN(created_at) first,MAX(created_at) last,COUNT(*) n FROM user_action_log').get() as {
          first: string | null;
          last: string | null;
          n: number;
        })
      : null;
    const toolRecords = logsAvailable
      ? (db
          .query(
            "SELECT action_name,success,COUNT(*) n FROM user_action_log WHERE action_type='ai_tool' GROUP BY action_name,success ORDER BY n DESC",
          )
          .all() as { action_name: string; success: number; n: number }[])
      : [];
    const history = historyAvailable
      ? (db
          .query("SELECT content,created_at FROM chat_history WHERE role='user' ORDER BY id DESC LIMIT ?")
          .all(maxHistory) as { content: string; created_at: string }[])
      : [];
    const retained = historyAvailable ? count(db, "SELECT COUNT(*) n FROM chat_history WHERE role='user'") : null;
    const replayCounts = new Map<number, number>();
    let matched = 0;
    let oversized = 0;
    let skippedActivity = 0;
    const examinedWindow: { first: string | null; last: string | null } = { first: null, last: null };
    for (const item of history) {
      // Do not execute untrusted learned regexes or workflows, and never retain the raw input in output.
      if (item.content.length > MAX_INPUT_LENGTH) {
        oversized++;
        continue;
      }
      const envelope = parse(item.content);
      if (envelope && typeof envelope === 'object') {
        skippedActivity++;
        continue;
      }
      extendWindow(examinedWindow, item.created_at);
      const hit = currentMatcher.match(item.content);
      if (hit) {
        matched++;
        replayCounts.set(hit.intentId, (replayCounts.get(hit.intentId) ?? 0) + 1);
      }
    }
    const seedsSummary = seeds.map((seed, i) => {
      const row = byName.get(seed.canonical_name);
      const d = seedDefinition(seed);
      const current = row ? definition(row) : null;
      const changedFields = current
        ? Object.keys(d).filter((k) => stable(current[k as keyof typeof current]) !== stable(d[k as keyof typeof d]))
        : [];
      return {
        name: seed.canonical_name,
        examples: seed.phrases,
        workflow: seed.workflow,
        tools: calls(seed.workflow),
        sourceFingerprint: hash(d),
        present: !!row,
        databaseId: row?.id ?? null,
        status: row?.status ?? null,
        definition: !row ? 'absent' : changedFields.length ? 'changed' : 'same',
        changedFields,
        createdAt: row?.created_at ?? null,
        recordedMatches: logsAvailable ? (matches.get(seed.canonical_name)?.n ?? 0) : null,
        lastMatch: matches.get(seed.canonical_name)?.last ?? null,
        replayMatches: historyAvailable ? (replayCounts.get(i + 1) ?? 0) : null,
        audit: auditDefinition(seed),
      };
    });
    const database = raw.map((row) => {
      const workflow = parse(row.workflow);
      const parsed = WorkflowSchema.safeParse(workflow);
      const tools = calls(workflow);
      const phraseData = parse(row.phrases);
      const errors = parsed.success ? validateWorkflow(parsed.data, row.pattern) : [];
      return {
        id: row.id,
        name: knownNames.has(row.canonical_name) ? row.canonical_name : `Накопленный #${row.id}`,
        seedName: knownNames.has(row.canonical_name) ? row.canonical_name : null,
        status: row.status,
        createdAt: row.created_at,
        phraseCount: Array.isArray(phraseData) ? phraseData.length : null,
        tools,
        schemaValid: parsed.success,
        contractErrors: errors.length,
        recordedMatches: logsAvailable ? (matches.get(row.canonical_name)?.n ?? 0) : null,
        lastMatch: matches.get(row.canonical_name)?.last ?? null,
      };
    });
    return {
      schemaVersion: 1,
      capturedAt: options.capturedAt ?? new Date().toISOString(),
      sourceRevision: options.sourceRevision,
      catalogueFingerprint: hash(seeds.map(seedDefinition)),
      totals: {
        database: raw.length,
        seed: seeds.length,
        approved: raw.filter((r) => r.status === 'approved').length,
        pending: raw.filter((r) => r.status === 'pending').length,
        rejected: raw.filter((r) => r.status === 'rejected').length,
        other: raw.filter((r) => !['approved', 'pending', 'rejected'].includes(r.status)).length,
      },
      seeds: seedsSummary,
      database,
      statistics: {
        logsAvailable,
        logWindow,
        recordedMatches: logsAvailable ? records.reduce((n, r) => n + r.n, 0) : null,
        executionSuccessRate: null,
        recordedInputReplay: {
          available: inputColumn,
          fetched: evidence.length,
          examined: evidence.length - evidenceOversized,
          skippedOversized: evidenceOversized,
          matched: evidenceMatched,
          sameIntent: evidenceSame,
          limit: CATALOGUE_LIMIT,
        },
        toolOutcomes: toolRecords.map((r) => ({
          tool: /^[a-z][a-z0-9_]{0,80}$/.test(r.action_name) ? r.action_name : 'other',
          reportedSuccess: r.success === 1,
          attempts: r.n,
        })),
        replay: {
          available: historyAvailable,
          retainedUserMessages: retained,
          examined: history.length - oversized - skippedActivity,
          skippedActivity,
          skippedOversized: oversized,
          matched,
          truncated: retained !== null && retained > history.length,
          window: examinedWindow.first === null ? null : examinedWindow,
          sampledWindow: history.length
            ? { first: history[history.length - 1]!.created_at, last: history[0]!.created_at }
            : null,
        },
      },
    };
  } finally {
    if (ownsTransaction) db.exec('ROLLBACK');
  }
}
export type IntentSnapshot = ReturnType<typeof collectIntentSnapshot>;
