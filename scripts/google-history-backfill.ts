#!/usr/bin/env bun

/**
 * One-time backfill of full Google Calendar history for all connected users.
 * Previous initial sync only imported 90 days — this imports everything older.
 * Safe to re-run: INSERT OR IGNORE skips duplicates.
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
import { GoogleOAuthService } from '../src/services/google/oauth.ts';
import { SyncService } from '../src/services/google/sync-service.ts';

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
const syncService = new SyncService(db.db, db.events, db.googleSync, db.googleCalendars);

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
      const imported = await syncService.initialSync(api, userId, cal.google_calendar_id);
      totalImported += imported;
      console.log(`  User ${userId}, calendar "${cal.calendar_name}": +${imported} events`);
    } catch (err) {
      console.error(`  User ${userId}, calendar "${cal.calendar_name}": ERROR`, err);
    }
  }
}

console.log(`\nDone. Total imported: ${totalImported} events.`);
process.exit(0);
