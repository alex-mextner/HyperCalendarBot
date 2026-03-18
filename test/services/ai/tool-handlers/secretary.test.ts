import { expect, test } from 'bun:test';
import { handleListCalendarAccess } from '../../../../src/services/ai/tool-handlers/secretary.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    user: {
      telegram_id: 1,
      username: 'alice',
      first_name: 'Alice',
      language: 'ru',
      timezone: 'UTC',
      timezone_updated_at: null,
    },
    chatId: 1,
    messageText: '',
    isGroup: false,
    eventService: {} as never,
    holidayService: {} as never,
    chatHistory: {} as never,
    userRepo: {} as never,
    reminderRepo: {} as never,
    ...overrides,
  } as AgentContext;
}

test('list_calendar_access: returns error when no secretary repo', () => {
  const ctx = makeCtx();
  const result = handleListCalendarAccess(ctx);
  expect(result.success).toBe(false);
});

test('list_calendar_access: returns own info + empty lists when no relations', () => {
  const mockRepo = {
    getActiveSecretaryFor: () => [],
    getSecretariesForOwner: () => [],
  };
  const mockUserRepo = {
    findByTelegramId: (id: number) => ({ telegram_id: id, username: 'alice', first_name: 'Alice' }),
  };
  const ctx = makeCtx({ secretaryRepo: mockRepo as never, userRepo: mockUserRepo as never });
  const result = handleListCalendarAccess(ctx);
  expect(result.success).toBe(true);
  const out = JSON.parse(result.output!) as {
    own: { telegram_id: number };
    my_secretaries: unknown[];
    secretary_for: unknown[];
  };
  expect(out.own.telegram_id).toBe(1);
  expect(out.my_secretaries).toHaveLength(0);
  expect(out.secretary_for).toHaveLength(0);
});
