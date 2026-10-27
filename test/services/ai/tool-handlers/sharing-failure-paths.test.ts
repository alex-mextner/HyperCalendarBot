// Characterization of the sharing handlers' failure and degraded paths: resend_invitation refusals,
// propose_edit owner-notification outcomes, and send_invitation surviving an address-book conflict.
import { beforeEach, describe, expect, test } from 'bun:test';
import { ContactRepository } from '../../../../src/database/repositories/contact.repository.ts';
import { EditProposalRepository } from '../../../../src/database/repositories/edit-proposal.repository.ts';
import {
  handleProposeEdit,
  handleResendInvitation,
  handleSendInvitation,
} from '../../../../src/services/ai/tool-handlers/sharing.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import {
  createSharingFixture,
  futureStartAt,
  OTHER_USER_ID,
  type SharingFixture,
  USER_ID,
} from './sharing-fixtures.ts';

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
      expect(result).toEqual({ success: false, error: 'Invitation not found.' });
    });

    test("refuses somebody else's invitation", async () => {
      const event = ownedEvent(OTHER_USER_ID, 'Not Mine');
      const inv = fixture.invitationRepo.create({ event_id: event.id, inviter_id: OTHER_USER_ID, invitee_id: USER_ID });
      const result = await handleResendInvitation(fixture.makeCtx(), { invitation_id: inv.id });
      expect(result).toEqual({ success: false, error: 'Not your invitation.' });
    });

    test('refuses an invitation that is no longer pending', async () => {
      const event = ownedEvent(USER_ID, 'Answered');
      const inv = fixture.invitationRepo.create({ event_id: event.id, inviter_id: USER_ID, invitee_id: OTHER_USER_ID });
      fixture.invitationRepo.updateStatus(inv.id, 'accepted', 'pending');
      const result = await handleResendInvitation(fixture.makeCtx(), { invitation_id: inv.id });
      expect(result).toEqual({ success: false, error: 'Cannot resend — status is "accepted".' });
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
});
