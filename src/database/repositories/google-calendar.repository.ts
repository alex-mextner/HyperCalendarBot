// src/database/repositories/google-calendar.repository.ts
import type { Database } from 'bun:sqlite';
import type { GoogleAccessRole, GoogleCalendar, GoogleWatchChannel } from '../types.ts';

interface UpsertCalendarData {
  google_calendar_id: string;
  calendar_name: string;
  color?: string;
  is_primary: boolean;
  access_role: GoogleAccessRole;
}

interface ExpiringChannel extends GoogleWatchChannel {
  user_id: number;
  google_calendar_id: string;
}

export class GoogleCalendarRepository {
  constructor(private db: Database) {}

  getCalendars(userId: number): GoogleCalendar[] {
    return this.db
      .prepare('SELECT * FROM google_calendars WHERE user_id = ? ORDER BY is_primary DESC, calendar_name')
      .all(userId) as GoogleCalendar[];
  }

  getEnabledCalendars(userId: number): GoogleCalendar[] {
    return this.db
      .prepare('SELECT * FROM google_calendars WHERE user_id = ? AND sync_enabled = 1 ORDER BY is_primary DESC')
      .all(userId) as GoogleCalendar[];
  }

  getCalendarById(id: number): GoogleCalendar | null {
    return this.db.prepare('SELECT * FROM google_calendars WHERE id = ?').get(id) as GoogleCalendar | null;
  }

  getCalendarByGoogleId(userId: number, googleCalendarId: string): GoogleCalendar | null {
    return this.db
      .prepare('SELECT * FROM google_calendars WHERE user_id = ? AND google_calendar_id = ?')
      .get(userId, googleCalendarId) as GoogleCalendar | null;
  }

  upsertCalendar(userId: number, data: UpsertCalendarData): void {
    this.db
      .prepare(`
        INSERT INTO google_calendars (user_id, google_calendar_id, calendar_name, color, is_primary, access_role)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (user_id, google_calendar_id) DO UPDATE SET
          calendar_name = excluded.calendar_name,
          color = excluded.color,
          is_primary = excluded.is_primary,
          access_role = excluded.access_role,
          updated_at = datetime('now')
      `)
      .run(
        userId,
        data.google_calendar_id,
        data.calendar_name,
        data.color ?? null,
        data.is_primary ? 1 : 0,
        data.access_role,
      );
  }

  toggleSync(calendarRowId: number): void {
    this.db
      .prepare(`
        UPDATE google_calendars
        SET sync_enabled = CASE WHEN sync_enabled = 1 THEN 0 ELSE 1 END,
            updated_at = datetime('now')
        WHERE id = ?
      `)
      .run(calendarRowId);
  }

  updateSyncToken(calendarRowId: number, syncToken: string | null): void {
    this.db
      .prepare(`
        UPDATE google_calendars
        SET sync_token = ?, last_synced_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?
      `)
      .run(syncToken, calendarRowId);
  }

  deleteUserCalendars(userId: number): void {
    this.db.prepare('DELETE FROM google_calendars WHERE user_id = ?').run(userId);
  }

  addWatchChannel(
    calendarRowId: number,
    channelId: string,
    resourceId: string,
    expiration: string,
    channelToken: string,
  ): void {
    this.db
      .prepare(`
        INSERT INTO google_watch_channels (google_calendar_row_id, channel_id, resource_id, expiration, channel_token)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(calendarRowId, channelId, resourceId, expiration, channelToken);
  }

  getWatchChannels(calendarRowId: number): GoogleWatchChannel[] {
    return this.db
      .prepare('SELECT * FROM google_watch_channels WHERE google_calendar_row_id = ?')
      .all(calendarRowId) as GoogleWatchChannel[];
  }

  findChannelByIds(channelId: string, resourceId: string): GoogleWatchChannel | null {
    return this.db
      .prepare('SELECT * FROM google_watch_channels WHERE channel_id = ? AND resource_id = ?')
      .get(channelId, resourceId) as GoogleWatchChannel | null;
  }

  getExpiringChannels(beforeThreshold: string): ExpiringChannel[] {
    return this.db
      .prepare(`
        SELECT wc.*, gc.user_id, gc.google_calendar_id
        FROM google_watch_channels wc
        JOIN google_calendars gc ON gc.id = wc.google_calendar_row_id
        WHERE wc.expiration < ?
      `)
      .all(beforeThreshold) as ExpiringChannel[];
  }

  deleteWatchChannel(channelRowId: number): void {
    this.db.prepare('DELETE FROM google_watch_channels WHERE id = ?').run(channelRowId);
  }

  deleteWatchChannelsForUser(userId: number): void {
    this.db
      .prepare(`
        DELETE FROM google_watch_channels
        WHERE google_calendar_row_id IN (SELECT id FROM google_calendars WHERE user_id = ?)
      `)
      .run(userId);
  }
}
