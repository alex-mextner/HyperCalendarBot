import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../../../src/database/migrations.ts';
import { ChatHistoryRepository } from '../../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { HolidayRepository } from '../../../../src/database/repositories/holiday.repository.ts';
import { ReminderRepository } from '../../../../src/database/repositories/reminder.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import { handleManageSettings } from '../../../../src/services/ai/tool-handlers/settings.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { EventService } from '../../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../../src/services/holiday/holiday-service.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('handleManageSettings', () => {
  let ctx: AgentContext;
  let db: Database;
  const USER_ID = 42;

  beforeEach(() => {
    db = createTestDb();
    const userRepo = new UserRepository(db);
    const eventRepo = new EventRepository(db);
    const reminderRepo = new ReminderRepository(db);
    const holidayRepo = new HolidayRepository(db);
    const chatHistoryRepo = new ChatHistoryRepository(db);

    userRepo.create({
      telegram_id: USER_ID,
      timezone: 'Europe/Kyiv',
      language: 'en',
      username: 'tester',
    });

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
      conversationLogger: null as never,
    };
  });

  describe('get without category returns all categories', () => {
    test('returns general settings', () => {
      const result = handleManageSettings(ctx, { action: 'get' });
      expect(result.success).toBe(true);
      const data = JSON.parse(result.output!);
      expect(data.general).toBeDefined();
      expect(data.general.timezone).toBe('Europe/Kyiv');
      expect(data.general.language).toBe('en');
    });

    test('returns voice category', () => {
      const result = handleManageSettings(ctx, { action: 'get' });
      expect(result.success).toBe(true);
      const data = JSON.parse(result.output!);
      expect(data.voice).toBeDefined();
      expect(data.voice.voice_response_enabled).toBeNull();
    });

    test('does not include notifications when not configured', () => {
      const result = handleManageSettings(ctx, { action: 'get' });
      expect(result.success).toBe(true);
      const data = JSON.parse(result.output!);
      expect(data.notifications).toBeUndefined();
    });
  });

  describe('get with category returns only that category', () => {
    test('get general returns only general', () => {
      const result = handleManageSettings(ctx, { action: 'get', category: 'general' });
      expect(result.success).toBe(true);
      const data = JSON.parse(result.output!);
      expect(data.timezone).toBe('Europe/Kyiv');
      expect(data.language).toBe('en');
    });

    test('get voice returns only voice data', () => {
      const result = handleManageSettings(ctx, { action: 'get', category: 'voice' });
      expect(result.success).toBe(true);
      const data = JSON.parse(result.output!);
      expect(data.voice_response_enabled).toBeNull();
    });
  });

  describe('update general settings', () => {
    test('updates timezone', () => {
      const result = handleManageSettings(ctx, {
        action: 'update',
        category: 'general',
        updates: { timezone: 'America/New_York' },
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('America/New_York');
      expect(ctx.user.timezone).toBe('America/New_York');
    });

    test('updates language', () => {
      const result = handleManageSettings(ctx, {
        action: 'update',
        category: 'general',
        updates: { language: 'ru' },
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('ru');
      expect(ctx.user.language).toBe('ru');
    });

    test('language change to ru includes directive to respond in Russian', () => {
      const result = handleManageSettings(ctx, {
        action: 'update',
        category: 'general',
        updates: { language: 'ru' },
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('LANGUAGE CHANGED');
      expect(result.output).toContain('Russian');
    });

    test('language change to en includes directive to respond in English', () => {
      ctx.user = { ...ctx.user, language: 'ru' };
      const result = handleManageSettings(ctx, {
        action: 'update',
        category: 'general',
        updates: { language: 'en' },
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('LANGUAGE CHANGED');
      expect(result.output).toContain('English');
    });

    test('no language directive when language is not changed', () => {
      const result = handleManageSettings(ctx, {
        action: 'update',
        category: 'general',
        updates: { timezone: 'Asia/Tokyo' },
      });
      expect(result.success).toBe(true);
      expect(result.output).not.toContain('LANGUAGE CHANGED');
    });

    test('updates country_code', () => {
      const result = handleManageSettings(ctx, {
        action: 'update',
        category: 'general',
        updates: { country_code: 'DE' },
      });
      expect(result.success).toBe(true);
      const updated = ctx.userRepo.findByTelegramId(USER_ID);
      expect(updated?.country_code).toBe('DE');
    });

    test('updates timezone and language together', () => {
      const result = handleManageSettings(ctx, {
        action: 'update',
        category: 'general',
        updates: { timezone: 'Asia/Tokyo', language: 'ru' },
      });
      expect(result.success).toBe(true);
      expect(ctx.user.timezone).toBe('Asia/Tokyo');
      expect(ctx.user.language).toBe('ru');
    });
  });

  describe('update voice settings', () => {
    test('enables voice response', () => {
      const result = handleManageSettings(ctx, {
        action: 'update',
        category: 'voice',
        updates: { voice_response_enabled: true },
      });
      expect(result.success).toBe(true);
      expect(ctx.user.voice_response_enabled).toBe(1);
    });

    test('disables voice response', () => {
      // First enable it
      handleManageSettings(ctx, {
        action: 'update',
        category: 'voice',
        updates: { voice_response_enabled: true },
      });
      const result = handleManageSettings(ctx, {
        action: 'update',
        category: 'voice',
        updates: { voice_response_enabled: false },
      });
      expect(result.success).toBe(true);
      expect(ctx.user.voice_response_enabled).toBe(0);
    });
  });

  describe('error cases', () => {
    test('update without category returns error', () => {
      const result = handleManageSettings(ctx, {
        action: 'update',
        updates: { timezone: 'UTC' },
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('category');
    });

    test('update without updates returns error', () => {
      const result = handleManageSettings(ctx, {
        action: 'update',
        category: 'general',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('updates');
    });

    test('update with empty updates returns error', () => {
      const result = handleManageSettings(ctx, {
        action: 'update',
        category: 'general',
        updates: {},
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('updates');
    });
  });

  describe('get voice returns null when not yet set', () => {
    test('fresh user has null voice_response_enabled', () => {
      const result = handleManageSettings(ctx, { action: 'get', category: 'voice' });
      expect(result.success).toBe(true);
      const data = JSON.parse(result.output!);
      expect(data.voice_response_enabled).toBeNull();
    });
  });

  describe('notifications category', () => {
    test('update notifications without prefs configured returns error', () => {
      const result = handleManageSettings(ctx, {
        action: 'update',
        category: 'notifications',
        updates: { morning_agenda_enabled: true },
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not configured');
    });

    test('update notifications with prefs configured', () => {
      const prefs: Record<string, unknown> = {};
      ctx.notificationPrefs = {
        ensureDefaults: () => {},
        getPrefs: () => prefs,
        update: (...args: unknown[]) => {
          Object.assign(prefs, args[1] as Record<string, unknown>);
        },
      };
      const result = handleManageSettings(ctx, {
        action: 'update',
        category: 'notifications',
        updates: { morning_agenda_enabled: true },
      });
      expect(result.success).toBe(true);
      expect(prefs.morning_agenda_enabled).toBe(1);
    });
  });

  describe('assistant category', () => {
    test('get assistant settings returns enabled/disabled status', () => {
      const ctxWithAssistant = {
        ...ctx,
        user: { ...ctx.user, assistant_enabled: 0 },
        agentRegistry: { isConnected: (_userId: number) => false },
      };
      const result = handleManageSettings(ctxWithAssistant as unknown as AgentContext, {
        action: 'get',
        category: 'assistant',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('disabled');
      expect(result.output).toContain('not connected');
    });

    test('get assistant settings shows connected when agent is connected', () => {
      const ctxWithAssistant = {
        ...ctx,
        user: { ...ctx.user, assistant_enabled: 1 },
        agentRegistry: { isConnected: (_userId: number) => true },
      };
      const result = handleManageSettings(ctxWithAssistant as unknown as AgentContext, {
        action: 'get',
        category: 'assistant',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('enabled');
      expect(result.output).toContain('connected');
    });

    test('update assistantEnabled=true calls userRepo.updateAssistantEnabled', () => {
      let calledWith: [number, boolean] | null = null;
      const ctxWithAssistant = {
        ...ctx,
        userRepo: {
          ...ctx.userRepo,
          updateAssistantEnabled: (userId: number, enabled: boolean) => {
            calledWith = [userId, enabled];
          },
        },
      };
      const result = handleManageSettings(ctxWithAssistant as unknown as AgentContext, {
        action: 'update',
        category: 'assistant',
        assistantEnabled: true,
      });
      expect(result.success).toBe(true);
      expect(calledWith!).toEqual([USER_ID, true]);
      expect(result.output).toContain('enabled');
    });

    test('update assistantEnabled=false calls userRepo.updateAssistantEnabled with false', () => {
      let calledWith: [number, boolean] | null = null;
      const ctxWithAssistant = {
        ...ctx,
        userRepo: {
          ...ctx.userRepo,
          updateAssistantEnabled: (userId: number, enabled: boolean) => {
            calledWith = [userId, enabled];
          },
        },
      };
      const result = handleManageSettings(ctxWithAssistant as unknown as AgentContext, {
        action: 'update',
        category: 'assistant',
        assistantEnabled: false,
      });
      expect(result.success).toBe(true);
      expect(calledWith!).toEqual([USER_ID, false]);
      expect(result.output).toContain('disabled');
    });

    test('update assistant reflects new value in ctx.user within same turn', () => {
      const ctxWithAssistant = {
        ...ctx,
        user: { ...ctx.user, assistant_enabled: 0 },
        userRepo: {
          ...ctx.userRepo,
          updateAssistantEnabled: () => {},
        },
      };
      handleManageSettings(ctxWithAssistant as unknown as AgentContext, {
        action: 'update',
        category: 'assistant',
        assistantEnabled: true,
      });
      expect((ctxWithAssistant as unknown as AgentContext).user.assistant_enabled).toBe(1);
    });
  });
});
