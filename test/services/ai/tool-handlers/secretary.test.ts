import { expect, mock, test } from 'bun:test';
import {
  handleListCalendarAccess,
  handleManageSecretaries,
} from '../../../../src/services/ai/tool-handlers/secretary.ts';
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

test('manage_secretaries invite: returns SECRETARY_NOT_FOUND when user missing', () => {
  const ctx = makeCtx({
    secretaryRepo: { upsert: () => ({}) } as never,
    userRepo: { findByTelegramId: () => null } as never,
  });
  const result = handleManageSecretaries(ctx, { action: 'invite', secretary_telegram_id: 999, permission: 'read' });
  expect(result.success).toBe(false);
  expect(result.error).toContain('SECRETARY_NOT_FOUND');
});

test('manage_secretaries invite: returns SECRETARY_LIMIT_REACHED when at 10', () => {
  const ctx = makeCtx({
    secretaryRepo: { countActive: () => 10, upsert: () => ({}) } as never,
    userRepo: { findByTelegramId: () => ({ telegram_id: 999 }) } as never,
  });
  const result = handleManageSecretaries(ctx, { action: 'invite', secretary_telegram_id: 999, permission: 'read' });
  expect(result.error).toContain('SECRETARY_LIMIT_REACHED');
});

test('manage_secretaries invite: success returns awaiting_confirmation', () => {
  const ctx = makeCtx({
    secretaryRepo: {
      countActive: () => 0,
      upsert: () => ({ id: 7, owner_id: 1, secretary_id: 999, permission: 'read', status: 'pending' }),
    } as never,
    userRepo: { findByTelegramId: () => ({ telegram_id: 999, username: 'bob', first_name: 'Bob' }) } as never,
    sender: { sendMessage: mock(async () => ({ message_id: 1 })) } as never,
  });
  const result = handleManageSecretaries(ctx, { action: 'invite', secretary_telegram_id: 999, permission: 'read' });
  expect(result.success).toBe(true);
  const out = JSON.parse(result.output!) as { status: string };
  expect(out.status).toBe('awaiting_confirmation');
});

test('manage_secretaries revoke: updates status to revoked', () => {
  const mockUpdate = mock(() => true);
  const ctx = makeCtx({
    secretaryRepo: {
      findById: () => ({ id: 5, owner_id: 1, secretary_id: 99, status: 'active', permission: 'write' }),
      updateStatus: mockUpdate,
    } as never,
    userRepo: { findByTelegramId: () => ({ telegram_id: 99, username: 'bob', first_name: 'Bob' }) } as never,
    sender: {} as never,
  });
  const result = handleManageSecretaries(ctx, { action: 'revoke', secretary_access_id: 5 });
  expect(result.success).toBe(true);
  expect(mockUpdate).toHaveBeenCalledWith(5, 'revoked');
});

test('manage_secretaries self_remove: fails if caller is not the secretary', () => {
  const ctx = makeCtx({
    secretaryRepo: {
      findById: () => ({ id: 5, owner_id: 10, secretary_id: 999, status: 'active' }), // secretary_id != ctx.user.telegram_id (1)
      updateStatus: mock(() => true),
    } as never,
  });
  const result = handleManageSecretaries(ctx, { action: 'self_remove', secretary_access_id: 5 });
  expect(result.success).toBe(false);
  expect(result.error).toContain('SECRETARY_ACCESS_DENIED');
});

test('manage_secretaries self_remove: succeeds when caller matches secretary_id', () => {
  const mockUpdate = mock(() => true);
  const ctx = makeCtx({
    secretaryRepo: {
      findById: () => ({ id: 5, owner_id: 10, secretary_id: 1, status: 'active' }), // secretary_id == ctx.user.telegram_id (1)
      updateStatus: mockUpdate,
    } as never,
    userRepo: { findByTelegramId: () => ({ telegram_id: 10, username: 'alice', first_name: 'Alice' }) } as never,
    sender: {} as never,
  });
  const result = handleManageSecretaries(ctx, { action: 'self_remove', secretary_access_id: 5 });
  expect(result.success).toBe(true);
  expect(mockUpdate).toHaveBeenCalledWith(5, 'revoked');
});

test('manage_secretaries invite: keyboard is sent via sendMessageWithKeyboard', async () => {
  const sendMessageWithKeyboard = mock(async () => ({ message_id: 42 }));
  const setDmMessageId = mock(() => {});
  const ctx = makeCtx({
    secretaryRepo: {
      countActive: () => 0,
      upsert: () => ({ id: 7, owner_id: 1, secretary_id: 999, permission: 'read', status: 'pending' }),
      setDmMessageId,
    } as never,
    userRepo: { findByTelegramId: () => ({ telegram_id: 999, username: 'bob', first_name: 'Bob' }) } as never,
    sender: { sendMessageWithKeyboard } as never,
  });
  handleManageSecretaries(ctx, { action: 'invite', secretary_telegram_id: 999, permission: 'read' });
  // Allow the fire-and-forget promise to settle
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(sendMessageWithKeyboard).toHaveBeenCalledTimes(1);
  const [recipientId, , keyboard] = sendMessageWithKeyboard.mock.calls[0] as unknown as [number, string, unknown];
  expect(recipientId).toBe(999);
  expect(keyboard).toBeDefined();
  expect(setDmMessageId).toHaveBeenCalledWith(7, 42);
});
