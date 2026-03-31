#!/usr/bin/env bun

/**
 * One-time backfill of full Google Calendar history for all connected users.
 * Previous initial sync only imported 90 days — this imports everything older.
 * Safe to re-run: INSERT OR IGNORE skips duplicates.
 * Safe to run while the bot is running — does NOT touch sync tokens.
 *
 * Usage:
 *   bun run scripts/google-history-backfill.ts
 *
 * In Docker:
 *   docker exec hypercal-bot bun run scripts/google-history-backfill.ts
 */

import type { OAuth2Client } from 'google-auth-library';
import type { EnvConfig } from '../src/config/env.ts';
import { createDatabase } from '../src/database/index.ts';
import { GoogleCalendarApi } from '../src/services/google/calendar-api.ts';
import { type GoogleEvent, googleToLocal } from '../src/services/google/event-mapper.ts';
import { GoogleOAuthService } from '../src/services/google/oauth.ts';

const DATABASE_PATH = process.env.DATABASE_PATH || './data/calendar.db';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !ENCRYPTION_KEY) {
  console.error('Required env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ENCRYPTION_KEY');
  process.exit(1);
}

const db = createDatabase(DATABASE_PATH);
const oauthService = new GoogleOAuthService(
  { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, ENCRYPTION_KEY } as EnvConfig,
  db.users,
  db.googleSync,
);

const activeUsers = db.googleSync.getActiveUsers();
console.log(`Found ${activeUsers.length} active user(s) with Google Calendar connected.`);

let totalImported = 0;

for (const userId of activeUsers) {
  const calendars = db.googleCalendars.getEnabledCalendars(userId);
  if (calendars.length === 0) continue;

  let authClient: OAuth2Client;
  try {
    authClient = await oauthService.getAuthClient(userId);
  } catch {
    console.log(`  User ${userId}: skipped (token revoked or not connected)`);
    continue;
  }

  const api = new GoogleCalendarApi(authClient);

  for (const cal of calendars) {
    try {
      let pageToken: string | undefined;
      const countBefore = (
        db.db
          .prepare('SELECT COUNT(*) as cnt FROM events WHERE user_id = ? AND google_calendar_id = ?')
          .get(userId, cal.google_calendar_id) as { cnt: number }
      ).cnt;

      do {
        const result = await api.listEvents(cal.google_calendar_id, { pageToken });

        const insertBatch = db.db.transaction(() => {
          for (const gEvent of result.events) {
            if (gEvent.extendedProperties?.private?.hypercalendarbot_event_id) continue;
            if (gEvent.status === 'cancelled') continue;

            const local = googleToLocal(gEvent as GoogleEvent, userId, cal.google_calendar_id);
            db.events.insertSyncedEvent({
              user_id: userId,
              title: local.title,
              description: local.description,
              start_at: local.start_at,
              end_at: local.end_at,
              all_day: local.all_day,
              timezone: local.timezone,
              location: local.location,
              recurrence_rule: local.recurrence_rule,
              google_calendar_id: cal.google_calendar_id,
              google_event_id: local.google_event_id,
              google_etag: local.google_etag,
              is_cancelled: local.is_cancelled ?? false,
            });
          }
        });
        insertBatch();

        pageToken = result.nextPageToken ?? undefined;
      } while (pageToken);

      const countAfter = (
        db.db
          .prepare('SELECT COUNT(*) as cnt FROM events WHERE user_id = ? AND google_calendar_id = ?')
          .get(userId, cal.google_calendar_id) as { cnt: number }
      ).cnt;
      const calImported = countAfter - countBefore;
      totalImported += calImported;
      console.log(`  User ${userId}, calendar "${cal.calendar_name}": +${calImported} events`);
    } catch (err) {
      console.error(`  User ${userId}, calendar "${cal.calendar_name}": ERROR`, err);
    }
  }
}

console.log(`\nDone. Total imported: ${totalImported} events.`);
process.exit(0);
