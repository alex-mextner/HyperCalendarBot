// Per provider:model AI usage from the durable ai_usage_events ledger, read-only.
//   bun scripts/report-ai-usage.ts [--days N] [--json] [--database path]
// Exit codes: 0 report printed, 1 database unreadable or not migrated, 2 invalid arguments.
import { Database } from 'bun:sqlite';
import { parseArgs } from 'node:util';
import { t } from '../src/config/constants.ts';
import { AiUsageRepository } from '../src/database/repositories/ai-usage.repository.ts';
import { parseReportDays, summarizeAiUsage } from '../src/services/ai/usage-report.ts';
import { formatUsageReport } from '../src/services/ai/usage-report-text.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

function parseArguments() {
  try {
    return parseArgs({
      args: process.argv.slice(2),
      options: {
        days: { type: 'string' },
        json: { type: 'boolean', default: false },
        database: { type: 'string', default: './data/calendar.db' },
      },
      strict: true,
    }).values;
  } catch (err) {
    console.error(
      `${err instanceof Error ? err.message : 'invalid arguments'}\nusage: [--days 1-180] [--json] [--database path]`,
    );
    return process.exit(2);
  }
}

const values = parseArguments();

const days = parseReportDays(values.days);
if (days === null) {
  console.error('--days must be a whole number from 1 to 180');
  process.exit(2);
}

let db: Database;
try {
  db = new Database(values.database, { readonly: true, create: false });
} catch (err) {
  console.error(`cannot open ${values.database} read-only: ${err instanceof Error ? err.message : 'unknown error'}`);
  process.exit(1);
}

try {
  const migrated = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ai_usage_events'").get();
  if (!migrated) {
    console.error('ai_usage_events does not exist: this database has not run migration 066_ai_usage_events yet');
    process.exit(1);
  }
  const untilMs = Date.now();
  const window = { sinceMs: untilMs - days * DAY_MS, untilMs };
  const summary = summarizeAiUsage(new AiUsageRepository(db).iterateSince(window.sinceMs), window);
  if (values.json) {
    console.log(JSON.stringify({ days, generatedAt: new Date(untilMs).toISOString(), ...summary }, null, 2));
  } else {
    console.log(formatUsageReport(summary, days, t('en').aiStats));
  }
} finally {
  db.close();
}
