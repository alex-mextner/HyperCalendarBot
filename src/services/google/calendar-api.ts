// src/services/google/calendar-api.ts

import type { OAuth2Client } from 'google-auth-library';
import { type calendar_v3, google } from 'googleapis';
import { syncLogger } from '../../utils/logger.ts';

export interface CalendarInfo {
  google_calendar_id: string;
  calendar_name: string;
  color: string | null;
  is_primary: boolean;
  access_role: 'owner' | 'writer' | 'reader' | 'freeBusyReader';
}

export interface EventListResult {
  events: calendar_v3.Schema$Event[];
  nextSyncToken: string | null;
  nextPageToken: string | null;
}

export class GoogleCalendarApi {
  private api: calendar_v3.Calendar;

  constructor(auth: OAuth2Client) {
    this.api = google.calendar({ version: 'v3', auth });
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const res = await this.api.calendarList.list();
    return (res.data.items ?? []).map((cal) => ({
      google_calendar_id: cal.id!,
      calendar_name: cal.summary ?? 'Untitled',
      color: cal.backgroundColor ?? null,
      is_primary: cal.primary ?? false,
      access_role: (cal.accessRole ?? 'reader') as CalendarInfo['access_role'],
    }));
  }

  async listEvents(
    calendarId: string,
    opts: { syncToken?: string; pageToken?: string; timeMin?: string; maxResults?: number },
  ): Promise<EventListResult> {
    const res = await this.api.events.list({
      calendarId,
      singleEvents: false,
      maxResults: opts.maxResults ?? 250,
      syncToken: opts.syncToken,
      pageToken: opts.pageToken,
      timeMin: opts.timeMin,
    });
    return {
      events: res.data.items ?? [],
      nextSyncToken: res.data.nextSyncToken ?? null,
      nextPageToken: res.data.nextPageToken ?? null,
    };
  }

  async insertEvent(calendarId: string, event: calendar_v3.Schema$Event): Promise<calendar_v3.Schema$Event> {
    const res = await this.api.events.insert({ calendarId, requestBody: event });
    return res.data;
  }

  async updateEvent(
    calendarId: string,
    eventId: string,
    event: calendar_v3.Schema$Event,
  ): Promise<calendar_v3.Schema$Event> {
    const res = await this.api.events.update({ calendarId, eventId, requestBody: event });
    return res.data;
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    await this.api.events.delete({ calendarId, eventId });
  }

  async getEvent(calendarId: string, eventId: string): Promise<calendar_v3.Schema$Event> {
    const res = await this.api.events.get({ calendarId, eventId });
    return res.data;
  }

  async watchEvents(
    calendarId: string,
    channelId: string,
    webhookUrl: string,
    expirationMs: number,
  ): Promise<{ resourceId: string; expiration: string }> {
    const res = await this.api.events.watch({
      calendarId,
      requestBody: {
        id: channelId,
        type: 'web_hook',
        address: webhookUrl,
        expiration: String(expirationMs),
      },
    });
    return {
      resourceId: res.data.resourceId!,
      expiration: new Date(Number(res.data.expiration)).toISOString(),
    };
  }

  async stopChannel(channelId: string, resourceId: string): Promise<void> {
    try {
      await this.api.channels.stop({
        requestBody: { id: channelId, resourceId },
      });
    } catch (err) {
      syncLogger.warn({ channelId, error: String(err) }, 'Failed to stop watch channel (may be expired)');
    }
  }
}
