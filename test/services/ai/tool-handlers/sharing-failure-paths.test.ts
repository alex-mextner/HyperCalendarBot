// Characterization of the sharing handlers' failure and degraded paths: resend_invitation refusals,
// propose_edit owner-notification outcomes, and send_invitation surviving an address-book conflict.
import { beforeEach, describe, expect, test } from 'bun:test';
import { ContactRepository } from '../../../../src/database/repositories/contact.repository.ts';
import { EditProposalRepository } from '../../../../src/database/repositories/edit-proposal.repository.ts';
import { WRITE_TOOLS } from '../../../../src/services/ai/tool-executor.ts';
import {
  handleCancelInvitation,
  handleProposeEdit,
  handleResendInvitation,
  handleSendInvitation,
} from '../../../../src/services/ai/tool-handlers/sharing.ts';
import type { AgentContext, ToolResult } from '../../../../src/services/ai/types.ts';
import { WriteOutcomes } from '../../../../src/services/ai/write-outcomes.ts';
import type { ReceiptView } from '../../../../src/services/ai/write-receipt.ts';
import {
  createSharingFixture,
  futureStartAt,
  OTHER_USER_ID,
  type SharingFixture,
  USER_ID,
} from './sharing-fixtures.ts';

const RECEIPT_VIEW: ReceiptView = {
  language: 'en',
  timezone: 'UTC',
  hideTargets: false,
  requesterId: USER_ID,
  now: new Date('2026-10-31T09:00:00Z'),
  personLabel: () => null,
  personKey: ({ id, username }) => (id === null ? `@${username}` : `id:${id}`),
  calendarOwnerName: () => null,
  hasCalendarAccess: () => false,
};

describe('sharing handlers: failure paths', () => {
  let fixture: SharingFixture;

  beforeEach(() => {
    fixture = createSharingFixture();
  });

  function ownedEvent(owner: number, title: string) {
    return fixture.eventService.createEvent({ user_id: owner, title, start_at: futureStartAt(), timezone: 'UTC' });
  }

  describe('handleResendInvitation refusals', () => {
    test('reports a missing invitation', async () => {
      const result = await handleResendInvitation(fixture.makeCtx(), { invitation_id: 9999 });
      expect(result).toEqual({ success: false, mutationState: 'not_applied', error: 'Invitation not found.' });
    });

    // A foreign id must answer exactly as a missing one, for the owner path too: 'Not your invitation.'
    // used to tell anyone guessing ids which of them exist.
    test("answers somebody else's invitation exactly as a missing one, and delivers nothing", async () => {
      const event = ownedEvent(OTHER_USER_ID, 'Not Mine');
      const inv = fixture.invitationRepo.create({ event_id: event.id, inviter_id: OTHER_USER_ID, invitee_id: USER_ID });
      const delivered: number[] = [];
      const ctx = fixture.makeCtx({
        sender: {
          sendMessage: async () => ({ message_id: 1 }),
          editMessageText: async () => {},
          sendInvitation: async (inviteeId, _text, invitationId) => {
            delivered.push(inviteeId);
            return { message_id: 700 + invitationId };
          },
        },
      });

      const foreign = await handleResendInvitation(ctx, { invitation_id: inv.id });
      const missing = await handleResendInvitation(ctx, { invitation_id: inv.id + 1000 });

      expect(foreign).toEqual(missing);
      expect(foreign).toEqual({ success: false, mutationState: 'not_applied', error: 'Invitation not found.' });
      expect(delivered).toEqual([]);
      expect(fixture.invitationRepo.findById(inv.id)).toEqual(inv);
    });

    test("answers cancelling somebody else's invitation exactly as a missing one, and cancels nothing", () => {
      const event = ownedEvent(OTHER_USER_ID, 'Not Mine');
      const inv = fixture.invitationRepo.create({ event_id: event.id, inviter_id: OTHER_USER_ID, invitee_id: USER_ID });
      const ctx = fixture.makeCtx();

      const foreign = handleCancelInvitation(ctx, { invitation_id: inv.id });
      const missing = handleCancelInvitation(ctx, { invitation_id: inv.id + 1000 });

      expect(foreign).toEqual(missing);
      expect(foreign.success).toBe(false);
      expect(fixture.invitationRepo.findById(inv.id)).toEqual(inv);
    });

    test('refuses an invitation that is no longer pending', async () => {
      const event = ownedEvent(USER_ID, 'Answered');
      const inv = fixture.invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: OTHER_USER_ID });
      fixture.invitationRepo.updateStatus(inv.id, 'accepted', 'pending');
      const result = await handleResendInvitation(fixture.makeCtx(), { invitation_id: inv.id });
      expect(result).toEqual({
        success: false,
        mutationState: 'not_applied',
        error: 'Cannot resend — status is "accepted".',
      });
    });

    test('reports delivery failure with the exact hint when the bot API and deep link both fail', async () => {
      const event = ownedEvent(USER_ID, 'Nobody Reached');
      const inv = fixture.invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: OTHER_USER_ID });
      const ctx = fixture.makeCtx({
        sender: {
          sendMessage: async () => {
            throw new Error('blocked');
          },
          editMessageText: async () => {},
          sendInvitation: async () => null,
        },
      });
      const result = await handleResendInvitation(ctx, { invitation_id: inv.id });
      expect(result.success).toBe(true);
      expect(result.effect).toEqual({ kind: 'invitation', delivery: 'failed' });
      expect(result.agentHint).toBe('Reminder delivery failed entirely. Tell the user there was a delivery problem.');
    });
  });

  describe('handleSendInvitation', () => {
    test('an address-book conflict does not cancel the invitation', async () => {
      const contactRepo = new ContactRepository(fixture.db);
      let upsertCalls = 0;
      contactRepo.upsert = () => {
        upsertCalls += 1;
        throw new Error('address book conflict');
      };
      const event = ownedEvent(USER_ID, 'Contact Conflict');
      const ctx = fixture.makeCtx({ contactRepo });
      const result = await handleSendInvitation(ctx, { event_id: event.id, invitee_id: OTHER_USER_ID });
      expect(result.success).toBe(true);
      expect(result.mutationState).toBe('confirmed');
      expect(result.effect).toEqual({ kind: 'invitation', delivery: 'failed' });
      expect(result.agentHint).toBe('Invitation delivery failed entirely. Tell the user there was a delivery problem.');
      expect(fixture.invitationRepo.getByEvent(event.id)).toHaveLength(1);
      expect(upsertCalls).toBeGreaterThan(0);
    });
  });

  describe('handleProposeEdit owner notification', () => {
    function proposalCtx(overrides: Partial<AgentContext>): { ctx: AgentContext; eventId: number } {
      const event = ownedEvent(OTHER_USER_ID, 'Proposal Target');
      fixture.invitationRepo.create({ event_id: event.id, inviter_id: OTHER_USER_ID, invitee_id: USER_ID });
      const ctx = fixture.makeCtx({
        sharing: {
          sharedEventRepo: fixture.sharedEventRepo,
          invitationRepo: fixture.invitationRepo,
          invitationService: fixture.invitationService,
          sharingSettingsRepo: fixture.sharingSettingsRepo,
          sharingService: fixture.sharingService,
          privacyService: fixture.privacyService,
          editProposalRepo: new EditProposalRepository(fixture.db),
        },
        ...overrides,
      });
      return { ctx, eventId: event.id };
    }

    const OWNER_NOT_NOTIFIED_HINT =
      'Proposal is saved in the DB but the owner notification could NOT be delivered. Tell the user the owner may not see it immediately.';

    test('omits the hint when the owner was notified, with the proposal text unchanged', async () => {
      let sent: { ownerId: number; text: string } | undefined;
      const { ctx, eventId } = proposalCtx({
        sender: {
          sendMessage: async () => ({ message_id: 1 }),
          editMessageText: async () => {},
          sendEditProposal: async (ownerId, text) => {
            sent = { ownerId, text };
            return { message_id: 2 };
          },
        },
      });
      const result = await handleProposeEdit(ctx, {
        event_id: eventId,
        changes: { title: 'New', location: null },
        reason: 'clearer',
      });
      expect(result.success).toBe(true);
      expect(result.agentHint).toBeUndefined();
      expect(sent).toEqual({
        ownerId: OTHER_USER_ID,
        text: `📝 <b>Edit proposal</b> from User ${USER_ID}:\n  title: New\n  location: (remove)\n\nReason: clearer`,
      });
    });

    test('hints that the owner was not reached when the send fails', async () => {
      const { ctx, eventId } = proposalCtx({
        sender: {
          sendMessage: async () => ({ message_id: 1 }),
          editMessageText: async () => {},
          sendEditProposal: async () => {
            throw new Error('owner blocked the bot');
          },
        },
      });
      const result = await handleProposeEdit(ctx, { event_id: eventId, changes: { title: 'New' } });
      expect(result.success).toBe(true);
      expect(result.agentHint).toBe(OWNER_NOT_NOTIFIED_HINT);
    });

    test('hints that the owner was not reached when no sender can deliver proposals', async () => {
      const { ctx, eventId } = proposalCtx({ sender: undefined });
      const result = await handleProposeEdit(ctx, { event_id: eventId, changes: { title: 'New' } });
      expect(result.success).toBe(true);
      expect(result.agentHint).toBe(OWNER_NOT_NOTIFIED_HINT);
    });

    test('refuses a proposal whose every field is verification state', async () => {
      const { ctx, eventId } = proposalCtx({ sender: undefined });
      const result = await handleProposeEdit(ctx, { event_id: eventId, changes: { resolved_address: 'Elsewhere 1' } });
      expect(result.success).toBe(false);
      expect(result.mutationState).toBe('not_applied');
      expect(result.error).toContain('The proposal has no editable change.');
    });
  });

  // A denial changed nothing. Without mutationState the executor classifies a failed write as
  // 'uncertain' and the receipt tells the user to check the calendar before repeating.
  describe('cancel_invitation and resend_invitation denials are a plain "not applied"', () => {
    type Tool = 'cancel_invitation' | 'resend_invitation';

    async function denials(): Promise<{ name: string; tool: Tool; result: ToolResult }[]> {
      const foreignEvent = ownedEvent(OTHER_USER_ID, 'Not Mine');
      const foreign = fixture.invitationRepo.create({
        event_id: foreignEvent.id,
        inviter_id: OTHER_USER_ID,
        invitee_id: USER_ID,
      });
      const ownEvent = ownedEvent(USER_ID, 'Answered');
      const answered = fixture.invitationRepo.create({
        event_id: ownEvent.id,
        inviter_id: USER_ID,
        invitee_id: OTHER_USER_ID,
      });
      fixture.invitationRepo.updateStatus(answered.id, 'accepted', 'pending');
      const ctx = fixture.makeCtx();
      const cancel = (name: string, input: { invitation_id: number; owner_id?: number }) => ({
        name: `cancel: ${name}`,
        tool: 'cancel_invitation' as const,
        result: handleCancelInvitation(ctx, input),
      });
      const resend = async (name: string, input: { invitation_id: number; owner_id?: number }) => ({
        name: `resend: ${name}`,
        tool: 'resend_invitation' as const,
        result: await handleResendInvitation(ctx, input),
      });
      return [
        cancel('no access to the named owner', { invitation_id: foreign.id, owner_id: OTHER_USER_ID }),
        cancel('missing invitation', { invitation_id: 9999 }),
        cancel('foreign invitation', { invitation_id: foreign.id }),
        await resend('no access to the named owner', { invitation_id: foreign.id, owner_id: OTHER_USER_ID }),
        await resend('missing invitation', { invitation_id: 9999 }),
        await resend('foreign invitation', { invitation_id: foreign.id }),
        await resend('no longer pending', { invitation_id: answered.id }),
      ];
    }

    test('every denial carries mutationState not_applied and the receipt says nothing changed', async () => {
      for (const { name, tool, result } of await denials()) {
        expect({ name, success: result.success, mutationState: result.mutationState }).toEqual({
          name,
          success: false,
          mutationState: 'not_applied',
        });
        const ledger = new WriteOutcomes(WRITE_TOOLS);
        ledger.record(tool, { invitation_id: 1 }, { ...result, disposition: 'failed' });
        expect(ledger.mayHaveMutated).toBe(false);
        expect(ledger.finalNotice(RECEIPT_VIEW)).not.toContain('Could not confirm');
      }
    });
  });
});
