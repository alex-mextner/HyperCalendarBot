import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { SharedEventRepository } from '../../../src/database/repositories/shared-event.repository.ts';
import { SharingSettingsRepository } from '../../../src/database/repositories/sharing-settings.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { _resetToolThrottleForTest, executeTool } from '../../../src/services/ai/tool-executor.ts';
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
  let effectDb: Database;
  const USER_ID = 123;

  beforeEach(() => {
    // Throttle state is module-level and must not leak between tests that
    // reuse the same (chatId, toolName, args) tuple.
    _resetToolThrottleForTest();
    const db = createTestDb();
    effectDb = db;
    const userRepo = new UserRepository(db);
    const eventRepo = new EventRepository(db);
    const eventReminderRepo = new EventReminderRepository(db);
    const chatHistoryRepo = new ChatHistoryRepository(db);
    const holidayRepo = new HolidayRepository(db);
    userRepo.create({ telegram_id: USER_ID, timezone: 'UTC' });
    const eventService = new EventService({ eventRepo });
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
      eventReminderRepo,
      conversationLogger: null as never,
    };
  });

  test.each([
    'delete_event',
    'update_event',
  ] as const)('%s accepts canonical string IDs and denies wrong owners', async (name) => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Synthetic',
      start_at: '2030-01-01T10:00:00Z',
      timezone: 'UTC',
    });
    effectDb.exec('CREATE TEMP TABLE effects (operation TEXT)');
    effectDb.exec(
      "CREATE TEMP TRIGGER count_update AFTER UPDATE ON events BEGIN INSERT INTO effects VALUES ('update'); END",
    );
    effectDb.exec(
      "CREATE TEMP TRIGGER count_delete AFTER DELETE ON events BEGIN INSERT INTO effects VALUES ('delete'); END",
    );
    ctx.userRepo.create({ telegram_id: 789, timezone: 'UTC' });
    const outsider = { ...ctx, user: ctx.userRepo.findByTelegramId(789)!, chatId: 789 };
    const input = { event_id: String(event.id), title: 'Changed' };
    expect((await executeTool(outsider, name, input)).success).toBe(false);
    expect(ctx.eventService.getEvent(event.id, USER_ID)?.title).toBe('Synthetic');
    expect((await executeTool(ctx, name, input)).success).toBe(true);
    expect(ctx.eventService.getEvent(event.id, USER_ID)?.title).toBe(name === 'delete_event' ? undefined : 'Changed');
    await executeTool(ctx, name, { ...input, event_id: event.id });
    expect(effectDb.query<{ count: number }, []>('SELECT count(*) AS count FROM effects').get()?.count).toBe(1);
  });

  test('routes get_events to handler', async () => {
    const result = await executeTool(ctx, 'get_events', {
      start_date: '2026-03-15T00:00:00Z',
      end_date: '2026-03-15T23:59:59Z',
    });
    expect(result.success).toBe(true);
  });

  test('routes create_event to handler', async () => {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 11);
    const result = await executeTool(ctx, 'create_event', {
      title: 'Test',
      start_at: `${tomorrow}14:00:00Z`,
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Test');
  });

  test('routes update_event to handler', async () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Old',
      start_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC',
    });
    const result = await executeTool(ctx, 'update_event', {
      event_id: event.id,
      title: 'New',
    });
    expect(result.success).toBe(true);
  });

  test('routes delete_event to handler', async () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Del',
      start_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC',
    });
    const result = await executeTool(ctx, 'delete_event', { event_id: event.id });
    expect(result.success).toBe(true);
  });

  test('routes get_free_slots to handler', async () => {
    const result = await executeTool(ctx, 'get_free_slots', {
      date: '2026-03-15T00:00:00Z',
    });
    expect(result.success).toBe(true);
  });

  test('routes search_events to handler', async () => {
    const result = await executeTool(ctx, 'search_events', { query: 'test' });
    expect(result.success).toBe(true);
  });

  test('routes set_reminder to handler', async () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Meeting',
      start_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC',
    });
    const result = await executeTool(ctx, 'set_reminder', {
      event_id: event.id,
      minutes_before: [15],
    });
    expect(result.success).toBe(true);
  });

  test('routes get_holidays to handler', async () => {
    const result = await executeTool(ctx, 'get_holidays', {});
    expect(result.success).toBe(true);
  });

  test('routes manage_settings get to handler', async () => {
    const result = await executeTool(ctx, 'manage_settings', { action: 'get' });
    expect(result.success).toBe(true);
  });

  test('routes manage_settings update to handler', async () => {
    const result = await executeTool(ctx, 'manage_settings', {
      action: 'update',
      category: 'general',
      updates: { timezone: 'Europe/London' },
    });
    expect(result.success).toBe(true);
  });

  test('routes get_upcoming to handler', async () => {
    const result = await executeTool(ctx, 'get_upcoming', {});
    expect(result.success).toBe(true);
  });

  test('routes snooze_event to handler', async () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Snooze Me',
      start_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC',
    });
    const result = await executeTool(ctx, 'snooze_event', { event_id: event.id, minutes: 15 });
    expect(result.success).toBe(true);
    expect(result.output).toContain('snoozed');
  });

  test('routes get_event to handler', async () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Get Me',
      start_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC',
    });
    const result = await executeTool(ctx, 'get_event', { event_id: event.id });
    expect(result.success).toBe(true);
    expect(result.output).toContain('Get Me');
  });

  test('routes get_reminders to handler', async () => {
    const event = ctx.eventService.createEvent({
      user_id: USER_ID,
      title: 'Remind Me',
      start_at: '2026-03-15T10:00:00Z',
      timezone: 'UTC',
    });
    const result = await executeTool(ctx, 'get_reminders', { event_id: event.id });
    expect(result.success).toBe(true);
  });

  test('returns error for unknown tool', async () => {
    const result = await executeTool(ctx, 'unknown_tool', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('Unknown tool');
  });

  test('supplement_skip returns stopLoop:true', async () => {
    const result = await executeTool(ctx, 'supplement_skip', {});
    expect(result.success).toBe(true);
    expect(result.stopLoop).toBe(true);
  });

  describe('sharing tools', () => {
    let sharingCtx: AgentContext;
    let sharingDb: Database;
    let eventRepo: EventRepository;
    let invitationRepo: InvitationRepository;
    let sharingSettingsRepo: SharingSettingsRepository;
    let sharedEventRepo: SharedEventRepository;

    beforeEach(() => {
      const db = createTestDb();
      sharingDb = db;
      const userRepo = new UserRepository(db);
      eventRepo = new EventRepository(db);
      const eventReminderRepo = new EventReminderRepository(db);
      const chatHistoryRepo = new ChatHistoryRepository(db);
      const holidayRepo = new HolidayRepository(db);
      invitationRepo = new InvitationRepository(db);
      sharingSettingsRepo = new SharingSettingsRepository(db);
      sharedEventRepo = new SharedEventRepository(db);

      userRepo.create({ telegram_id: USER_ID, timezone: 'UTC' });
      const eventService = new EventService({ eventRepo });
      const holidayService = new HolidayService(holidayRepo);
      const invitationService = new InvitationService(invitationRepo, eventRepo, sharingSettingsRepo);
      const privacyService = new PrivacyService(sharingSettingsRepo);
      const sharingService = new SharingService(
        (userId, startUtc, endUtc) => eventService.getEventsInRange(userId, startUtc, endUtc),
        privacyService,
      );

      sharingCtx = {
        user: userRepo.findByTelegramId(USER_ID)!,
        chatId: USER_ID,
        messageText: '',
        isGroup: false,
        eventService,
        holidayService,
        chatHistory: chatHistoryRepo,
        userRepo,
        eventReminderRepo,
        sharing: {
          invitationService,
          invitationRepo,
          sharingService,
          sharingSettingsRepo,
          sharedEventRepo,
          privacyService: undefined as never,
          editProposalRepo: undefined as never,
        },
        conversationLogger: null as never,
      };
    });

    test('share_event returns error when sharing not configured', async () => {
      const result = await executeTool(ctx, 'share_event', {
        event_id: 1,
        target_type: 'user',
        target_id: 456,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });

    test('share_event shares an existing event', async () => {
      const event = sharingCtx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Shared Meeting',
        start_at: '2026-03-15T14:00:00Z',
        timezone: 'UTC',
      });
      const result = await executeTool(sharingCtx, 'share_event', {
        event_id: event.id,
        target_type: 'user',
        target_id: 456,
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Shared Meeting');
      expect(result.output).toContain('456');
    });

    test('share_event returns error for non-existent event', async () => {
      const result = await executeTool(sharingCtx, 'share_event', {
        event_id: 9999,
        target_type: 'user',
        target_id: 456,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('send_invitation returns error when invitations not configured', async () => {
      const result = await executeTool(ctx, 'send_invitation', {
        event_id: 1,
        invitee_id: 456,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });

    test('send_invitation sends invitation for existing event', async () => {
      const event = sharingCtx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Invite Test',
        start_at: '2026-03-15T14:00:00Z',
        timezone: 'UTC',
      });
      const result = await executeTool(sharingCtx, 'send_invitation', {
        event_id: event.id,
        invitee_id: 456,
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Invitation');
      expect(result.output).toContain('456');
    });

    test('send_invitation returns error for non-existent event', async () => {
      const result = await executeTool(sharingCtx, 'send_invitation', {
        event_id: 9999,
        invitee_id: 456,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('get_invitation_status returns error when invitations not configured', async () => {
      const result = await executeTool(ctx, 'get_invitation_status', { event_id: 1 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });

    test('get_invitation_status returns no invitations for event without any', async () => {
      const event = sharingCtx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Status Test',
        start_at: '2026-03-15T14:00:00Z',
        timezone: 'UTC',
      });
      const result = await executeTool(sharingCtx, 'get_invitation_status', { event_id: event.id });
      expect(result.success).toBe(true);
      expect(result.output).toContain('No invitations');
    });

    test('get_invitation_status lists pending and accepted invitations', async () => {
      const event = sharingCtx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Party',
        start_at: '2026-03-15T14:00:00Z',
        timezone: 'UTC',
      });
      invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: 456 });
      const inv2 = invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: 789 });
      invitationRepo.updateStatus(inv2.id, 'accepted', 'pending');

      const result = await executeTool(sharingCtx, 'get_invitation_status', { event_id: event.id });
      expect(result.success).toBe(true);
      expect(result.output).toContain('456');
      expect(result.output).toContain('789');
      expect(result.output).toContain('accepted');
      expect(result.output).toContain('pending');
    });

    test('get_invitation_status returns error for non-existent event', async () => {
      const result = await executeTool(sharingCtx, 'get_invitation_status', { event_id: 9999 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('manage_settings update privacy returns error when not configured', async () => {
      const result = await executeTool(ctx, 'manage_settings', {
        action: 'update',
        category: 'privacy',
        updates: { default_visibility: 'full' },
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });

    test('manage_settings update privacy updates visibility setting', async () => {
      const result = await executeTool(sharingCtx, 'manage_settings', {
        action: 'update',
        category: 'privacy',
        updates: { default_visibility: 'full' },
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('default_visibility');
      expect(result.output).toContain('full');
    });

    test('manage_settings update privacy updates multiple settings', async () => {
      const result = await executeTool(sharingCtx, 'manage_settings', {
        action: 'update',
        category: 'privacy',
        updates: { default_visibility: 'free_busy', inline_mode_enabled: false, allow_invitations: false },
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('free_busy');
      expect(result.output).toContain('inline_mode_enabled');
      expect(result.output).toContain('allow_invitations');
    });

    test('manage_settings update privacy returns error when no updates provided', async () => {
      const result = await executeTool(sharingCtx, 'manage_settings', {
        action: 'update',
        category: 'privacy',
        updates: {},
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('updates');
    });

    test('share_agenda returns error when sharing not configured', async () => {
      const result = await executeTool(ctx, 'share_agenda', {
        period: 'today',
        target_type: 'user',
        target_id: 456,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });

    test('share_agenda returns no events when agenda is empty', async () => {
      const result = await executeTool(sharingCtx, 'share_agenda', {
        period: 'today',
        target_type: 'user',
        target_id: 456,
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('No visible events');
    });

    test('share_agenda shares visible events for today', async () => {
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

      const result = await executeTool(sharingCtx, 'share_agenda', {
        period: 'today',
        target_type: 'user',
        target_id: 456,
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Today Event');
      expect(result.output).toContain('456');
    });

    test('send_invitation accepts string IDs with one real insertion and owner checks', async () => {
      const event = sharingCtx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Synthetic invitation',
        start_at: '2030-01-01T10:00:00Z',
        timezone: 'UTC',
      });
      sharingCtx.userRepo.create({ telegram_id: 789, timezone: 'UTC' });
      const input = { event_id: String(event.id), invitee_id: '789' };
      const outsider = { ...sharingCtx, user: sharingCtx.userRepo.findByTelegramId(789)!, chatId: 789 };
      expect((await executeTool(outsider, 'send_invitation', { ...input, invitee_id: '123' })).success).toBe(false);
      expect(invitationRepo.findActiveByEventAndInvitee(event.id, 789)).toBeNull();
      expect((await executeTool(sharingCtx, 'send_invitation', input)).success).toBe(true);
      const invitation = invitationRepo.findActiveByEventAndInvitee(event.id, 789);
      expect(invitation).not.toBeNull();
      await executeTool(sharingCtx, 'send_invitation', input);
      expect(invitationRepo.findActiveByEventAndInvitee(event.id, 789)?.id).toBe(invitation?.id);
      expect(sharingDb.query<{ count: number }, []>('SELECT count(*) AS count FROM invitations').get()?.count).toBe(1);
    });

    test('set_event_visibility returns error when not configured', async () => {
      const result = await executeTool(ctx, 'set_event_visibility', {
        event_id: 1,
        visibility: 'full',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });

    test('set_event_visibility sets visibility on existing event', async () => {
      const event = sharingCtx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Visible Event',
        start_at: '2026-03-15T14:00:00Z',
        timezone: 'UTC',
      });
      const result = await executeTool(sharingCtx, 'set_event_visibility', {
        event_id: event.id,
        visibility: 'full',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Visible Event');
      expect(result.output).toContain('full');
    });

    test('set_event_visibility returns error for non-existent event', async () => {
      const result = await executeTool(sharingCtx, 'set_event_visibility', {
        event_id: 9999,
        visibility: 'full',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('action log integration', () => {
    const futureDate = `${new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 11)}14:00:00Z`;
    const futureDate2 = `${new Date(Date.now() + 35 * 86400_000).toISOString().slice(0, 11)}10:00:00Z`;
    let actionCtx: AgentContext;
    let actionLogRepo: import('../../../src/database/repositories/action-log.repository.ts').ActionLogRepository;
    let testDb: ReturnType<typeof createTestDb>;

    beforeEach(async () => {
      const { ActionLogRepository } = await import('../../../src/database/repositories/action-log.repository.ts');
      const db = createTestDb();
      testDb = db;
      const userRepo = new UserRepository(db);
      const eventRepo = new EventRepository(db);
      const eventReminderRepo = new EventReminderRepository(db);
      const chatHistoryRepo = new ChatHistoryRepository(db);
      const holidayRepo = new HolidayRepository(db);
      actionLogRepo = new ActionLogRepository(db);
      userRepo.create({ telegram_id: USER_ID, timezone: 'UTC' });
      const eventService = new EventService({ eventRepo });
      actionCtx = {
        user: userRepo.findByTelegramId(USER_ID)!,
        chatId: USER_ID,
        messageText: '',
        isGroup: false,
        eventService,
        holidayService: new HolidayService(holidayRepo),
        chatHistory: chatHistoryRepo,
        userRepo,
        eventReminderRepo,
        conversationLogger: null as never,
        actionLogRepo,
      };
    });

    test('mutating tool call creates action log entry', async () => {
      const result = await executeTool(actionCtx, 'create_event', {
        title: 'Test Event',
        start_at: futureDate,
      });
      expect(result.success).toBe(true);

      const logs = actionLogRepo.query({ user_id: USER_ID, action_type: 'ai_tool' });
      expect(logs).toHaveLength(1);
      expect(logs[0]!.action_name).toBe('create_event');
      expect(logs[0]!.input_summary).toBe('Test Event');
      expect(logs[0]!.success).toBe(1);
      // create_event output starts with "id: N" — the event_id extractor should parse it
      expect(logs[0]!.target_event_id).not.toBeNull();
    });

    test('read-only tool call does not create action log entry', async () => {
      await executeTool(actionCtx, 'get_events', {
        start_date: '2026-03-15T00:00:00Z',
        end_date: '2026-03-15T23:59:59Z',
      });

      const logs = actionLogRepo.query({ user_id: USER_ID });
      expect(logs).toHaveLength(0);
    });

    test('failed tool call logs with success=0', async () => {
      await executeTool(actionCtx, 'delete_event', { event_id: 99999 });

      const logs = actionLogRepo.query({ user_id: USER_ID, action_name: 'delete_event' });
      expect(logs).toHaveLength(1);
      expect(logs[0]!.success).toBe(0);
    });

    test('action log stores metadata as JSON', async () => {
      await executeTool(actionCtx, 'create_event', {
        title: 'Metadata Test',
        start_at: futureDate2,
        description: 'Important meeting',
      });

      const logs = actionLogRepo.query({ user_id: USER_ID });
      expect(logs).toHaveLength(1);
      const meta = JSON.parse(logs[0]!.metadata!);
      expect(meta.title).toBe('Metadata Test');
      expect(meta.description).toBe('Important meeting');
    });

    test('invalid IDs are rejected and retained in the failed action log', async () => {
      const result = await executeTool(actionCtx, 'delete_event', { event_id: null });
      expect(result.success).toBe(false);
      const logs = actionLogRepo.query({ user_id: USER_ID, action_name: 'delete_event' });
      expect(logs).toHaveLength(1);
      expect(logs[0]?.success).toBe(0);
    });

    test('tool call without actionLogRepo does not throw', async () => {
      const ctxWithoutLog = { ...actionCtx, actionLogRepo: undefined };
      const result = await executeTool(ctxWithoutLog, 'create_event', {
        title: 'No Log',
        start_at: futureDate,
      });
      expect(result.success).toBe(true);
    });

    test('chatHistoryId is stored in action log entry', async () => {
      // Create a real chat_history row so FK constraint is satisfied
      const chatHistoryRepo = new ChatHistoryRepository(testDb);
      const historyId = chatHistoryRepo.save(USER_ID, 'user', 'create meeting tomorrow');
      actionCtx.chatHistoryId = historyId;

      await executeTool(actionCtx, 'create_event', {
        title: 'With History Link',
        start_at: futureDate,
      });

      const logs = actionLogRepo.query({ user_id: USER_ID });
      expect(logs).toHaveLength(1);
      expect(logs[0]!.chat_history_id).toBe(historyId);
    });

    test('inputMode is stored in metadata', async () => {
      actionCtx.inputMode = 'voice_message';
      await executeTool(actionCtx, 'create_event', {
        title: 'Voice Event',
        start_at: futureDate,
      });

      const logs = actionLogRepo.query({ user_id: USER_ID });
      expect(logs).toHaveLength(1);
      const meta = JSON.parse(logs[0]!.metadata!);
      expect(meta._inputMode).toBe('voice_message');
    });
  });

  // ── Cross-run time throttle ────────────────────────────────────────────────
  // Defence-in-depth against repeated tool calls with identical arguments
  // within a short time window — regardless of whether they come from a single
  // agent run or two back-to-back runs. Catches cases where in-run dedup would
  // not fire (e.g. the bot crashes, restarts, and the model asks for the same
  // rendering again within seconds).

  describe('time-based throttle', () => {
    beforeEach(() => {
      _resetToolThrottleForTest();
    });

    test('second identical call within 5s window is throttled (side-effect tool)', async () => {
      // Side-effect tools (not in SKIP_ACTION_LOG) are throttled
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Throttle Test',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      const r1 = await executeTool(ctx, 'update_event', { event_id: event.id, title: 'A' });
      expect(r1.success).toBe(true);
      expect(r1.output ?? '').not.toContain('THROTTLED');

      const r2 = await executeTool(ctx, 'update_event', { event_id: event.id, title: 'A' });
      expect(r2.success).toBe(true);
      expect(r2.output ?? '').toContain('THROTTLED');
    });

    test('throttle key normalizes argument order (side-effect tool)', async () => {
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Order Test',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      await executeTool(ctx, 'update_event', { event_id: event.id, title: 'B' });
      const r2 = await executeTool(ctx, 'update_event', { title: 'B', event_id: event.id });
      expect(r2.output ?? '').toContain('THROTTLED');
    });

    test('read-only tools are NOT throttled (exempt from cross-run throttle)', async () => {
      const r1 = await executeTool(ctx, 'get_events', {
        start_date: '2026-03-15T00:00:00Z',
        end_date: '2026-03-15T23:59:59Z',
      });
      const r2 = await executeTool(ctx, 'get_events', {
        start_date: '2026-03-15T00:00:00Z',
        end_date: '2026-03-15T23:59:59Z',
      });
      expect(r1.output ?? '').not.toContain('THROTTLED');
      expect(r2.output ?? '').not.toContain('THROTTLED');
    });

    test('different args are NOT throttled', async () => {
      const event1 = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'E1',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      const event2 = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'E2',
        start_at: '2026-03-16T10:00:00Z',
        timezone: 'UTC',
      });
      const r1 = await executeTool(ctx, 'update_event', { event_id: event1.id, title: 'X' });
      const r2 = await executeTool(ctx, 'update_event', { event_id: event2.id, title: 'X' });
      expect(r1.output ?? '').not.toContain('THROTTLED');
      expect(r2.output ?? '').not.toContain('THROTTLED');
    });

    test('different chats do NOT share throttle state', async () => {
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Chat Test',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      const otherCtx: AgentContext = { ...ctx, chatId: 999999 };
      await executeTool(ctx, 'update_event', { event_id: event.id, title: 'Y' });
      const r2 = await executeTool(otherCtx, 'update_event', { event_id: event.id, title: 'Y' });
      expect(r2.output ?? '').not.toContain('THROTTLED');
    });

    test('different tool names are NOT throttled against each other', async () => {
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 11);
      await executeTool(ctx, 'create_event', { title: 'Foo', start_at: `${tomorrow}14:00:00Z` });
      const r2 = await executeTool(ctx, 'create_event', { title: 'Bar', start_at: `${tomorrow}15:00:00Z` });
      expect(r2.output ?? '').not.toContain('THROTTLED');
    });

    test('throttle entry expires after TTL (simulated via reset)', async () => {
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'TTL Test',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      await executeTool(ctx, 'update_event', { event_id: event.id, title: 'Z' });
      _resetToolThrottleForTest();
      const r2 = await executeTool(ctx, 'update_event', { event_id: event.id, title: 'Z' });
      expect(r2.output ?? '').not.toContain('THROTTLED');
    });
  });
});
