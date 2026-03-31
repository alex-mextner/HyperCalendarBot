// src/services/google/sync-service.ts
import type { Database } from 'bun:sqlite';
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { GoogleCalendarRepository } from '../../database/repositories/google-calendar.repository.ts';
import type { GoogleSyncRepository } from '../../database/repositories/google-sync.repository.ts';
import type { CalendarEvent } from '../../database/types.ts';
import { syncLogger } from '../../utils/logger.ts';
import type { GoogleCalendarApi } from './calendar-api.ts';
import { type GoogleEvent, googleToLocal, localToGoogle } from './event-mapper.ts';

export class SyncService {
  constructor(
    private db: Database,
    private eventRepo: EventRepository,
    private syncRepo: GoogleSyncRepository,
    private calendarRepo: GoogleCalendarRepository,
    private notifyUser?: (userId: number, message: string) => Promise<void>,
  ) {}

  async initialSync(api: GoogleCalendarApi, userId: number, calendarId: string): Promise<number> {
    let pageToken: string | undefined;
    let nextSyncToken: string | null = null;
    let totalImported = 0;

    do {
      const result = await api.listEvents(calendarId, { pageToken });

      const insertBatch = this.db.transaction(() => {
        for (const gEvent of result.events) {
          if (gEvent.extendedProperties?.private?.hypercalendarbot_event_id) continue;
          if (gEvent.status === 'cancelled') continue;

          const local = googleToLocal(gEvent as GoogleEvent, userId, calendarId);
          this.eventRepo.insertSyncedEvent({
            user_id: userId,
            title: local.title,
            description: local.description,
            start_at: local.start_at,
            end_at: local.end_at,
            all_day: local.all_day,
            timezone: local.timezone,
            location: local.location,
            recurrence_rule: local.recurrence_rule,
            google_calendar_id: calendarId,
            google_event_id: local.google_event_id,
            google_etag: local.google_etag,
            is_cancelled: local.is_cancelled ?? false,
          });
          totalImported++;
        }
      });
      insertBatch();

      pageToken = result.nextPageToken ?? undefined;
      nextSyncToken = result.nextSyncToken;
    } while (pageToken);

    const cal = this.calendarRepo.getCalendarByGoogleId(userId, calendarId);
    if (cal && nextSyncToken) {
      this.calendarRepo.updateSyncToken(cal.id, nextSyncToken);
    }

    syncLogger.info({ userId, calendarId, totalImported }, 'Initial sync completed');
    return totalImported;
  }

  async incrementalPull(api: GoogleCalendarApi, userId: number, calendarId: string): Promise<void> {
    const cal = this.calendarRepo.getCalendarByGoogleId(userId, calendarId);
    if (!cal?.sync_token) {
      await this.initialSync(api, userId, calendarId);
      return;
    }

    try {
      const result = await api.listEvents(calendarId, { syncToken: cal.sync_token });

      for (const gEvent of result.events) {
        if (gEvent.extendedProperties?.private?.hypercalendarbot_event_id) continue;

        if (gEvent.status === 'cancelled') {
          this.handleDeletedEvent(userId, calendarId, gEvent.id!);
        } else {
          await this.handleUpdatedOrNewEvent(userId, calendarId, gEvent as GoogleEvent);
        }
      }

      if (result.nextSyncToken) {
        this.calendarRepo.updateSyncToken(cal.id, result.nextSyncToken);
      }

      syncLogger.info({ userId, calendarId, changes: result.events.length }, 'Incremental pull completed');
    } catch (err: unknown) {
      const error = err as { code?: number };
      if (error.code === 410) {
        syncLogger.warn({ userId, calendarId }, 'Sync token expired, falling back to full sync');
        this.calendarRepo.updateSyncToken(cal.id, null);
        await this.initialSync(api, userId, calendarId);
        return;
      }
      throw err;
    }
  }

  async pushEvent(
    api: GoogleCalendarApi,
    userId: number,
    eventId: number,
    action: 'create' | 'update' | 'delete',
  ): Promise<void> {
    const event = this.eventRepo.findById(eventId, userId);
    if (!event || event.sync_status !== 'pending_push') return;

    const calendarId = event.google_calendar_id ?? 'primary';

    switch (action) {
      case 'create': {
        const gEvent = localToGoogle(event);
        const created = await api.insertEvent(calendarId, gEvent);
        this.eventRepo.updateSyncFields(eventId, {
          google_event_id: created.id ?? undefined,
          google_etag: created.etag ?? undefined,
          sync_status: 'synced',
          last_synced_at: new Date().toISOString(),
        });
        break;
      }
      case 'update': {
        const gEvent = localToGoogle(event);
        const updated = await api.updateEvent(calendarId, event.google_event_id!, gEvent);
        this.eventRepo.updateSyncFields(eventId, {
          google_etag: updated.etag ?? undefined,
          sync_status: 'synced',
          last_synced_at: new Date().toISOString(),
        });
        break;
      }
      case 'delete': {
        if (event.google_event_id) {
          await api.deleteEvent(calendarId, event.google_event_id);
        }
        this.eventRepo.remove(eventId, userId);
        break;
      }
    }

    this.syncRepo.logSync({
      user_id: userId,
      event_id: eventId,
      google_event_id: event.google_event_id ?? undefined,
      direction: 'push',
      action,
    });
  }

  resolveConflict(localEvent: CalendarEvent, googleUpdatedAt: string): 'keep_local' | 'keep_google' {
    const localMs = new Date(localEvent.updated_at).getTime();
    const googleMs = new Date(googleUpdatedAt).getTime();
    return googleMs > localMs ? 'keep_google' : 'keep_local';
  }

  private handleDeletedEvent(userId: number, calendarId: string, googleEventId: string): void {
    const existing = this.eventRepo.findByGoogleEventId(userId, calendarId, googleEventId);

    if (existing) {
      this.eventRepo.remove(existing.id, userId);
      this.syncRepo.logSync({
        user_id: userId,
        event_id: existing.id,
        google_event_id: googleEventId,
        direction: 'pull',
        action: 'delete',
      });
    }
  }

  private async handleUpdatedOrNewEvent(userId: number, calendarId: string, gEvent: GoogleEvent): Promise<void> {
    const local = googleToLocal(gEvent, userId, calendarId);

    // Run the SELECT + writes atomically to prevent races between concurrent sync jobs
    let conflictNotification: (() => Promise<void>) | null = null;
    // TypeScript infers the transaction return as never due to the mutable closure; cast explicitly.
    const applyUpdate = this.db.transaction(() => {
      const existing = this.eventRepo.findByGoogleEventId(userId, calendarId, local.google_event_id);

      if (existing) {
        if (existing.sync_status === 'pending_push') {
          const winner = this.resolveConflict(existing, gEvent.updated ?? '');
          if (winner === 'keep_local') {
            return;
          }
          this.syncRepo.logSync({
            user_id: userId,
            event_id: existing.id,
            google_event_id: local.google_event_id,
            direction: 'pull',
            action: 'conflict_resolve',
            details: JSON.stringify({ winner: 'google' }),
          });
          if (this.notifyUser) {
            conflictNotification = () =>
              this.notifyUser!(
                userId,
                `⚠️ Sync conflict on "${local.title}"\n\nGoogle Calendar version was applied (more recent).`,
              );
          }
        }

        this.eventRepo.updateSyncFields(existing.id, {
          google_etag: local.google_etag ?? undefined,
          sync_status: 'synced',
          last_synced_at: new Date().toISOString(),
        });
        this.eventRepo.update(existing.id, userId, {
          title: local.title,
          description: local.description,
          start_at: local.start_at,
          end_at: local.end_at,
          all_day: local.all_day,
          timezone: local.timezone,
          location: local.location,
          recurrence_rule: local.recurrence_rule,
        });
        this.syncRepo.logSync({
          user_id: userId,
          event_id: existing.id,
          google_event_id: local.google_event_id,
          direction: 'pull',
          action: 'update',
        });
      } else {
        this.eventRepo.insertSyncedEvent({
          user_id: userId,
          title: local.title,
          description: local.description,
          start_at: local.start_at,
          end_at: local.end_at,
          all_day: local.all_day,
          timezone: local.timezone,
          location: local.location,
          recurrence_rule: local.recurrence_rule,
          google_calendar_id: calendarId,
          google_event_id: local.google_event_id,
          google_etag: local.google_etag,
          is_cancelled: local.is_cancelled ?? false,
        });
        this.syncRepo.logSync({
          user_id: userId,
          google_event_id: local.google_event_id,
          direction: 'pull',
          action: 'create',
        });
      }
    });
    applyUpdate();
    // TypeScript loses track of the mutable variable after the transaction closure; reassert the type.
    const notify = conflictNotification as (() => Promise<void>) | null;
    if (notify) await notify();
  }

  async setupWatchChannel(
    api: GoogleCalendarApi,
    calendarRowId: number,
    calendarId: string,
    publicDomain: string,
  ): Promise<void> {
    const channelId = crypto.randomUUID();
    const channelToken = crypto.randomUUID();
    const webhookUrl = `https://${publicDomain}/webhooks/google-calendar`;
    const expirationMs = Date.now() + 7 * 24 * 60 * 60 * 1000;

    const result = await api.watchEvents(calendarId, channelId, webhookUrl, expirationMs, channelToken);
    this.calendarRepo.addWatchChannel(calendarRowId, channelId, result.resourceId, result.expiration, result.token);

    syncLogger.info({ calendarId, channelId }, 'Watch channel created');
  }
}
