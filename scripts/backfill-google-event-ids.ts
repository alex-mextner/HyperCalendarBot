#!/usr/bin/env bun

/**
 * Relinks bot rows whose Google copy exists but whose Google event id was never stored (#875): a
 * lost insert answer, a link cleared by a disconnect. Matches by the bot-event marker the copy
 * carries (written on apply), and reports a match by (summary, start, end) with an unmarked event,
 * only when it is the single candidate on both sides, without writing it unless --include-slot-matches
 * is given (such an event may be the user's own, not a copy the bot made).
 * Never writes to Google, never changes event text, prints counts only (no titles, ids or users).
 *
 * Default is a dry run: opens the database read-only, reads the calendar, prints the counts.
 * --apply first takes a verified database backup (VACUUM INTO, 0600, never overwritten), then writes
 * only the missing ids plus one sync_log row per link, then prints the counts that remain. Safe to
 * re-run: linked rows are no longer candidates.
 *
 * Usage (production, from the host):
 *   ssh root@odroidn2 'docker exec hypercal-bot bun run scripts/backfill-google-event-ids.ts'
 *   ssh root@odroidn2 'docker exec hypercal-bot bun run scripts/backfill-google-event-ids.ts --apply'
 * Options: --database PATH (default $DATABASE_PATH or ./data/calendar.db), --backup PATH, --include-slot-matches.
 */

import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { calendar_v3 } from 'googleapis';
import { loadConfig } from '../src/config/env.ts';
import { GoogleSyncRepository } from '../src/database/repositories/google-sync.repository.ts';
import { UserRepository } from '../src/database/repositories/user.repository.ts';
import { GoogleCalendarApi } from '../src/services/google/calendar-api.ts';
import {
  applyGoogleIdBackfill,
  type BackfillLink,
  type BackfillPlan,
  createVerifiedBackup,
  dropContestedLinks,
  planGoogleIdBackfill,
} from '../src/services/google/event-id-backfill.ts';
import { GoogleOAuthService } from '../src/services/google/oauth.ts';

/** A dry run must not write, not even the access token Google refreshes while it reads. */
class ReadOnlySyncState extends GoogleSyncRepository {
  override updateAccessToken(): void {}
}

/** Every live event of the user's primary calendar, the calendar the bot pushes its copies to. */
async function listPrimaryCalendar(api: GoogleCalendarApi): Promise<calendar_v3.Schema$Event[]> {
  const events: calendar_v3.Schema$Event[] = [];
  let pageToken: string | undefined;
  do {
    const page = await api.listEvents('primary', { pageToken });
    events.push(...page.events);
    pageToken = page.nextPageToken ?? undefined;
  } while (pageToken);
  return events;
}

/** The plans of the users whose Google read worked, each with the user's 1-based position, and how many reads failed. */
interface PlanSet {
  plans: BackfillPlan[];
  positions: number[];
  failed: number;
}

/**
 * One plan per active user. A user whose Google read fails (revoked token, API error) is reported by
 * position and error class and skipped; the exit code turns non-zero. A copy two users' plans both want
 * is dropped from both.
 */
async function planAll(db: Database, oauth: GoogleOAuthService, userIds: number[]): Promise<PlanSet> {
  const plans: BackfillPlan[] = [];
  const positions: number[] = [];
  let failed = 0;
  for (const [index, userId] of userIds.entries()) {
    try {
      const api = new GoogleCalendarApi(await oauth.getAuthClient(userId));
      plans.push(planGoogleIdBackfill(db, userId, await listPrimaryCalendar(api)));
      positions.push(index + 1);
    } catch (error) {
      console.error(
        JSON.stringify({
          label: 'user-failed',
          user: index + 1,
          error: error instanceof Error ? error.name : 'unknown',
        }),
      );
      failed++;
      process.exitCode = 1;
    }
  }
  return { plans: dropContestedLinks(plans), positions, failed };
}

/** One line per user, by position: counts only. */
function printCounts(label: string, { plans, positions }: PlanSet): void {
  plans.forEach((plan, index) => {
    console.log(JSON.stringify({ label, user: positions[index], ...plan.counts }));
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      apply: { type: 'boolean', default: false },
      database: { type: 'string' },
      backup: { type: 'string' },
      'include-slot-matches': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const databasePath = values.database ?? process.env.DATABASE_PATH ?? './data/calendar.db';
  const apply = values.apply === true;
  const db = new Database(databasePath, apply ? { readwrite: true, create: false } : { readonly: true, create: false });
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON');
    const syncState = apply ? new GoogleSyncRepository(db) : new ReadOnlySyncState(db);
    const oauth = new GoogleOAuthService(loadConfig(), new UserRepository(db), syncState);
    const planned = await planAll(db, oauth, syncState.getActiveUsers());
    printCounts(apply ? 'before' : 'dry-run', planned);
    if (!apply) return;
    if (planned.failed > 0) {
      // A user whose read failed cannot claim their copies: linking the others could hand them a copy that is not theirs.
      console.log(JSON.stringify({ label: 'apply', applied: 0, refused: 'a user read failed' }));
      return;
    }

    const wanted = (link: BackfillLink) => link.via === 'marker' || values['include-slot-matches'] === true;
    const pending = planned.plans
      .map((plan) => ({ ...plan, links: plan.links.filter(wanted) }))
      .filter((plan) => plan.links.length > 0);
    if (pending.length === 0) {
      console.log(JSON.stringify({ label: 'apply', applied: 0, note: 'nothing to link' }));
      return;
    }
    const stamp = new Date().toISOString().replaceAll(/[-:]/g, '').slice(0, 15);
    const defaultBackup = join(dirname(databasePath), 'backups', `google-id-backfill-${stamp}.db`);
    if (values.backup === undefined) {
      // Only the default directory is created and restricted; a path the operator named is left as it is.
      mkdirSync(dirname(defaultBackup), { recursive: true, mode: 0o700 });
      chmodSync(dirname(defaultBackup), 0o700);
    }
    const backupPath = resolve(values.backup ?? defaultBackup);
    createVerifiedBackup(db, backupPath);
    console.log(JSON.stringify({ label: 'backup', verified: true, path: backupPath }));

    let applied = 0;
    let skippedChanged = 0;
    for (const plan of pending) {
      const result = applyGoogleIdBackfill(db, plan);
      applied += result.applied;
      skippedChanged += result.skippedChanged;
    }
    console.log(JSON.stringify({ label: 'apply', applied, skippedChanged }));
    printCounts('after', await planAll(db, oauth, syncState.getActiveUsers()));
  } finally {
    db.close();
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Backfill failed');
  process.exitCode = 1;
}
