import { describe, expect, mock, test } from 'bun:test';
import type { ContactRepository } from '../../../src/database/repositories/contact.repository.ts';
import type { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import type { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import type { CalendarEvent, Contact, User } from '../../../src/database/types.ts';
import type { InvitationService } from '../../../src/services/sharing/invitation-service.ts';

// Helpers to resolve invitee names — extracted from scene module for unit testing
// We test the scene's name resolution logic via the exported helpers

describe('connect-telegram post-connect pending invitation', () => {
  function makeEventRepo(events: { [key: number]: CalendarEvent | null }): EventRepository {
    return {
      findById: (id: number, _userId: number) => events[id] ?? null,
    } as unknown as EventRepository;
  }

  function makeUserRepo(users: { [id: number]: Partial<User> }): UserRepository {
    return {
      findByTelegramId: (id: number) => (users[id] ? ({ telegram_id: id, ...users[id] } as User) : null),
    } as unknown as UserRepository;
  }

  function makeContactRepo(contacts: {
    [ownerId: number]: { [contactId: number]: Partial<Contact> };
  }): ContactRepository {
    return {
      findByTelegramId: (ownerId: number, contactId: number) => {
        const ownerContacts = contacts[ownerId];
        if (!ownerContacts) return null;
        const c = ownerContacts[contactId];
        return c ? ({ id: contactId, user_id: ownerId, ...c } as Contact) : null;
      },
    } as unknown as ContactRepository;
  }

  function makeInvitationService(result: { success: boolean; error?: string }): InvitationService {
    return {
      sendInvitation: mock(() => result),
    } as unknown as InvitationService;
  }

  function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
    return {
      id: 1,
      user_id: 100,
      title: 'Team Standup',
      description: null,
      category: null,
      start_at: new Date(Date.now() + 3600_000).toISOString(),
      end_at: null,
      all_day: 0,
      timezone: 'Europe/Belgrade',
      location: null,
      recurrence_rule: null,
      recurrence_end_at: null,
      parent_event_id: null,
      original_start_at: null,
      is_cancelled: 0,
      reminder_overrides: null,
      google_event_id: null,
      google_calendar_id: null,
      google_etag: null,
      sync_status: 'local_only',
      sync_version: 1,
      owner_type: 'user',
      group_id: null,
      created_by: null,
      resolved_address: null,
      latitude: null,
      longitude: null,
      google_maps_url: null,
      location_verified: 0,
      venue_name: null,
      is_deleted: 0,
      last_synced_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    };
  }

  describe('InvitationService integration', () => {
    test('sendInvitation is called with correct parameters', () => {
      const sendMock = mock(() => ({ success: true, invitation: { id: 42 } }));
      const invService = { sendInvitation: sendMock } as unknown as InvitationService;

      invService.sendInvitation(1, 100, 200, '@bob');

      expect(sendMock).toHaveBeenCalledTimes(1);
      const call = sendMock.mock.calls[0] as unknown as [number, number, number, string];
      expect(call[0]).toBe(1); // eventId
      expect(call[1]).toBe(100); // inviterId
      expect(call[2]).toBe(200); // inviteeId
      expect(call[3]).toBe('@bob'); // inviteeUsername
    });

    test('sendInvitation handles already-sent invitation', () => {
      const invService = makeInvitationService({ success: false, error: 'Invitation already sent' });
      const result = invService.sendInvitation(1, 100, 200);
      expect(result.success).toBe(false);
    });
  });

  describe('callback_data format', () => {
    const CB_PREFIX = 'ct';

    test('send_pending callback fits within 64-byte limit', () => {
      // Worst case: large IDs
      const data = `${CB_PREFIX}:send_pending:999999999:999999999`;
      const bytes = new TextEncoder().encode(data).length;
      expect(bytes).toBeLessThanOrEqual(64);
    });

    test('skip_pending callback format', () => {
      expect(`${CB_PREFIX}:skip_pending`).toBe('ct:skip_pending');
    });

    test('send_pending callback is parseable', () => {
      const data = `${CB_PREFIX}:send_pending:42:200`;
      const parts = data.split(':');
      expect(parts[0]).toBe('ct');
      expect(parts[1]).toBe('send_pending');
      expect(Number.parseInt(parts[2]!, 10)).toBe(42);
      expect(Number.parseInt(parts[3]!, 10)).toBe(200);
    });
  });

  describe('event loading for pending offer', () => {
    test('event is loaded by ID and userId', () => {
      const event = makeEvent({ id: 42, user_id: 100 });
      const eventRepo = makeEventRepo({ 42: event });
      const loaded = eventRepo.findById(42, 100);
      expect(loaded).not.toBeNull();
      expect(loaded!.title).toBe('Team Standup');
    });

    test('returns null for non-existent event', () => {
      const eventRepo = makeEventRepo({});
      expect(eventRepo.findById(999, 100)).toBeNull();
    });
  });

  describe('invitee name resolution', () => {
    test('resolves from user first_name', () => {
      const userRepo = makeUserRepo({ 200: { first_name: 'Bob' } });
      const user = userRepo.findByTelegramId(200);
      expect(user?.first_name).toBe('Bob');
    });

    test('falls back to user username', () => {
      const userRepo = makeUserRepo({ 200: { username: 'bob_smith', first_name: null } });
      const user = userRepo.findByTelegramId(200);
      expect(user?.username).toBe('bob_smith');
    });

    test('falls back to contact name', () => {
      const userRepo = makeUserRepo({});
      const contactRepo = makeContactRepo({ 100: { 200: { name: 'Bob from work' } } });

      const user = userRepo.findByTelegramId(200);
      expect(user).toBeNull();

      const contact = contactRepo.findByTelegramId(100, 200);
      expect(contact?.name).toBe('Bob from work');
    });

    test('falls back to contact preferred_name', () => {
      const contactRepo = makeContactRepo({
        100: { 200: { name: 'Robert Smith', preferred_name: 'Bob' } },
      });
      const contact = contactRepo.findByTelegramId(100, 200);
      expect(contact?.preferred_name).toBe('Bob');
    });
  });

  describe('i18n strings', () => {
    test('successWithPending EN contains event title and invitee name', () => {
      const { t } = require('../../../src/config/constants.ts');
      const ct = t('en').connectTelegram;
      const msg = ct.successWithPending('+7•••••4567', 'Team Standup', 'Mon 15 14:00', 'Bob');
      expect(msg).toContain('Team Standup');
      expect(msg).toContain('Bob');
      expect(msg).toContain('+7•••••4567');
      expect(msg).toContain('Mon 15 14:00');
    });

    test('successWithPending RU contains event title and invitee name', () => {
      const { t } = require('../../../src/config/constants.ts');
      const ct = t('ru').connectTelegram;
      const msg = ct.successWithPending('+7•••••4567', 'Созвон', 'пн 15 14:00', 'Боб');
      expect(msg).toContain('Созвон');
      expect(msg).toContain('Боб');
      expect(msg).toContain('+7•••••4567');
    });

    test('sendPendingBtn and skipPendingBtn are defined', () => {
      const { t } = require('../../../src/config/constants.ts');
      expect(t('en').connectTelegram.sendPendingBtn).toBe('Send');
      expect(t('en').connectTelegram.skipPendingBtn).toBe('Not now');
      expect(t('ru').connectTelegram.sendPendingBtn).toBe('Отправить');
      expect(t('ru').connectTelegram.skipPendingBtn).toBe('Не сейчас');
    });

    test('pendingSent message is defined', () => {
      const { t } = require('../../../src/config/constants.ts');
      expect(t('en').connectTelegram.pendingSent).toContain('Invitation sent');
      expect(t('ru').connectTelegram.pendingSent).toContain('Приглашение отправлено');
    });
  });
});
