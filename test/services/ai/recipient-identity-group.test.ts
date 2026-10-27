import { expect, test } from 'bun:test';
import { resolveInvitationRecipient } from '../../../src/services/ai/recipient-identity.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';

const GROUP_ID = -1001234567890;

function context(overrides: object = {}): AgentContext {
  return {
    user: { telegram_id: 10, language: 'en' },
    messageText: 'Invite the group',
    userRepo: { findByTelegramId: () => null, findByUsername: () => null },
    ...overrides,
  } as unknown as AgentContext;
}

test('group target with a username hint is a conflict', async () => {
  const result = await resolveInvitationRecipient(context(), { invitee_id: GROUP_ID, invitee_username: 'someone' });
  expect(result).toEqual({ ok: false, reason: 'conflict' });
});

test('group target without intent evidence is unverified', async () => {
  const result = await resolveInvitationRecipient(context(), { invitee_id: GROUP_ID });
  expect(result).toEqual({ ok: false, reason: 'unverified' });
});

test('current group chat needs no membership check', async () => {
  const result = await resolveInvitationRecipient(context({ isGroup: true, groupChatId: GROUP_ID }), {
    invitee_id: GROUP_ID,
  });
  expect(result).toEqual({ ok: true, id: GROUP_ID, isGroup: true });
});

test('verified group without group service is unverified', async () => {
  const ctx = context({ verifiedRecipientIds: new Set([GROUP_ID]) });
  expect(await resolveInvitationRecipient(ctx, { invitee_id: GROUP_ID })).toEqual({ ok: false, reason: 'unverified' });
});

test('verified group is accepted only when current membership is confirmed', async () => {
  const member = context({
    verifiedRecipientIds: new Set([GROUP_ID]),
    group: { checkGroupMembership: async () => true },
  });
  expect(await resolveInvitationRecipient(member, { invitee_id: GROUP_ID })).toEqual({
    ok: true,
    id: GROUP_ID,
    isGroup: true,
  });
  const stranger = context({
    verifiedRecipientIds: new Set([GROUP_ID]),
    group: { checkGroupMembership: async () => false },
  });
  expect(await resolveInvitationRecipient(stranger, { invitee_id: GROUP_ID })).toEqual({
    ok: false,
    reason: 'unverified',
  });
});

test('established invitation recipient group with a throwing membership check is unverified', async () => {
  const ctx = context({
    group: {
      checkGroupMembership: async () => {
        throw new Error('boom');
      },
    },
  });
  expect(await resolveInvitationRecipient(ctx, { invitee_id: GROUP_ID }, GROUP_ID)).toEqual({
    ok: false,
    reason: 'unverified',
  });
});
