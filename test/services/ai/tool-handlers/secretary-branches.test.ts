// Characterization tests for handleManageSecretaries branches not covered by secretary.test.ts
// (argument validation, denial paths, notification text, notification/delivery failure handling).
import { expect, mock, test } from 'bun:test';
import { handleManageSecretaries } from '../../../../src/services/ai/tool-handlers/secretary.ts';
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
    eventReminderRepo: {} as never,
    ...overrides,
  } as AgentContext;
}

function secretaryOf(repo: Record<string, unknown>): AgentContext['secretary'] {
  return { secretaryRepo: repo as never, secretaryForLine: undefined, calendarProposalRepo: undefined as never };
}

test('manage_secretaries: not configured without secretary/userRepo', async () => {
  const result = await handleManageSecretaries(makeCtx({ userRepo: undefined }), { action: 'invite' });
  expect(result).toEqual({ success: false, error: 'Secretary feature not configured.' });
});

test('manage_secretaries invite: requires secretary_telegram_id and permission', async () => {
  const ctx = makeCtx({ secretary: secretaryOf({}) });
  const noId = await handleManageSecretaries(ctx, { action: 'invite', permission: 'read' });
  expect(noId).toEqual({ success: false, error: 'secretary_telegram_id and permission required for invite.' });
  const noPerm = await handleManageSecretaries(ctx, { action: 'invite', secretary_telegram_id: 5 });
  expect(noPerm).toEqual({ success: false, error: 'secretary_telegram_id and permission required for invite.' });
});

test('manage_secretaries invite: delivery failure surfaces SECRETARY_INVITE_DELIVERY_FAILED with record id', async () => {
  const ctx = makeCtx({
    secretary: secretaryOf({
      countActive: () => 0,
      upsert: () => ({ id: 7, owner_id: 1, secretary_id: 999, permission: 'write', status: 'pending' }),
      setDmMessageId: () => {
        throw new Error('db down');
      },
    }),
    userRepo: { findByTelegramId: () => ({ telegram_id: 999, username: 'bob', first_name: 'Bob' }) } as never,
    sender: { sendMessage: mock(async () => ({ message_id: 1 })) } as never,
  });
  const result = await handleManageSecretaries(ctx, {
    action: 'invite',
    secretary_telegram_id: 999,
    permission: 'write',
  });
  expect(result.success).toBe(false);
  expect(result.error).toBe('SECRETARY_INVITE_DELIVERY_FAILED');
  expect(JSON.parse(result.output!)).toEqual({ status: 'delivery_failed', secretary_access_id: 7 });
});

test('manage_secretaries invite: invite text carries owner name, handle and permission label', async () => {
  const sendMessage = mock(async (_id: number, _text: string) => ({ message_id: 2 }));
  const ctx = makeCtx({
    secretary: secretaryOf({
      countActive: () => 9,
      upsert: () => ({ id: 3, owner_id: 1, secretary_id: 999, permission: 'write', status: 'pending' }),
      setDmMessageId: () => undefined,
    }),
    userRepo: { findByTelegramId: () => ({ telegram_id: 999 }) } as never,
    sender: { sendMessage } as never,
  });
  const result = await handleManageSecretaries(ctx, {
    action: 'invite',
    secretary_telegram_id: 999,
    permission: 'write',
  });
  expect(result.success).toBe(true);
  expect(sendMessage).toHaveBeenCalledWith(
    999,
    'Alice (@alice) хочет добавить тебя секретарём своего календаря.\nПрава доступа: читать и редактировать.\n\nПринять приглашение?',
  );
});

test('manage_secretaries revoke: requires secretary_access_id', async () => {
  const ctx = makeCtx({ secretary: secretaryOf({}) });
  const result = await handleManageSecretaries(ctx, { action: 'revoke' });
  expect(result).toEqual({ success: false, error: 'secretary_access_id required for revoke.' });
});

test('manage_secretaries revoke: denies unknown record and foreign owner without updating', async () => {
  const updateStatus = mock(() => true);
  const missing = makeCtx({ secretary: secretaryOf({ findById: () => undefined, updateStatus }) });
  expect(await handleManageSecretaries(missing, { action: 'revoke', secretary_access_id: 5 })).toEqual({
    success: false,
    error: 'SECRETARY_ACCESS_DENIED',
  });
  const foreign = makeCtx({
    secretary: secretaryOf({ findById: () => ({ id: 5, owner_id: 77, secretary_id: 9 }), updateStatus }),
  });
  expect(await handleManageSecretaries(foreign, { action: 'revoke', secretary_access_id: 5 })).toEqual({
    success: false,
    error: 'SECRETARY_ACCESS_DENIED',
  });
  expect(updateStatus).not.toHaveBeenCalled();
});

test('manage_secretaries revoke: notifies the secretary with owner name and handle', async () => {
  const sendMessage = mock(async (_id: number, _text: string) => ({ message_id: 4 }));
  const ctx = makeCtx({
    secretary: secretaryOf({
      findById: () => ({ id: 5, owner_id: 1, secretary_id: 99 }),
      updateStatus: () => true,
    }),
    userRepo: { findByTelegramId: () => ({ telegram_id: 99 }) } as never,
    sender: { sendMessage } as never,
  });
  const result = await handleManageSecretaries(ctx, { action: 'revoke', secretary_access_id: 5 });
  expect(result).toEqual({ success: true, output: JSON.stringify({ ok: true }) });
  expect(sendMessage).toHaveBeenCalledWith(99, 'Твой доступ к календарю Alice (@alice) был отозван.');
});

test('manage_secretaries revoke: skips notification when secretary user or sender is absent', async () => {
  const sendMessage = mock(async () => ({ message_id: 1 }));
  const noUser = makeCtx({
    secretary: secretaryOf({ findById: () => ({ id: 5, owner_id: 1, secretary_id: 99 }), updateStatus: () => true }),
    userRepo: { findByTelegramId: () => undefined } as never,
    sender: { sendMessage } as never,
  });
  expect((await handleManageSecretaries(noUser, { action: 'revoke', secretary_access_id: 5 })).success).toBe(true);
  const noSender = makeCtx({
    secretary: secretaryOf({ findById: () => ({ id: 5, owner_id: 1, secretary_id: 99 }), updateStatus: () => true }),
    userRepo: { findByTelegramId: () => ({ telegram_id: 99 }) } as never,
  });
  expect((await handleManageSecretaries(noSender, { action: 'revoke', secretary_access_id: 5 })).success).toBe(true);
  expect(sendMessage).not.toHaveBeenCalled();
});

test('manage_secretaries revoke: notification failure is swallowed, revocation stays committed', async () => {
  const updateStatus = mock(() => true);
  const ctx = makeCtx({
    secretary: secretaryOf({ findById: () => ({ id: 5, owner_id: 1, secretary_id: 99 }), updateStatus }),
    userRepo: { findByTelegramId: () => ({ telegram_id: 99 }) } as never,
    sender: {
      sendMessage: async () => {
        throw new Error('blocked');
      },
    } as never,
  });
  const result = await handleManageSecretaries(ctx, { action: 'revoke', secretary_access_id: 5 });
  expect(result.success).toBe(true);
  expect(updateStatus).toHaveBeenCalledWith(5, 'revoked');
});

test('manage_secretaries self_remove: requires secretary_access_id and denies unknown record', async () => {
  const noId = await handleManageSecretaries(makeCtx({ secretary: secretaryOf({}) }), { action: 'self_remove' });
  expect(noId).toEqual({ success: false, error: 'secretary_access_id required for self_remove.' });
  const missing = makeCtx({ secretary: secretaryOf({ findById: () => undefined }) });
  expect(await handleManageSecretaries(missing, { action: 'self_remove', secretary_access_id: 5 })).toEqual({
    success: false,
    error: 'SECRETARY_ACCESS_DENIED',
  });
});

test('manage_secretaries self_remove: notifies the owner with secretary name and handle', async () => {
  const sendMessage = mock(async (_id: number, _text: string) => ({ message_id: 4 }));
  const ctx = makeCtx({
    secretary: secretaryOf({
      findById: () => ({ id: 5, owner_id: 10, secretary_id: 1 }),
      updateStatus: () => true,
    }),
    userRepo: { findByTelegramId: () => ({ telegram_id: 10 }) } as never,
    sender: { sendMessage } as never,
  });
  const result = await handleManageSecretaries(ctx, { action: 'self_remove', secretary_access_id: 5 });
  expect(result.success).toBe(true);
  expect(sendMessage).toHaveBeenCalledWith(10, 'Alice (@alice) добровольно покинул роль секретаря твоего календаря.');
});

test('manage_secretaries: unknown action reports it', async () => {
  const ctx = makeCtx({ secretary: secretaryOf({}) });
  const result = await handleManageSecretaries(ctx, { action: 'bogus' } as never);
  expect(result).toEqual({ success: false, error: 'Unknown action: bogus' });
});
