import { expect, mock, test } from 'bun:test';
import type { CalendarProposalRepository } from '../../../../src/database/repositories/calendar-proposal.repository.ts';
import type { SecretaryRepository } from '../../../../src/database/repositories/secretary.repository.ts';
import type { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import type { CalendarSecretary, User } from '../../../../src/database/types.ts';
import {
  handleListCalendarAccess,
  handleManageSecretaries,
} from '../../../../src/services/ai/tool-handlers/secretary.ts';
import type { AgentContext, SecretaryCapability } from '../../../../src/services/ai/types.ts';
import { flushPromises } from '../../../helpers/mock-context.ts';

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

function secretaryRow(row: Pick<CalendarSecretary, 'id' | 'owner_id' | 'secretary_id'> & Partial<CalendarSecretary>) {
  return {
    permission: 'read',
    status: 'active',
    dm_message_id: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...row,
  } satisfies CalendarSecretary;
}

/** Secretary capability wired with only the repository methods a path touches. */
function makeSecretaryCapability(repo: Partial<SecretaryRepository>): SecretaryCapability {
  const proposals: Partial<CalendarProposalRepository> = {};
  return {
    secretaryRepo: repo as unknown as SecretaryRepository,
    secretaryForLine: undefined,
    calendarProposalRepo: proposals as unknown as CalendarProposalRepository,
  };
}

/** User repository whose lookup always returns the given (partial) user. */
function makeUserRepo(user: Partial<User>): UserRepository {
  const repo: Partial<UserRepository> = { findByTelegramId: () => user as unknown as User };
  return repo as unknown as UserRepository;
}

test('list_calendar_access: returns error when no secretary repo', async () => {
  const ctx = makeCtx();
  const result = handleListCalendarAccess(ctx);
  expect(result.success).toBe(false);
});

test('list_calendar_access: returns own info + empty lists when no relations', async () => {
  const mockRepo = {
    getActiveSecretaryFor: () => [],
    getSecretariesForOwner: () => [],
  };
  const mockUserRepo = {
    findByTelegramId: (id: number) => ({ telegram_id: id, username: 'alice', first_name: 'Alice' }),
  };
  const ctx = makeCtx({
    secretary: {
      secretaryRepo: mockRepo as never,
      secretaryForLine: undefined,
      calendarProposalRepo: undefined as never,
    },
    userRepo: mockUserRepo as never,
  });
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

test('manage_secretaries invite: returns SECRETARY_NOT_FOUND when user missing', async () => {
  const ctx = makeCtx({
    secretary: {
      secretaryRepo: { upsert: () => ({}) } as never,
      secretaryForLine: undefined,
      calendarProposalRepo: undefined as never,
    },
    userRepo: { findByTelegramId: () => null } as never,
  });
  const result = await handleManageSecretaries(ctx, {
    action: 'invite',
    secretary_telegram_id: 999,
    permission: 'read',
  });
  expect(result.success).toBe(false);
  expect(result.error).toContain('SECRETARY_NOT_FOUND');
});

test('manage_secretaries invite: returns SECRETARY_LIMIT_REACHED when at 10', async () => {
  const ctx = makeCtx({
    secretary: {
      secretaryRepo: { countActive: () => 10, upsert: () => ({}) } as never,
      secretaryForLine: undefined,
      calendarProposalRepo: undefined as never,
    },
    userRepo: { findByTelegramId: () => ({ telegram_id: 999 }) } as never,
  });
  const result = await handleManageSecretaries(ctx, {
    action: 'invite',
    secretary_telegram_id: 999,
    permission: 'read',
  });
  expect(result.error).toContain('SECRETARY_LIMIT_REACHED');
});

test('manage_secretaries invite: success returns awaiting_confirmation', async () => {
  const setDmMessageId = mock(() => undefined);
  const ctx = makeCtx({
    secretary: {
      secretaryRepo: {
        countActive: () => 0,
        upsert: () => ({ id: 7, owner_id: 1, secretary_id: 999, permission: 'read', status: 'pending' }),
        setDmMessageId,
      } as never,
      secretaryForLine: undefined,
      calendarProposalRepo: undefined as never,
    },
    userRepo: { findByTelegramId: () => ({ telegram_id: 999, username: 'bob', first_name: 'Bob' }) } as never,
    sender: {
      sendMessage: mock(async () => ({ message_id: 1 })),
      sendMessageWithKeyboard: mock(async () => ({ message_id: 1 })),
    } as never,
  });
  const result = await handleManageSecretaries(ctx, {
    action: 'invite',
    secretary_telegram_id: 999,
    permission: 'read',
  });
  expect(result.success).toBe(true);
  const out = JSON.parse(result.output!) as { status: string };
  expect(out.status).toBe('awaiting_confirmation');
  // Now that the handler awaits delivery, the DM message_id should land in the DB.
  expect(setDmMessageId).toHaveBeenCalledWith(7, 1);
});

test('manage_secretaries invite: sender not configured → success but agentHint flags undelivered invite', async () => {
  // Regression: sendSecretaryInvite used to return void, so a missing ctx.sender
  // silently produced success:true with no signal that nothing was delivered.
  const setDmMessageId = mock(() => undefined);
  const ctx = makeCtx({
    secretary: makeSecretaryCapability({
      countActive: () => 0,
      upsert: () => secretaryRow({ id: 8, owner_id: 1, secretary_id: 999, permission: 'read', status: 'pending' }),
      setDmMessageId,
    }),
    userRepo: makeUserRepo({ telegram_id: 999, username: 'bob', first_name: 'Bob' }),
    sender: undefined,
  });
  const result = await handleManageSecretaries(ctx, {
    action: 'invite',
    secretary_telegram_id: 999,
    permission: 'read',
  });
  expect(result.success).toBe(true);
  const out = JSON.parse(result.output!) as { status: string };
  expect(out.status).toBe('awaiting_confirmation');
  expect(result.agentHint).toBeDefined();
  expect(result.agentHint).toContain('could not be delivered');
  expect(setDmMessageId).not.toHaveBeenCalled();
});

test('manage_secretaries revoke: updates status to revoked', async () => {
  const mockUpdate = mock(() => true);
  const ctx = makeCtx({
    secretary: {
      secretaryRepo: {
        findById: () => ({ id: 5, owner_id: 1, secretary_id: 99, status: 'active', permission: 'write' }),
        updateStatus: mockUpdate,
      } as never,
      secretaryForLine: undefined,
      calendarProposalRepo: undefined as never,
    },
    userRepo: { findByTelegramId: () => ({ telegram_id: 99, username: 'bob', first_name: 'Bob' }) } as never,
    sender: {} as never,
  });
  const result = await handleManageSecretaries(ctx, { action: 'revoke', secretary_access_id: 5 });
  expect(result.success).toBe(true);
  expect(mockUpdate).toHaveBeenCalledWith(5, 'revoked');
});

test('manage_secretaries revoke: sender not configured → status still revoked, agentHint flags undelivered notification', async () => {
  // Regression (issue #51): sendSecretaryNotification silently skipped the secretary's
  // revoke notification when ctx.sender was missing — the caller had no way to know.
  const mockUpdate = mock(() => true);
  const ctx = makeCtx({
    secretary: makeSecretaryCapability({
      findById: () => secretaryRow({ id: 5, owner_id: 1, secretary_id: 99, status: 'active', permission: 'write' }),
      updateStatus: mockUpdate,
    }),
    userRepo: makeUserRepo({ telegram_id: 99, username: 'bob', first_name: 'Bob' }),
    sender: undefined,
  });
  const result = await handleManageSecretaries(ctx, { action: 'revoke', secretary_access_id: 5 });
  expect(result.success).toBe(true);
  expect(mockUpdate).toHaveBeenCalledWith(5, 'revoked');
  expect(result.agentHint).toContain('could not be notified directly');
});

test('manage_secretaries self_remove: fails if caller is not the secretary', async () => {
  const ctx = makeCtx({
    secretary: {
      secretaryRepo: {
        findById: () => ({ id: 5, owner_id: 10, secretary_id: 999, status: 'active' }), // secretary_id != ctx.user.telegram_id (1)
        updateStatus: mock(() => true),
      } as never,
      secretaryForLine: undefined,
      calendarProposalRepo: undefined as never,
    },
  });
  const result = await handleManageSecretaries(ctx, { action: 'self_remove', secretary_access_id: 5 });
  expect(result.success).toBe(false);
  expect(result.error).toContain('SECRETARY_ACCESS_DENIED');
});

test('manage_secretaries self_remove: succeeds when caller matches secretary_id', async () => {
  const mockUpdate = mock(() => true);
  const ctx = makeCtx({
    secretary: {
      secretaryRepo: {
        findById: () => ({ id: 5, owner_id: 10, secretary_id: 1, status: 'active' }), // secretary_id == ctx.user.telegram_id (1)
        updateStatus: mockUpdate,
      } as never,
      secretaryForLine: undefined,
      calendarProposalRepo: undefined as never,
    },
    userRepo: { findByTelegramId: () => ({ telegram_id: 10, username: 'alice', first_name: 'Alice' }) } as never,
    sender: {} as never,
  });
  const result = await handleManageSecretaries(ctx, { action: 'self_remove', secretary_access_id: 5 });
  expect(result.success).toBe(true);
  expect(mockUpdate).toHaveBeenCalledWith(5, 'revoked');
});

test('manage_secretaries self_remove: sender not configured → status still revoked, agentHint flags undelivered notification', async () => {
  // Regression (issue #51): sendSecretaryNotification silently skipped the owner's
  // self-remove notification when ctx.sender was missing — the caller had no way to know.
  const mockUpdate = mock(() => true);
  const ctx = makeCtx({
    secretary: makeSecretaryCapability({
      findById: () => secretaryRow({ id: 5, owner_id: 10, secretary_id: 1, status: 'active' }), // secretary_id == ctx.user.telegram_id (1)
      updateStatus: mockUpdate,
    }),
    userRepo: makeUserRepo({ telegram_id: 10, username: 'alice', first_name: 'Alice' }),
    sender: undefined,
  });
  const result = await handleManageSecretaries(ctx, { action: 'self_remove', secretary_access_id: 5 });
  expect(result.success).toBe(true);
  expect(mockUpdate).toHaveBeenCalledWith(5, 'revoked');
  expect(result.agentHint).toContain('could not be notified directly');
});

test('manage_secretaries invite: keyboard is sent via sendMessageWithKeyboard', async () => {
  const sendMessageWithKeyboard = mock(async () => ({ message_id: 42 }));
  const setDmMessageId = mock(() => {});
  const ctx = makeCtx({
    secretary: {
      secretaryRepo: {
        countActive: () => 0,
        upsert: () => ({ id: 7, owner_id: 1, secretary_id: 999, permission: 'read', status: 'pending' }),
        setDmMessageId,
      } as never,
      secretaryForLine: undefined,
      calendarProposalRepo: undefined as never,
    },
    userRepo: { findByTelegramId: () => ({ telegram_id: 999, username: 'bob', first_name: 'Bob' }) } as never,
    sender: { sendMessageWithKeyboard } as never,
  });
  handleManageSecretaries(ctx, { action: 'invite', secretary_telegram_id: 999, permission: 'read' });
  // Allow the fire-and-forget promise to settle
  await flushPromises();
  expect(sendMessageWithKeyboard).toHaveBeenCalledTimes(1);
  const [recipientId, , keyboard] = sendMessageWithKeyboard.mock.calls[0]! as unknown as [number, string, unknown];
  expect(recipientId).toBe(999);
  expect(keyboard).toBeDefined();
  expect(setDmMessageId).toHaveBeenCalledWith(7, 42);
});
