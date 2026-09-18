import { expect, test } from 'bun:test';
import {
  confirmRecipientApproval,
  consumeRecipientApproval,
  issueRecipientApproval,
} from '../../src/services/ai/recipient-confirmation.ts';
import { resolveInvitationRecipient } from '../../src/services/ai/recipient-identity.ts';
import type { AgentContext } from '../../src/services/ai/types.ts';

function ctx(): AgentContext {
  return {
    user: { telegram_id: 7001 },
    userRepo: { findByTelegramId: () => null, findByUsername: () => null },
    messageText: 'Confirm invite',
  } as unknown as AgentContext;
}
test('model force is denied before a real private callback confirmation', async () => {
  const token = issueRecipientApproval(7001, 91, 5000000001);
  expect(consumeRecipientApproval(7001, 91, 5000000001)).toBe(false);
  expect(confirmRecipientApproval(token, 7002, 7002)).toBeNull();
  expect(confirmRecipientApproval(token, 7001, -100)).toBeNull();
  expect((await resolveInvitationRecipient(ctx(), { event_id: 91, invitee_id: 5000000001, force: true })).ok).toBe(
    false,
  );
});
test('confirmed force is scoped to actor,event,ID and consumed once', async () => {
  const token = issueRecipientApproval(7001, 92, 5000000001);
  expect(confirmRecipientApproval(token, 7001, 7001)).not.toBeNull();
  expect(consumeRecipientApproval(7001, 93, 5000000001)).toBe(false);
  expect(consumeRecipientApproval(7001, 92, 5000000002)).toBe(false);
  expect(
    await resolveInvitationRecipient(ctx(), {
      event_id: 92,
      invitee_id: 5000000001,
      force: true,
      invitee_username: 'stale',
    }),
  ).toMatchObject({ ok: true, id: 5000000001 });
  expect(consumeRecipientApproval(7001, 92, 5000000001)).toBe(false);
});
test('expired or duplicated buttons cannot trigger approval', () => {
  const token = issueRecipientApproval(7001, 94, 5000000001, 1000);
  expect(confirmRecipientApproval(token, 7001, 7001, 302000)).toBeNull();
  const token2 = issueRecipientApproval(7001, 95, 5000000001);
  expect(confirmRecipientApproval(token2, 7001, 7001)).not.toBeNull();
  expect(confirmRecipientApproval(token2, 7001, 7001)).toBeNull();
});
