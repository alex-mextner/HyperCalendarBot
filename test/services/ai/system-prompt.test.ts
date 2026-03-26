import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { ReminderRepository } from '../../../src/database/repositories/reminder.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { buildSystemPrompt } from '../../../src/services/ai/system-prompt.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('buildSystemPrompt', () => {
  let db: Database;
  let ctx: AgentContext;
  const USER_ID = 123;

  beforeEach(() => {
    db = createTestDb();
    const userRepo = new UserRepository(db);
    const eventRepo = new EventRepository(db);
    const reminderRepo = new ReminderRepository(db);
    const chatHistoryRepo = new ChatHistoryRepository(db);
    const holidayRepo = new HolidayRepository(db);
    const user = userRepo.create({
      telegram_id: USER_ID,
      username: 'testuser',
      first_name: 'Test',
      timezone: 'Europe/Kyiv',
      language: 'en',
    });
    const eventService = new EventService({ eventRepo, reminderRepo });
    const holidayService = new HolidayService(holidayRepo);
    ctx = {
      user,
      chatId: USER_ID,
      messageText: 'hello',
      isGroup: false,
      eventService,
      holidayService,
      chatHistory: chatHistoryRepo,
      userRepo,
      reminderRepo,
      conversationLogger: null as never,
    };
  });

  test('includes user timezone', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Europe/Kyiv');
  });

  test('includes user name', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Test');
  });

  test('includes user language', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('en');
  });

  test('includes formatting rules', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('ISO 8601');
  });

  test('instructs AI to always use tools for event data', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('ALWAYS use tools');
    expect(prompt).toContain('get_events');
  });

  test('includes get_upcoming rule', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('get_upcoming');
  });

  test('includes snooze_event rule', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('snooze_event');
  });

  test('includes get_reminders rule', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('get_reminders');
  });

  test('includes UTC offset for timezone conversion', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toMatch(/UTC\+\d/);
  });

  test('does not include current date/time (injected per-message instead)', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).not.toContain('Current local time');
    expect(prompt).not.toContain('Current UTC time');
  });

  test('instructs to create events immediately without confirmation', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('create immediately');
    expect(prompt).not.toContain('always confirm the details before creating');
  });

  test('instructs to use pick_users and find_contact for invitations', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('pick_users');
    expect(prompt).toContain('find_contact');
    expect(prompt).toContain('EXACT sequence');
  });

  test('includes group context block when isGroup is true', () => {
    ctx.isGroup = true;
    ctx.groupChatId = -100999;
    ctx.groupTitle = 'Dev Team';
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('## Group Context');
    expect(prompt).toContain('Dev Team');
    expect(prompt).toContain('-100999');
    expect(prompt).toContain('[SKIP]');
    expect(prompt).toContain('group calendar');
  });

  test('does NOT include group context block in DM', () => {
    ctx.isGroup = false;
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).not.toContain('## Group Context');
    expect(prompt).not.toContain('[SKIP]');
  });

  test('includes language instruction for ru user', () => {
    const userRepo = new UserRepository(db);
    userRepo.update(USER_ID, { language: 'ru' });
    ctx.user = userRepo.findByTelegramId(USER_ID)!;

    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Russian');
  });

  test('includes shared events instructions', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Shared Events');
    expect(prompt).toContain('notify_participants');
    expect(prompt).toContain('propose_edit');
    expect(prompt).toContain('declines the invitation');
  });

  test('includes secretaryForLine in User Info when present', () => {
    ctx.secretary = {
      secretaryRepo: undefined as never,
      secretaryForLine: '@alice_cto (read+write)',
      calendarProposalRepo: undefined as never,
    };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Calendars you can manage as secretary: @alice_cto (read+write)');
  });

  test('omits secretary line when secretaryForLine absent', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).not.toContain('Calendars you can manage as secretary');
  });

  test('includes Secretary Access rules block when secretaryForLine present', () => {
    ctx.secretary = {
      secretaryRepo: undefined as never,
      secretaryForLine: '@bob_pm (read only)',
      calendarProposalRepo: undefined as never,
    };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('## Secretary Access');
  });

  test('group context includes Group Proposals rules when isGroup=true', () => {
    ctx.isGroup = true;
    ctx.groupTitle = 'Dev Team';
    ctx.groupChatId = -100;
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('## Group Proposals');
    expect(prompt).toContain('propose_calendar_change');
  });

  test('group proposals rules absent in private chat', () => {
    ctx.isGroup = false;
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).not.toContain('## Group Proposals');
  });

  test('group context includes privacy rules when isGroup=true', () => {
    ctx.isGroup = true;
    ctx.groupTitle = 'Dev Team';
    ctx.groupChatId = -100;
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('## Group Privacy');
    expect(prompt).toContain('ask_user');
    expect(prompt).toContain('private');
  });

  test('privacy rules absent in private chat', () => {
    ctx.isGroup = false;
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).not.toContain('## Group Privacy');
  });

  test('group context includes botUsername in help instruction when provided', () => {
    ctx.isGroup = true;
    ctx.groupTitle = 'Dev Team';
    ctx.groupChatId = -100;
    ctx.botUsername = 'mycalbot';
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('@mycalbot');
  });

  test('group context falls back to @mention when botUsername absent', () => {
    ctx.isGroup = true;
    ctx.groupTitle = 'Dev Team';
    ctx.groupChatId = -100;
    ctx.botUsername = undefined;
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('@mention');
  });

  test('requires AI to use calculate tool for any arithmetic', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('CALCULATE RULE');
    expect(prompt).toContain('calculate');
    expect(prompt).toContain('Never compute in your head');
  });

  test('language instruction uses interface language framing, not user-speaks framing', () => {
    ctx.user = { ...ctx.user, language: 'ru' };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Bot interface language is Russian');
    expect(prompt).not.toContain('The user speaks Russian');
  });

  test('language instruction tells AI to respond in configured language regardless of input language', () => {
    ctx.user = { ...ctx.user, language: 'en' };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('even if the user writes in a different language');
  });

  test('language instruction tells AI to call manage_settings for language change requests', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('manage_settings');
    expect(prompt).toContain('"ru"');
    expect(prompt).toContain('"en"');
  });

  test('system prompt includes default duration when set', () => {
    ctx.user = { ...ctx.user, default_event_duration_minutes: 45 };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Default event duration: 45 minutes');
  });

  test('system prompt includes 60 min default', () => {
    ctx.user = { ...ctx.user, default_event_duration_minutes: 60 };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Default event duration: 60 minutes');
  });

  test('forbids markdown tables', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('Never use markdown tables');
  });

  describe('supplement mode section', () => {
    test('supplement section absent when supplementMode is not set', () => {
      const prompt = buildSystemPrompt(ctx);
      expect(prompt).not.toContain('Supplement Mode');
    });

    test('supplement section absent when supplementMode is false', () => {
      ctx.supplementMode = false;
      const prompt = buildSystemPrompt(ctx);
      expect(prompt).not.toContain('Supplement Mode');
    });

    test('supplement section present when supplementMode is true', () => {
      ctx.supplementMode = true;
      const prompt = buildSystemPrompt(ctx);
      expect(prompt).toContain('Supplement Mode');
      expect(prompt).toContain('supplement_skip');
      expect(prompt).toContain('rule-based intent system');
    });
  });

  test('does not include scene section when scenePauseState is absent', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).not.toContain('## Scene Paused');
  });

  test('includes scene section when scenePauseState is set', () => {
    ctx.scene = {
      scenePauseState: { sceneName: 'add_event', step: 1, sceneState: { title: 'Team meeting' } },
      scenePauseService: undefined as never,
    };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('## Scene Paused');
    expect(prompt).toContain('add_event');
    expect(prompt).toContain('step 1');
    expect(prompt).toContain('Team meeting');
  });

  test('scene section mentions resume_scene and cancel_scene tools', () => {
    ctx.scene = {
      scenePauseState: { sceneName: 'edit_value', step: 0, sceneState: {} },
      scenePauseService: undefined as never,
    };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('resume_scene');
    expect(prompt).toContain('cancel_scene');
  });

  test('scene section shows "(none yet)" when sceneState is empty', () => {
    ctx.scene = {
      scenePauseState: { sceneName: 'add_event', step: 0, sceneState: {} },
      scenePauseService: undefined as never,
    };
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('(none yet)');
  });

  test('instructs AI that user times are local and must be converted to UTC', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).toContain('CRITICAL');
    expect(prompt).toContain('local timezone');
    expect(prompt).toContain('NEVER append "Z" to a local time');
    expect(prompt).toContain('calculate');
  });

  test('does not tell AI to pass LITERAL times to tools', () => {
    const prompt = buildSystemPrompt(ctx);
    expect(prompt).not.toContain('pass the LITERAL date/time');
  });
});
