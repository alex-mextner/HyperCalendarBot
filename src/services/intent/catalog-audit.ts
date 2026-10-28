import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type { Intent } from '../../database/types.ts';
import { IntentMatcher } from './intent-matcher.ts';
import type { seedIntents } from './seed-catalog.ts';
import { WorkflowSchema } from './workflow-schema.ts';
import { validateWorkflow } from './workflow-validator.ts';

type Seed = Omit<(typeof seedIntents)[number], 'pattern'> & { pattern: string | null };
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
function requiredCaptures(workflow: Seed['workflow']): string[] {
  const requiredSet = new Set<string>();
  const captureText = (text: string) => {
    for (const match of text.matchAll(/\{\{(\$\d+)([^}]*)\}\}/g))
      if (!match[2]?.includes('default(')) requiredSet.add(match[1]!);
  };
  const source = workflow as { bindings?: { [key: string]: { [key: string]: unknown } }; [key: string]: unknown };
  const { bindings, ...body } = source;
  captureText(JSON.stringify(body));
  for (const binding of Object.values(bindings ?? {}))
    for (const [key, value] of Object.entries(binding)) {
      if (key === 'from' && (binding.optional === true || binding.default_amount !== undefined)) continue;
      captureText(JSON.stringify(value));
    }
  return [...requiredSet];
}
function countExampleMatches(seed: Seed, required: string[]): { matched: number; missing: number } {
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
  return { matched, missing };
}
export function auditDefinition(seed: Seed) {
  const parsed = WorkflowSchema.safeParse(seed.workflow);
  const errors = parsed.success ? validateWorkflow(parsed.data, seed.pattern) : [];
  const required = requiredCaptures(seed.workflow);
  const { matched, missing } = countExampleMatches(seed, required);
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
type MatchRecord = { action_name: string; n: number; first: string; last: string };
type ToolRecord = { action_name: string; success: number; n: number };
type LogWindow = { first: string | null; last: string | null; n: number };
type HistoryRow = { content: string; created_at: string };
type MatchEvidenceRow = { input_summary: string; action_name: string };

function assertMaxHistory(maxHistory: number): void {
  if (!Number.isSafeInteger(maxHistory) || maxHistory < 1 || maxHistory > MAX_HISTORY_LIMIT)
    throw new Error('maxHistory must be 1..20000');
}
function readRawIntents(db: Database): Raw[] {
  if (count(db, 'SELECT COUNT(*) n FROM intents') > MAX_INTENT_ROWS)
    throw new Error('Intent catalogue exceeds 2000 rows; use a bounded migration audit');
  return db
    .query(
      'SELECT id,canonical_name,phrases,trigger_words,pattern,workflow,format,status,created_at FROM intents ORDER BY id',
    )
    .all() as Raw[];
}
function readMatchRecords(db: Database, logsAvailable: boolean): MatchRecord[] {
  if (!logsAvailable) return [];
  return db
    .query(
      "SELECT action_name, COUNT(*) n, MIN(created_at) first, MAX(created_at) last FROM user_action_log WHERE action_type='intent_match' GROUP BY action_name",
    )
    .all() as MatchRecord[];
}
function hasInputColumn(db: Database, logsAvailable: boolean): boolean {
  return (
    logsAvailable &&
    (db.query('PRAGMA table_info(user_action_log)').all() as { name: string }[]).some((c) => c.name === 'input_summary')
  );
}
function readMatchEvidence(db: Database, inputColumn: boolean): MatchEvidenceRow[] {
  if (!inputColumn) return [];
  return db
    .query(
      "SELECT input_summary,action_name FROM user_action_log WHERE action_type='intent_match' AND input_summary IS NOT NULL ORDER BY created_at DESC,rowid DESC LIMIT ?",
    )
    .all(CATALOGUE_LIMIT) as MatchEvidenceRow[];
}
function replayEvidence(evidence: MatchEvidenceRow[], currentMatcher: IntentMatcher, seeds: Seed[]) {
  let oversized = 0;
  let matched = 0;
  let same = 0;
  for (const row of evidence) {
    if (row.input_summary.length > MAX_INPUT_LENGTH) {
      oversized++;
      continue;
    }
    const hit = currentMatcher.match(row.input_summary);
    if (hit) {
      matched++;
      if (seeds[hit.intentId - 1]?.canonical_name === row.action_name) same++;
    }
  }
  return { oversized, matched, same };
}
function readLogWindow(db: Database, logsAvailable: boolean): LogWindow | null {
  if (!logsAvailable) return null;
  return db
    .query('SELECT MIN(created_at) first,MAX(created_at) last,COUNT(*) n FROM user_action_log')
    .get() as LogWindow;
}
function readToolRecords(db: Database, logsAvailable: boolean): ToolRecord[] {
  if (!logsAvailable) return [];
  return db
    .query(
      "SELECT action_name,success,COUNT(*) n FROM user_action_log WHERE action_type='ai_tool' GROUP BY action_name,success ORDER BY n DESC",
    )
    .all() as ToolRecord[];
}
function readUserHistory(db: Database, historyAvailable: boolean, maxHistory: number): HistoryRow[] {
  if (!historyAvailable) return [];
  return db
    .query("SELECT content,created_at FROM chat_history WHERE role='user' ORDER BY id DESC LIMIT ?")
    .all(maxHistory) as HistoryRow[];
}
function replayHistory(history: HistoryRow[], currentMatcher: IntentMatcher) {
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
  return { replayCounts, matched, oversized, skippedActivity, examinedWindow };
}
type SnapshotContext = {
  logsAvailable: boolean;
  historyAvailable: boolean;
  matches: Map<string, MatchRecord>;
  replayCounts: Map<number, number>;
};
function summarizeSeeds(seeds: Seed[], byName: Map<string, Raw>, ctx: SnapshotContext) {
  return seeds.map((seed, i) => {
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
      recordedMatches: ctx.logsAvailable ? (ctx.matches.get(seed.canonical_name)?.n ?? 0) : null,
      lastMatch: ctx.matches.get(seed.canonical_name)?.last ?? null,
      replayMatches: ctx.historyAvailable ? (ctx.replayCounts.get(i + 1) ?? 0) : null,
      audit: auditDefinition(seed),
    };
  });
}
function summarizeDatabase(raw: Raw[], knownNames: Set<string>, ctx: SnapshotContext) {
  return raw.map((row) => {
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
      recordedMatches: ctx.logsAvailable ? (ctx.matches.get(row.canonical_name)?.n ?? 0) : null,
      lastMatch: ctx.matches.get(row.canonical_name)?.last ?? null,
    };
  });
}
function summarizeTotals(raw: Raw[], seedCount: number) {
  return {
    database: raw.length,
    seed: seedCount,
    approved: raw.filter((r) => r.status === 'approved').length,
    pending: raw.filter((r) => r.status === 'pending').length,
    rejected: raw.filter((r) => r.status === 'rejected').length,
    other: raw.filter((r) => !['approved', 'pending', 'rejected'].includes(r.status)).length,
  };
}
function summarizeToolOutcomes(toolRecords: ToolRecord[]) {
  return toolRecords.map((r) => ({
    tool: /^[a-z][a-z0-9_]{0,80}$/.test(r.action_name) ? r.action_name : 'other',
    reportedSuccess: r.success === 1,
    attempts: r.n,
  }));
}
export function collectIntentSnapshot(
  db: Database,
  seeds: Seed[],
  options: { sourceRevision: string; maxHistory?: number; capturedAt?: string },
) {
  const maxHistory = options.maxHistory ?? CATALOGUE_LIMIT;
  assertMaxHistory(maxHistory);
  const ownsTransaction = !db.inTransaction;
  if (ownsTransaction) db.exec('BEGIN');
  try {
    const raw = readRawIntents(db);
    const logsAvailable = tableExists(db, 'user_action_log');
    const historyAvailable = tableExists(db, 'chat_history');
    const byName = new Map(raw.map((r) => [r.canonical_name, r]));
    const knownNames = new Set(seeds.map((s) => s.canonical_name));
    const records = readMatchRecords(db, logsAvailable);
    const matches = new Map(records.map((r) => [r.action_name, r]));
    const inputColumn = hasInputColumn(db, logsAvailable);
    const evidence = readMatchEvidence(db, inputColumn);
    const currentMatcher = matcher(seeds);
    const evidenceReplay = replayEvidence(evidence, currentMatcher, seeds);
    const logWindow = readLogWindow(db, logsAvailable);
    const toolRecords = readToolRecords(db, logsAvailable);
    const history = readUserHistory(db, historyAvailable, maxHistory);
    const retained = historyAvailable ? count(db, "SELECT COUNT(*) n FROM chat_history WHERE role='user'") : null;
    const replay = replayHistory(history, currentMatcher);
    const ctx: SnapshotContext = { logsAvailable, historyAvailable, matches, replayCounts: replay.replayCounts };
    return {
      schemaVersion: 1,
      capturedAt: options.capturedAt ?? new Date().toISOString(),
      sourceRevision: options.sourceRevision,
      catalogueFingerprint: hash(seeds.map(seedDefinition)),
      totals: summarizeTotals(raw, seeds.length),
      seeds: summarizeSeeds(seeds, byName, ctx),
      database: summarizeDatabase(raw, knownNames, ctx),
      statistics: {
        logsAvailable,
        logWindow,
        recordedMatches: logsAvailable ? records.reduce((n, r) => n + r.n, 0) : null,
        executionSuccessRate: null,
        recordedInputReplay: {
          available: inputColumn,
          fetched: evidence.length,
          examined: evidence.length - evidenceReplay.oversized,
          skippedOversized: evidenceReplay.oversized,
          matched: evidenceReplay.matched,
          sameIntent: evidenceReplay.same,
          limit: CATALOGUE_LIMIT,
        },
        toolOutcomes: summarizeToolOutcomes(toolRecords),
        replay: {
          available: historyAvailable,
          retainedUserMessages: retained,
          examined: history.length - replay.oversized - replay.skippedActivity,
          skippedActivity: replay.skippedActivity,
          skippedOversized: replay.oversized,
          matched: replay.matched,
          truncated: retained !== null && retained > history.length,
          window: replay.examinedWindow.first === null ? null : replay.examinedWindow,
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
