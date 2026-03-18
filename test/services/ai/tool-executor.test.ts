import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { ReminderRepository } from '../../../src/database/repositories/reminder.repository.ts';
import { SharedEventRepository } from '../../../src/database/repositories/shared-event.repository.ts';
import { SharingSettingsRepository } from '../../../src/database/repositories/sharing-settings.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { executeTool } from '../../../src/services/ai/tool-executor.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';
import { InvitationService } from '../../../src/services/sharing/invitation-service.ts';
import { PrivacyService } from '../../../src/services/sharing/privacy-service.ts';
import { SharingService } from '../../../src/services/sharing/sharing-service.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('executeTool', () => {
  let ctx: AgentContext;
  const USER_ID = 123;

  beforeEach(() => {
    const db = createTestDb();
    const userRepo = new UserRepository(db);
    const eventRepo = new EventRepository(db);
    const reminderRepo = new ReminderRepository(db);
    const chatHistoryRepo = new ChatHistoryRepository(db);
    const holidayRepo = new HolidayRepository(db);
    userRepo.create({ telegram_id: USER_ID, timezone: 'UTC' });
    const eventService = new EventService(eventRepo, reminderRepo);
    const holidayService = new HolidayService(holidayRepo);
    ctx = {
      user: userRepo.findByTelegramId(USER_ID)!,
      chatId: USER_ID,
      messageText: '',
      isGroup: false,
      eventService,
      holidayService,
      chatHistory: chatHistoryRepo,
      userRepo,
      reminderRepo,
    };
  });

  test('routes get_events to handler', () => {
    const result = executeTool(ctx, 'get_events', {
      start_date: '2026-03-15T00:00:00Z',
      end_date: '2026-03-15T23:59:59Z',
    });
    expect(result.success).toBe(true);
  });

  test('routes create_event to handler', () => {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 11);
    const result = executeTool(ctx, 'create_event', {
      title: 'Test',
      start_at: `${tomorrow}14:00:00Z`,
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Test');
  });

  test('routes update_event to handler', () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Old',
      start_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC',
    });
    const result = executeTool(ctx, 'update_event', {
      event_id: event.id,
      title: 'New',
    });
    expect(result.success).toBe(true);
  });

  test('routes delete_event to handler', () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Del',
      start_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC',
    });
    const result = executeTool(ctx, 'delete_event', { event_id: event.id });
    expect(result.success).toBe(true);
  });

  test('routes get_free_slots to handler', () => {
    const result = executeTool(ctx, 'get_free_slots', {
      date: '2026-03-15T00:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  test('routes search_events to handler', () => {
    const result = executeTool(ctx, 'search_events', { query: 'test' });
    expect(result.success).toBe(true);
  });

  test('routes set_reminder to handler', () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Meeting',
      start_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC',
    });
    const result = executeTool(ctx, 'set_reminder', {
      event_id: event.id,
      minutes_before: [15],
    });
    expect(result.success).toBe(true);
  });

  test('routes get_holidays to handler', () => {
    const result = executeTool(ctx, 'get_holidays', {});
    expect(result.success).toBe(true);
  });

  test('routes manage_settings get to handler', () => {
    const result = executeTool(ctx, 'manage_settings', { action: 'get' });
    expect(result.success).toBe(true);
  });

  test('routes manage_settings update to handler', () => {
    const result = executeTool(ctx, 'manage_settings', {
      action: 'update',
      category: 'general',
      updates: { timezone: 'Europe/London' },
    });
    expect(result.success).toBe(true);
  });

  test('routes get_upcoming to handler', () => {
    const result = executeTool(ctx, 'get_upcoming', {});
    expect(result.success).toBe(true);
  });

  test('routes snooze_event to handler', () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Snooze Me',
      start_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC',
    });
    const result = executeTool(ctx, 'snooze_event', { event_id: event.id, minutes: 15 });
    expect(result.success).toBe(true);
    expect(result.output).toContain('snoozed');
  });

  test('routes get_event to handler', () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Get Me',
      start_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC',
    });
    const result = executeTool(ctx, 'get_event', { event_id: event.id });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Get Me');
  });

  test('routes get_reminders to handler', () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Remind Me',
      start_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC',
    });
    const result = executeTool(ctx, 'get_reminders', { event_id: event.id });
    expect(result.success).toBe(true);
  });

  test('returns error for unknown tool', () => {
    const result = executeTool(ctx, 'unknown_tool', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown tool');
  });

  describe('sharing tools', () => {
    let sharingCtx: AgentContext;
    let eventRepo: EventRepository;
    let invitationRepo: InvitationRepository;
    let sharingSettingsRepo: SharingSettingsRepository;
    let sharedEventRepo: SharedEventRepository;

    beforeEach(() => {
      const db = createTestDb();
      const userRepo = new UserRepository(db);
      eventRepo = new EventRepository(db);
      const reminderRepo = new ReminderRepository(db);
      const chatHistoryRepo = new ChatHistoryRepository(db);
      const holidayRepo = new HolidayRepository(db);
      invitationRepo = new InvitationRepository(db);
      sharingSettingsRepo = new SharingSettingsRepository(db);
      sharedEventRepo = new SharedEventRepository(db);

      userRepo.create({ telegram_id: USER_ID, timezone: 'UTC' });
      const eventService = new EventService(eventRepo, reminderRepo);
      const holidayService = new HolidayService(holidayRepo);
      const invitationService = new InvitationService(invitationRepo, eventRepo, sharingSettingsRepo);
      const privacyService = new PrivacyService(sharingSettingsRepo);
      const sharingService = new SharingService(eventRepo, privacyService);

      sharingCtx = {
        user: userRepo.findByTelegramId(USER_ID)!,
        chatId: USER_ID,
        messageText: '',
        eventService,
        holidayService,
        chatHistory: chatHistoryRepo,
        userRepo,
        reminderRepo,
        invitationService,
        invitationRepo,
        sharingService,
        sharingSettingsRepo,
        sharedEventRepo,
      };
    });

    test('share_event returns error when sharing not configured', () => {
      const result = executeTool(ctx, 'share_event', {
        event_id: 1,
        target_type: 'user',
        target_id: 456,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });

    test('share_event shares an existing event', () => {
      const event = sharingCtx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Shared Meeting',
        start_at: '2026-03-15T14:00:00Z',
        timezone: 'UTC',
      });
      const result = executeTool(sharingCtx, 'share_event', {
        event_id: event.id,
        target_type: 'user',
        target_id: 456,
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Shared Meeting');
      expect(result.output).toContain('456');
    });

    test('share_event returns error for non-existent event', () => {
      const result = executeTool(sharingCtx, 'share_event', {
        event_id: 9999,
        target_type: 'user',
        target_id: 456,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('send_invitation returns error when invitations not configured', () => {
      const result = executeTool(ctx, 'send_invitation', {
        event_id: 1,
        invitee_id: 456,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });

    test('send_invitation sends invitation for existing event', () => {
      const event = sharingCtx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Invite Test',
        start_at: '2026-03-15T14:00:00Z',
        timezone: 'UTC',
      });
      const result = executeTool(sharingCtx, 'send_invitation', {
        event_id: event.id,
        invitee_id: 456,
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Invitation');
      expect(result.output).toContain('456');
    });

    test('send_invitation returns error for non-existent event', () => {
      const result = executeTool(sharingCtx, 'send_invitation', {
        event_id: 9999,
        invitee_id: 456,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('get_invitation_status returns error when invitations not configured', () => {
      const result = executeTool(ctx, 'get_invitation_status', { event_id: 1 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });

    test('get_invitation_status returns no invitations for event without any', () => {
      const event = sharingCtx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Status Test',
        start_at: '2026-03-15T14:00:00Z',
        timezone: 'UTC',
      });
      const result = executeTool(sharingCtx, 'get_invitation_status', { event_id: event.id });
      expect(result.success).toBe(true);
      expect(result.output).toContain('No invitations');
    });

    test('get_invitation_status lists pending and accepted invitations', () => {
      const event = sharingCtx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Party',
        start_at: '2026-03-15T14:00:00Z',
        timezone: 'UTC',
      });
      invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: 456 });
      const inv2 = invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: 789 });
      invitationRepo.updateStatus(inv2.id, 'accepted', 'pending');

      const result = executeTool(sharingCtx, 'get_invitation_status', { event_id: event.id });
      expect(result.success).toBe(true);
      expect(result.output).toContain('456');
      expect(result.output).toContain('789');
      expect(result.output).toContain('accepted');
      expect(result.output).toContain('pending');
    });

    test('get_invitation_status returns error for non-existent event', () => {
      const result = executeTool(sharingCtx, 'get_invitation_status', { event_id: 9999 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('manage_settings update privacy returns error when not configured', () => {
      const result = executeTool(ctx, 'manage_settings', {
        action: 'update',
        category: 'privacy',
        updates: { default_visibility: 'full' },
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });

    test('manage_settings update privacy updates visibility setting', () => {
      const result = executeTool(sharingCtx, 'manage_settings', {
        action: 'update',
        category: 'privacy',
        updates: { default_visibility: 'full' },
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('default_visibility');
      expect(result.output).toContain('full');
    });

    test('manage_settings update privacy updates multiple settings', () => {
      const result = executeTool(sharingCtx, 'manage_settings', {
        action: 'update',
        category: 'privacy',
        updates: { default_visibility: 'free_busy', inline_mode_enabled: false, allow_invitations: false },
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('free_busy');
      expect(result.output).toContain('inline_mode_enabled');
      expect(result.output).toContain('allow_invitations');
    });

    test('manage_settings update privacy returns error when no updates provided', () => {
      const result = executeTool(sharingCtx, 'manage_settings', {
        action: 'update',
        category: 'privacy',
        updates: {},
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('updates');
    });

    test('share_agenda returns error when sharing not configured', () => {
      const result = executeTool(ctx, 'share_agenda', {
        period: 'today',
        target_type: 'user',
        target_id: 456,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });

    test('share_agenda returns no events when agenda is empty', () => {
      const result = executeTool(sharingCtx, 'share_agenda', {
        period: 'today',
        target_type: 'user',
        target_id: 456,
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('No visible events');
    });

    test('share_agenda shares visible events for today', () => {
      // Set visibility to full so events are shareable
      sharingSettingsRepo.ensureDefaults(USER_ID);
      sharingSettingsRepo.update(USER_ID, { default_visibility: 'full' });

      const now = new Date();
      sharingCtx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Today Event',
        start_at: now.toISOString(),
        timezone: 'UTC',
      });

      const result = executeTool(sharingCtx, 'share_agenda', {
        period: 'today',
        target_type: 'user',
        target_id: 456,
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Today Event');
      expect(result.output).toContain('456');
    });

    test('set_event_visibility returns error when not configured', () => {
      const result = executeTool(ctx, 'set_event_visibility', {
        event_id: 1,
        visibility: 'full',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });

    test('set_event_visibility sets visibility on existing event', () => {
      const event = sharingCtx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Visible Event',
        start_at: '2026-03-15T14:00:00Z',
        timezone: 'UTC',
      });
      const result = executeTool(sharingCtx, 'set_event_visibility', {
        event_id: event.id,
        visibility: 'full',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Visible Event');
      expect(result.output).toContain('full');
    });

    test('set_event_visibility returns error for non-existent event', () => {
      const result = executeTool(sharingCtx, 'set_event_visibility', {
        event_id: 9999,
        visibility: 'full',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });
});
