// Read-only monitor of what users do right after a rule answered them: the safety net behind the seed-6 activation.
// It uses what the bot already records (no migration): every `intent_match` row of user_action_log is one rule answer,
// every user turn is a chat_history row. A user who pushes back within the follow-up window either says so ("нет",
// "не то", "отмени", "undo", ...) or sends the same request again; both count as pushback. User text is read to classify
// and is never printed; the report holds counts and rule names only.
//
//   bun --no-env-file scripts/intent-rule-monitor.ts --db data/calendar.db [--hours 48] [--follow-up-minutes 10] [--json]
//
// Exit codes: 0 healthy or too few answers to judge, 3 FLAGGED (pushback above 15% over at least 20 rule answers),
// 2 usage error. A flag means: roll the seed back (docs/intents/engine.md, "Откат"):
//   bun --no-env-file scripts/intent-revision.ts --db data/calendar.db rollback [--apply]
import { Database } from 'bun:sqlite';
import { parseArgs } from 'node:util';

export const MONITOR_LIMITS = {
  /** Pushback share above which a window is flagged. */
  flagAbove: 0.15,
  /** Rule answers whose follow-up window has closed that a flag needs. */
  minAnswers: 20,
  maxHours: 24 * 14,
  /** Rows read per table; a window above it is reported as truncated instead of read in full. */
  maxRows: 50_000,
} as const;

/** The user disowns the answer: negation, undo, cancel. Matched at the start of the follow-up. */
const CORRECTION =
  /^\s*(?:нет\b|не\s+то\b|не\s+так\b|неправильно|неверно|ошиб(?:ка|ся|лся)|отмени|отмена|верни|назад|undo\b|cancel\b|wrong\b|no\b|not\s+that\b|that'?s\s+not\b|incorrect\b)/iu;
/** A bare yes/no/cancel: the user answering a confirmation, which every write rule asks before it acts. */
const CONFIRMATION_ANSWER = /^\s*(?:да|нет|ок|окей|отмена|yes|no|ok|okay|cancel)\s*[.!]*\s*$/iu;
/** A follow-up that repeats the request this much is a retry or a rephrase of the same ask. */
const RETRY_OVERLAP = 0.6;

const wordsOf = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .replaceAll('ё', 'е')
      .split(/[^\p{L}\p{N}#@]+/u)
      .filter((word) => word.length > 0),
  );

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / (a.size + b.size - shared);
}

/** SQLite `datetime('now')` text (UTC, second resolution) as epoch milliseconds. */
const epochOf = (stored: string): number => Date.parse(`${stored.replace(' ', 'T')}Z`);
const stamp = (ms: number): string =>
  new Date(ms)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, '');

export interface MonitorOptions {
  nowMs: number;
  hours: number;
  followUpMinutes: number;
}

export interface RuleMonitorReport {
  windowHours: number;
  followUpMinutes: number;
  userMessages: number;
  ruleAnswers: number;
  /** Rule answers / user messages of the window. Null with no messages. */
  ruleShare: number | null;
  /** Rule answers old enough that their whole follow-up window lies inside the data. */
  judgedAnswers: number;
  corrections: number;
  retries: number;
  pushbackRate: number | null;
  flagged: boolean;
  truncated: boolean;
  perRule: { rule: string; answers: number; pushbacks: number }[];
}

interface AnswerRow {
  user_id: number;
  action_name: string;
  input_summary: string | null;
  created_at: string;
}
interface MessageRow {
  user_id: number;
  content: string;
  created_at: string;
}

export function monitorRuleAnswers(db: Database, options: MonitorOptions): RuleMonitorReport {
  const followUpMs = options.followUpMinutes * 60_000;
  const start = stamp(options.nowMs - options.hours * 3_600_000);
  const end = stamp(options.nowMs);
  const answers = db
    .query<AnswerRow, [string, string, number]>(
      `SELECT user_id, action_name, input_summary, created_at FROM user_action_log
       WHERE action_type = 'intent_match' AND created_at >= ? AND created_at <= ?
       ORDER BY created_at, id LIMIT ?`,
    )
    .all(start, end, MONITOR_LIMITS.maxRows);
  const messages = db
    .query<MessageRow, [string, string, number]>(
      `SELECT user_id, content, created_at FROM chat_history
       WHERE role = 'user' AND created_at >= ? AND created_at <= ?
       ORDER BY created_at, id LIMIT ?`,
    )
    .all(start, end, MONITOR_LIMITS.maxRows);
  const byUser = new Map<number, { at: number; text: string }[]>();
  for (const message of messages) {
    const list = byUser.get(message.user_id) ?? [];
    list.push({ at: epochOf(message.created_at), text: message.content });
    byUser.set(message.user_id, list);
  }

  let judged = 0;
  let corrections = 0;
  let retries = 0;
  const perRule = new Map<string, { answers: number; pushbacks: number }>();
  for (const answer of answers) {
    const answeredAt = epochOf(answer.created_at);
    const rule = perRule.get(answer.action_name) ?? { answers: 0, pushbacks: 0 };
    rule.answers++;
    perRule.set(answer.action_name, rule);
    // The answer's own message is logged in the same second, before the answer: only later turns can push back.
    if (answeredAt + followUpMs > options.nowMs) continue;
    judged++;
    const asked = wordsOf(answer.input_summary ?? '');
    const followUp = (byUser.get(answer.user_id) ?? []).find(
      (turn) => turn.at > answeredAt && turn.at <= answeredAt + followUpMs,
    );
    if (!followUp) continue;
    // The answer to a rule's own «Да / Отмена» question is the confirmation working, not pushback.
    if (CONFIRMATION_ANSWER.test(followUp.text)) continue;
    if (CORRECTION.test(followUp.text)) corrections++;
    else if (overlap(asked, wordsOf(followUp.text)) >= RETRY_OVERLAP) retries++;
    else continue;
    rule.pushbacks++;
  }
  const pushbackRate = judged === 0 ? null : (corrections + retries) / judged;
  return {
    windowHours: options.hours,
    followUpMinutes: options.followUpMinutes,
    userMessages: messages.length,
    ruleAnswers: answers.length,
    ruleShare: messages.length === 0 ? null : answers.length / messages.length,
    judgedAnswers: judged,
    corrections,
    retries,
    pushbackRate,
    flagged: pushbackRate !== null && judged >= MONITOR_LIMITS.minAnswers && pushbackRate > MONITOR_LIMITS.flagAbove,
    truncated: answers.length === MONITOR_LIMITS.maxRows || messages.length === MONITOR_LIMITS.maxRows,
    perRule: [...perRule.entries()]
      .map(([rule, counts]) => ({ rule, ...counts }))
      .sort((a, b) => b.answers - a.answers || a.rule.localeCompare(b.rule))
      .slice(0, 15),
  };
}

const percent = (value: number | null): string => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);

export function renderReport(report: RuleMonitorReport): string {
  const lines = [
    `intent rule monitor: last ${report.windowHours} h, follow-up window ${report.followUpMinutes} min`,
    `user messages ${report.userMessages}, rule answers ${report.ruleAnswers}, rule share ${percent(report.ruleShare)}`,
    `judged answers ${report.judgedAnswers}: corrections ${report.corrections}, repeated requests ${report.retries}, pushback ${percent(report.pushbackRate)}`,
    ...report.perRule.map((rule) => `  ${rule.rule}: ${rule.answers} answers, ${rule.pushbacks} pushbacks`),
  ];
  if (report.truncated)
    lines.push(`WARNING: a table hit the ${MONITOR_LIMITS.maxRows}-row bound; the figures are partial`);
  lines.push(
    report.flagged
      ? `FLAGGED: pushback ${percent(report.pushbackRate)} is above ${percent(MONITOR_LIMITS.flagAbove)} over ${report.judgedAnswers} rule answers (at least ${MONITOR_LIMITS.minAnswers}). Roll back: bun --no-env-file scripts/intent-revision.ts --db <calendar.db> rollback --apply`
      : report.judgedAnswers < MONITOR_LIMITS.minAnswers
        ? `not enough rule answers to judge yet (${report.judgedAnswers} of ${MONITOR_LIMITS.minAnswers})`
        : `healthy: pushback ${percent(report.pushbackRate)} is within ${percent(MONITOR_LIMITS.flagAbove)}`,
  );
  return lines.join('\n');
}

/** The arguments, or the reason they cannot be read. */
function parse(argv: string[]): MonitorArgs | string {
  try {
    const { values } = parseArgs({ args: argv, options: OPTIONS, strict: true });
    return {
      db: values.db,
      hours: values.hours ?? '48',
      'follow-up-minutes': values['follow-up-minutes'] ?? '10',
      json: values.json ?? false,
    };
  } catch (err) {
    return err instanceof Error ? err.message : 'bad arguments';
  }
}

function main(argv: string[]): number {
  const values = parse(argv);
  if (typeof values === 'string') {
    console.error(`${values}\nusage: --db PATH [--hours 48] [--follow-up-minutes 10] [--json]`);
    return 2;
  }
  return run(values);
}

interface MonitorArgs {
  db?: string;
  hours: string;
  'follow-up-minutes': string;
  json: boolean;
}

function run(values: MonitorArgs): number {
  const hours = Number(values.hours);
  const followUpMinutes = Number(values['follow-up-minutes']);
  if (
    !values.db ||
    !Number.isFinite(hours) ||
    hours <= 0 ||
    hours > MONITOR_LIMITS.maxHours ||
    !Number.isFinite(followUpMinutes) ||
    followUpMinutes <= 0
  ) {
    console.error(
      `--db is required; --hours must be 1..${MONITOR_LIMITS.maxHours}; --follow-up-minutes must be positive`,
    );
    return 2;
  }
  const db = new Database(values.db, { readonly: true, create: false });
  try {
    db.exec('PRAGMA query_only=ON');
    const report = monitorRuleAnswers(db, { nowMs: Date.now(), hours, followUpMinutes });
    console.log(values.json ? JSON.stringify(report, null, 2) : renderReport(report));
    return report.flagged ? 3 : 0;
  } finally {
    db.close();
  }
}

const OPTIONS = {
  db: { type: 'string' },
  hours: { type: 'string', default: '48' },
  'follow-up-minutes': { type: 'string', default: '10' },
  json: { type: 'boolean', default: false },
} as const;

if (import.meta.main) process.exit(main(process.argv.slice(2)));
