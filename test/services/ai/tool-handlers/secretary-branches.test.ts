// Characterization tests for handleManageSecretaries branches not covered by secretary.test.ts
// (argument validation, denial paths, notification text, notification/delivery failure handling).
import { expect, mock, test } from 'bun:test';
import type { CalendarProposalRepository } from '../../../../src/database/repositories/calendar-proposal.repository.ts';
import type { SecretaryRepository } from '../../../../src/database/repositories/secretary.repository.ts';
import type { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import type { User } from '../../../../src/database/types.ts';
import { handleManageSecretaries } from '../../../../src/services/ai/tool-handlers/secretary.ts';
import type { AgentContext, SecretaryCapability, TelegramSender } from '../../../../src/services/ai/types.ts';
import { agentContext, secretaryRow, userRow } from '../context-fixtures.ts';
import { partialOf, type Supplied } from '../partial-stubs.ts';

type ManageSecretariesInput = Parameters<typeof handleManageSecretaries>[1];

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return agentContext({
    user: userRow({ telegram_id: 1, username: 'alice', first_name: 'Alice', language: 'ru' }),
    ...overrides,
  });
}

function secretaryOf(repo: Supplied<SecretaryRepository>): SecretaryCapability {
  return {
    secretaryRepo: partialOf<SecretaryRepository>('secretaryRepo', repo),
    secretaryForLine: undefined,
    calendarProposalRepo: partialOf<CalendarProposalRepository>('calendarProposalRepo'),
  };
}

/** A user repo that resolves every Telegram id to `found` (null = no such user). */
function userRepoFinding(found: User | null): UserRepository {
  return partialOf<UserRepository>('userRepo', { findByTelegramId: () => found });
}

/** A plain-message sender; the keyboard variant is deliberately absent, as for the DM-only sender. */
function senderOf(sendMessage: TelegramSender['sendMessage']): TelegramSender {
  return partialOf<TelegramSender>('sender', { sendMessage, sendMessageWithKeyboard: undefined });
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
  const setDmMessageId = mock((_id: number, _messageId: number): void => {
    throw new Error('db down');
  });
  const ctx = makeCtx({
    secretary: secretaryOf({
      countActive: () => 0,
      upsert: () => secretaryRow({ id: 7, owner_id: 1, secretary_id: 999, permission: 'write', status: 'pending' }),
      setDmMessageId,
    }),
    userRepo: userRepoFinding(userRow({ telegram_id: 999, username: 'bob', first_name: 'Bob' })),
    sender: senderOf(mock(async () => ({ message_id: 1 }))),
  });
  const result = await handleManageSecretaries(ctx, {
    action: 'invite',
    secretary_telegram_id: 999,
    permission: 'write',
  });
  expect(result.success).toBe(false);
  expect(result.error).toBe('SECRETARY_INVITE_DELIVERY_FAILED');
  expect(JSON.parse(result.output!)).toEqual({ status: 'delivery_failed', secretary_access_id: 7 });
  // The failure must come from the arranged DB error, not from an unstubbed member.
  expect(setDmMessageId).toHaveBeenCalledWith(7, 1);
});

test('manage_secretaries invite: invite text carries owner name, handle and permission label', async () => {
  const sendMessage = mock(async (_id: number, _text: string) => ({ message_id: 2 }));
  const ctx = makeCtx({
    secretary: secretaryOf({
      countActive: () => 9,
      upsert: () => secretaryRow({ id: 3, owner_id: 1, secretary_id: 999, permission: 'write', status: 'pending' }),
      setDmMessageId: () => undefined,
    }),
    userRepo: userRepoFinding(userRow({ telegram_id: 999 })),
    sender: senderOf(sendMessage),
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
  const missing = makeCtx({ secretary: secretaryOf({ findById: () => null, updateStatus }) });
  expect(await handleManageSecretaries(missing, { action: 'revoke', secretary_access_id: 5 })).toEqual({
    success: false,
    error: 'SECRETARY_ACCESS_DENIED',
  });
  const foreign = makeCtx({
    secretary: secretaryOf({ findById: () => secretaryRow({ id: 5, owner_id: 77, secretary_id: 9 }), updateStatus }),
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
      findById: () => secretaryRow({ id: 5, owner_id: 1, secretary_id: 99 }),
      updateStatus: () => true,
    }),
    userRepo: userRepoFinding(userRow({ telegram_id: 99 })),
    sender: senderOf(sendMessage),
  });
  const result = await handleManageSecretaries(ctx, { action: 'revoke', secretary_access_id: 5 });
  expect(result).toEqual({ success: true, output: JSON.stringify({ ok: true }) });
  expect(sendMessage).toHaveBeenCalledWith(99, 'Твой доступ к календарю Alice (@alice) был отозван.');
});

test('manage_secretaries revoke: skips notification when secretary user or sender is absent', async () => {
  const sendMessage = mock(async () => ({ message_id: 1 }));
  const activeLink = secretaryOf({
    findById: () => secretaryRow({ id: 5, owner_id: 1, secretary_id: 99 }),
    updateStatus: () => true,
  });
  const noUser = makeCtx({ secretary: activeLink, userRepo: userRepoFinding(null), sender: senderOf(sendMessage) });
  expect((await handleManageSecretaries(noUser, { action: 'revoke', secretary_access_id: 5 })).success).toBe(true);
  const noSender = makeCtx({ secretary: activeLink, userRepo: userRepoFinding(userRow({ telegram_id: 99 })) });
  expect((await handleManageSecretaries(noSender, { action: 'revoke', secretary_access_id: 5 })).success).toBe(true);
  expect(sendMessage).not.toHaveBeenCalled();
});

test('manage_secretaries revoke: notification failure is swallowed, revocation stays committed', async () => {
  const updateStatus = mock(() => true);
  const sendMessage = mock(async (_id: number, _text: string): Promise<{ message_id: number }> => {
    throw new Error('blocked');
  });
  const ctx = makeCtx({
    secretary: secretaryOf({
      findById: () => secretaryRow({ id: 5, owner_id: 1, secretary_id: 99 }),
      updateStatus,
    }),
    userRepo: userRepoFinding(userRow({ telegram_id: 99 })),
    sender: senderOf(sendMessage),
  });
  const result = await handleManageSecretaries(ctx, { action: 'revoke', secretary_access_id: 5 });
  expect(result.success).toBe(true);
  expect(updateStatus).toHaveBeenCalledWith(5, 'revoked');
  // The swallowed failure must be the arranged send error, not an unstubbed member read on the way.
  expect(sendMessage).toHaveBeenCalled();
});

test('manage_secretaries self_remove: requires secretary_access_id and denies unknown record', async () => {
  const noId = await handleManageSecretaries(makeCtx({ secretary: secretaryOf({}) }), { action: 'self_remove' });
  expect(noId).toEqual({ success: false, error: 'secretary_access_id required for self_remove.' });
  const missing = makeCtx({ secretary: secretaryOf({ findById: () => null }) });
  expect(await handleManageSecretaries(missing, { action: 'self_remove', secretary_access_id: 5 })).toEqual({
    success: false,
    error: 'SECRETARY_ACCESS_DENIED',
  });
});

test('manage_secretaries self_remove: notifies the owner with secretary name and handle', async () => {
  const sendMessage = mock(async (_id: number, _text: string) => ({ message_id: 4 }));
  const ctx = makeCtx({
    secretary: secretaryOf({
      findById: () => secretaryRow({ id: 5, owner_id: 10, secretary_id: 1 }),
      updateStatus: () => true,
    }),
    userRepo: userRepoFinding(userRow({ telegram_id: 10 })),
    sender: senderOf(sendMessage),
  });
  const result = await handleManageSecretaries(ctx, { action: 'self_remove', secretary_access_id: 5 });
  expect(result.success).toBe(true);
  expect(sendMessage).toHaveBeenCalledWith(10, 'Alice (@alice) добровольно покинул роль секретаря твоего календаря.');
});

test('manage_secretaries: unknown action reports it', async () => {
  const ctx = makeCtx({ secretary: secretaryOf({}) });
  // Model tool-call arguments arrive as JSON text, so an action outside the declared union reaches the
  // handler through JSON.parse; its `any` result is the untrusted boundary, assigned to the parameter type.
  const unknownAction: ManageSecretariesInput = JSON.parse('{"action":"bogus"}');
  const result = await handleManageSecretaries(ctx, unknownAction);
  expect(result).toEqual({ success: false, error: 'Unknown action: bogus' });
});
