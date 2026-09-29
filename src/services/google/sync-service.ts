// src/services/google/sync-service.ts
import type { Database } from 'bun:sqlite';
import type { calendar_v3 } from 'googleapis';
import { type Lang, t } from '../../config/constants.ts';
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { GoogleCalendarRepository } from '../../database/repositories/google-calendar.repository.ts';
import type { GoogleSyncRepository } from '../../database/repositories/google-sync.repository.ts';
import type { ParticipantGoogleSyncRepository } from '../../database/repositories/participant-google-sync.repository.ts';
import type { CalendarEvent, ParticipantGoogleSync } from '../../database/types.ts';
import { syncLogger } from '../../utils/logger.ts';
import type { EventChangeNotifier } from '../event/event-change-notifier.ts';
import { type GoogleCalendarApi, googleGoneStatus } from './calendar-api.ts';
import { computeEventDiff, snapshotFromCalendarEvent, snapshotFromGoogleLocal } from './change-detection.ts';
import { type GoogleEvent, googleToLocal, localToGoogle } from './event-mapper.ts';
import {
  handleParticipantChange,
  handleParticipantDelete,
  type ParticipantHandlerDeps,
} from './participant-change-handler.ts';

/** A participant's linked Google copy about to be updated. */
interface ParticipantCopy {
  link: ParticipantGoogleSync;
  calendarId: string;
  googleEventId: string;
  gEvent: GoogleEvent;
}

/** sync_log details of a participant copy that Google reported gone (#728). */
interface GoneParticipantCopyEvidence {
  reason: 'participant_copy_gone';
  http_status: 404 | 410;
  probe: 'skipped' | 'cancelled' | 'not_found';
  outcome: 'unlinked' | 'declined' | 'recreated';
  stale_google_event_id: string;
  new_google_event_id?: string;
}

export class SyncService {
  constructor(
    private db: Database,
    private eventRepo: EventRepository,
    private syncRepo: GoogleSyncRepository,
    private calendarRepo: GoogleCalendarRepository,
    private notifyUser?: (userId: number, message: string) => Promise<void>,
    private getUserLang?: (userId: number) => Lang,
    private participantSyncRepo?: ParticipantGoogleSyncRepository,
    private changeNotifier?: EventChangeNotifier,
    private participantHandlerDeps?: ParticipantHandlerDeps,
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
          await this.handleDeletedEvent(userId, calendarId, gEvent.id!);
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

  private async handleDeletedEvent(userId: number, calendarId: string, googleEventId: string): Promise<void> {
    const existing = this.eventRepo.findByGoogleEventId(userId, calendarId, googleEventId);

    if (existing) {
      if (this.changeNotifier) {
        await this.changeNotifier.onEventDeleted({ event: existing, source: 'google_sync' });
      }
      this.eventRepo.remove(existing.id, userId);
      this.syncRepo.logSync({
        user_id: userId,
        event_id: existing.id,
        google_event_id: googleEventId,
        direction: 'pull',
        action: 'delete',
      });
      return;
    }

    const participantSync = this.participantSyncRepo?.getByUserAndGoogleEventId(userId, googleEventId);
    if (participantSync && this.participantHandlerDeps) {
      await handleParticipantDelete(userId, participantSync, this.participantHandlerDeps);
    }
  }

  private async handleUpdatedOrNewEvent(userId: number, calendarId: string, gEvent: GoogleEvent): Promise<void> {
    const local = googleToLocal(gEvent, userId, calendarId);

    let pendingNotification: (() => Promise<void>) | null = null;
    const applyUpdate = this.db.transaction(() => {
      const existing = this.eventRepo.findByGoogleEventId(userId, calendarId, local.google_event_id);

      if (existing) {
        let conflictNotification: (() => Promise<void>) | null = null;

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
            const conflictLang = this.getUserLang?.(userId) ?? 'en';
            conflictNotification = () => this.notifyUser!(userId, t(conflictLang).gcal_conflict(local.title, 'google'));
          }
        }

        const snapshot = snapshotFromCalendarEvent(existing);

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

        const incoming = snapshotFromGoogleLocal(local);
        const changes = computeEventDiff(snapshot, incoming);

        if (changes.length > 0 && this.changeNotifier) {
          const updatedEvent = this.eventRepo.findByGoogleEventId(userId, calendarId, local.google_event_id);
          if (updatedEvent) {
            pendingNotification = async () => {
              if (conflictNotification) await conflictNotification();
              await this.changeNotifier!.onEventChanged({
                event: updatedEvent,
                changes,
                source: 'google_sync',
              });
            };
          }
        } else if (conflictNotification) {
          pendingNotification = conflictNotification;
        }
      } else {
        const participantSync = this.participantSyncRepo?.getByUserAndGoogleEventId(userId, local.google_event_id);
        if (participantSync) {
          if (gEvent.recurringEventId) {
            syncLogger.debug(
              { userId, googleEventId: local.google_event_id, recurringEventId: gEvent.recurringEventId },
              'Skipping recurrence exception from participant (not supported in MVP)',
            );
            return;
          }
          const masterEvent = this.eventRepo.findByIdUnfiltered(participantSync.event_id);
          if (masterEvent && this.participantHandlerDeps) {
            pendingNotification = () =>
              handleParticipantChange(userId, masterEvent, local, this.participantHandlerDeps!);
          }
          return;
        }

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
    const notify = pendingNotification as (() => Promise<void>) | null;
    if (notify) await notify();
  }

  /**
   * `knownCopy` is the Google copy captured when the delete was queued: the event delete removes
   * the participant_google_sync row before the worker runs, so the row alone cannot be trusted.
   */
  async pushParticipantEvent(
    api: GoogleCalendarApi,
    participantUserId: number,
    eventId: number,
    action: 'create' | 'update' | 'delete',
    participantSyncRepoOverride?: ParticipantGoogleSyncRepository,
    knownCopy?: { googleEventId?: string; calendarId?: string | null },
  ): Promise<void> {
    const participantSyncRepo = participantSyncRepoOverride ?? this.participantSyncRepo;
    if (!participantSyncRepo) throw new Error('participantSyncRepo required for pushParticipantEvent');
    if (action === 'delete') {
      const syncRecord = participantSyncRepo.getByUserAndEvent(participantUserId, eventId);
      const googleEventId = syncRecord?.google_event_id ?? knownCopy?.googleEventId;
      if (!googleEventId) {
        participantSyncRepo.delete(participantUserId, eventId);
        return;
      }
      const calendarId = syncRecord?.google_calendar_id ?? knownCopy?.calendarId ?? 'primary';
      try {
        await api.deleteEvent(calendarId, googleEventId);
      } catch (err) {
        if (googleGoneStatus(err) === null) throw err;
      }
      participantSyncRepo.delete(participantUserId, eventId);
      this.syncRepo.logSync({
        user_id: participantUserId,
        event_id: eventId,
        google_event_id: googleEventId,
        direction: 'push',
        action: 'delete',
        details: 'participant_sync',
      });
      return;
    }

    const event = this.eventRepo.findByIdUnfiltered(eventId);
    if (!event) return;

    const gcalId = 'primary';
    const gEvent = localToGoogle(event);

    const syncRecord = participantSyncRepo.getByUserAndEvent(participantUserId, eventId);
    // A push queued before the invitee declined must not give them a copy again.
    if (!syncRecord?.google_event_id && this.hasDeclined(participantUserId, eventId)) {
      syncLogger.info({ participantUserId, eventId, action }, 'Participant declined; no Google copy inserted');
      return;
    }

    if (syncRecord?.google_event_id) {
      const copy = { link: syncRecord, calendarId: gcalId, googleEventId: syncRecord.google_event_id, gEvent };
      const copyUpdated = await this.updateParticipantCopy(api, participantSyncRepo, copy);
      if (!copyUpdated) return;
      this.syncRepo.logSync({
        user_id: participantUserId,
        event_id: eventId,
        google_event_id: syncRecord.google_event_id,
        direction: 'push',
        action,
        details: 'participant_sync',
      });
    } else {
      const link = { user_id: participantUserId, event_id: eventId };
      await this.insertParticipantCopy(api, participantSyncRepo, link, gcalId, gEvent);
      this.syncRepo.logSync({
        user_id: participantUserId,
        event_id: eventId,
        direction: 'push',
        action: 'create',
        details: 'participant_sync',
      });
    }

    syncLogger.info({ participantUserId, eventId, action }, 'Participant event synced to Google');
  }

  /** Whether the participant's RSVP is declined; the pull records a copy deleted in Google as one. */
  private hasDeclined(participantUserId: number, eventId: number): boolean {
    const participant = this.participantHandlerDeps?.participantRepo.findByEventAndUser(eventId, participantUserId);
    return participant?.status === 'declined';
  }

  /** Inserts a fresh copy into the participant's calendar and points their link row at it. */
  private async insertParticipantCopy(
    api: GoogleCalendarApi,
    participantSyncRepo: ParticipantGoogleSyncRepository,
    link: Pick<ParticipantGoogleSync, 'user_id' | 'event_id'>,
    calendarId: string,
    gEvent: GoogleEvent,
  ): Promise<calendar_v3.Schema$Event> {
    const created = await api.insertEvent(calendarId, gEvent);
    participantSyncRepo.upsert(link.user_id, link.event_id, {
      google_event_id: created.id,
      google_calendar_id: calendarId,
      google_etag: created.etag,
      sync_status: 'synced',
      last_synced_at: new Date().toISOString(),
    });
    return created;
  }

  /**
   * Updates the participant's linked copy. Returns false when Google answered that the copy is gone
   * and the link was resolved instead; any other error fails the job so BullMQ retries it.
   */
  private async updateParticipantCopy(
    api: GoogleCalendarApi,
    participantSyncRepo: ParticipantGoogleSyncRepository,
    copy: ParticipantCopy,
  ): Promise<boolean> {
    let updated: calendar_v3.Schema$Event;
    try {
      updated = await api.updateEvent(copy.calendarId, copy.googleEventId, copy.gEvent);
    } catch (err) {
      const httpStatus = googleGoneStatus(err);
      if (httpStatus === null) throw err;
      await this.resolveGoneParticipantCopy(api, participantSyncRepo, copy, httpStatus, err);
      return false;
    }
    participantSyncRepo.updateSyncFields(copy.link.user_id, copy.link.event_id, {
      google_etag: updated.etag ?? undefined,
      sync_status: 'synced',
      last_synced_at: new Date().toISOString(),
    });
    return true;
  }

  /**
   * Resolves a copy Google reported gone the way the pull reads the same copy (handleDeletedEvent):
   * a copy Google still lists as cancelled means the participant removed the event, so they decline
   * as on pull; a copy Google no longer knows at all (purged, or another Google account connected)
   * is recreated, because nothing says they stopped attending. A participant who already declined
   * is only unlinked. A copy that is still live contradicts the error, which is rethrown for a retry.
   */
  private async resolveGoneParticipantCopy(
    api: GoogleCalendarApi,
    participantSyncRepo: ParticipantGoogleSyncRepository,
    copy: ParticipantCopy,
    httpStatus: 404 | 410,
    err: unknown,
  ): Promise<void> {
    const deps = this.participantHandlerDeps;
    if (!deps) throw new Error('participantHandlerDeps required to resolve a gone participant copy', { cause: err });
    const { link, calendarId, googleEventId } = copy;
    const record = (
      action: 'create' | 'delete',
      loggedGoogleEventId: string | undefined,
      evidence: Pick<GoneParticipantCopyEvidence, 'probe' | 'outcome' | 'new_google_event_id'>,
    ): void => {
      const details: GoneParticipantCopyEvidence = {
        reason: 'participant_copy_gone',
        http_status: httpStatus,
        stale_google_event_id: googleEventId,
        ...evidence,
      };
      this.syncRepo.logSync({
        user_id: link.user_id,
        event_id: link.event_id,
        google_event_id: loggedGoogleEventId,
        direction: 'push',
        action,
        details: JSON.stringify(details),
      });
      syncLogger.warn({ participantUserId: link.user_id, eventId: link.event_id, ...details }, 'Participant copy gone');
    };

    if (this.hasDeclined(link.user_id, link.event_id)) {
      participantSyncRepo.delete(link.user_id, link.event_id);
      record('delete', googleEventId, { probe: 'skipped', outcome: 'unlinked' });
      return;
    }

    let listed: calendar_v3.Schema$Event | null;
    try {
      listed = await api.getEvent(calendarId, googleEventId);
    } catch (probeErr) {
      if (googleGoneStatus(probeErr) === null) throw probeErr;
      listed = null;
    }

    if (listed?.status === 'cancelled') {
      await handleParticipantDelete(link.user_id, link, deps);
      record('delete', googleEventId, { probe: 'cancelled', outcome: 'declined' });
      return;
    }
    if (listed) throw err;

    const created = await this.insertParticipantCopy(api, participantSyncRepo, link, calendarId, copy.gEvent);
    const newGoogleEventId = created.id ?? undefined;
    record('create', newGoogleEventId, {
      probe: 'not_found',
      outcome: 'recreated',
      new_google_event_id: newGoogleEventId,
    });
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
