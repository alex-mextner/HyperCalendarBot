// What a secretary's owner_id invitation tools may touch, and when that is decided: only events the owner
// organises personally (not group events the owner merely sees as a member), and write access and event
// details as they are when the invitation is created, not as they were before the recipient lookup
// awaited. Ids are synthetic.
import { beforeEach, describe, expect, test } from 'bun:test';
import { CalendarProposalRepository } from '../../../../src/database/repositories/calendar-proposal.repository.ts';
import { ContactRepository } from '../../../../src/database/repositories/contact.repository.ts';
import { SecretaryRepository } from '../../../../src/database/repositories/secretary.repository.ts';
import type { SecretaryPermission, SecretaryStatus } from '../../../../src/database/types.ts';
import {
  handleCancelInvitation,
  handleGetInvitationStatus,
  handleResendInvitation,
  handleSendInvitation,
} from '../../../../src/services/ai/tool-handlers/sharing.ts';
import type { AgentContext, TelegramSender } from '../../../../src/services/ai/types.ts';
import { createSharingFixture, futureStartAt, type SharingFixture } from './sharing-fixtures.ts';

const SECRETARY_ID = 1001;
const OWNER_ID = 2002;
const ANTON_ID = 3001;
const THIRD_PERSON_ID = 7007;
const GROUP_CHAT_ID = -100777;
const OTHER_OWNER_ID = 8008;

interface Delivery {
  inviteeId: number;
  text: string;
}

describe('secretary invitation tools: event scope and access timing', () => {
  let fx: SharingFixture;
  let secretaryRepo: SecretaryRepository;
  let calendarProposalRepo: CalendarProposalRepository;
  let contactRepo: ContactRepository;
  let deliveries: Delivery[];

  function grant(permission: SecretaryPermission, status: SecretaryStatus = 'active') {
    secretaryRepo.upsert({ owner_id: OWNER_ID, secretary_id: SECRETARY_ID, permission });
    fx.db
      .prepare('UPDATE calendar_secretaries SET permission = ?, status = ? WHERE owner_id = ? AND secretary_id = ?')
      .run(permission, status, OWNER_ID, SECRETARY_ID);
  }

  function ctxOf(callerId: number, overrides: Partial<AgentContext> = {}): AgentContext {
    const sender: TelegramSender = {
      sendMessage: async () => ({ message_id: 1 }),
      editMessageText: async () => {},
      sendInvitation: async (inviteeId, text, invitationId) => {
        deliveries.push({ inviteeId, text });
        return { message_id: 700 + invitationId };
      },
      sendAsConnectedUser: async () => true,
    };
    return fx.makeCtx({
      user: fx.userRepo.findByTelegramId(callerId)!,
      chatId: callerId,
      messageText: 'invite @anton_a',
      contactRepo,
      secretary: { secretaryRepo, secretaryForLine: undefined, calendarProposalRepo },
      sender,
      deepLinkService: fx.deepLinkService,
      botUsername: 'TestBot',
      ...overrides,
    });
  }

  function personalEvent(title: string): number {
    return fx.eventService.createEvent({
      user_id: OWNER_ID,
      title,
      start_at: futureStartAt(),
      timezone: 'UTC',
    }).id;
  }

  /** An event the owner sees only as a member of the group: someone else created it. */
  function groupEventSeenByOwner(): number {
    fx.db.run('INSERT INTO group_members (chat_id, user_id) VALUES (?, ?)', [GROUP_CHAT_ID, OWNER_ID]);
    return fx.eventService.createEvent({
      user_id: THIRD_PERSON_ID,
      title: 'Group planning',
      start_at: futureStartAt(),
      timezone: 'UTC',
      owner_type: 'group',
      group_id: GROUP_CHAT_ID,
      created_by: THIRD_PERSON_ID,
    }).id;
  }

  beforeEach(() => {
    fx = createSharingFixture();
    deliveries = [];
    secretaryRepo = new SecretaryRepository(fx.db);
    calendarProposalRepo = new CalendarProposalRepository(fx.db);
    contactRepo = new ContactRepository(fx.db);
    fx.userRepo.create({ telegram_id: SECRETARY_ID, username: 'requester_a', first_name: 'Kim', language: 'ru' });
    fx.userRepo.create({ telegram_id: OWNER_ID, first_name: 'Olga', language: 'ru' });
    fx.userRepo.create({ telegram_id: ANTON_ID, username: 'anton_a', first_name: 'Anton' });
    fx.userRepo.create({ telegram_id: THIRD_PERSON_ID, first_name: 'Third' });
    contactRepo.upsert(SECRETARY_ID, 'Anton', undefined, ANTON_ID);
    contactRepo.upsert(OWNER_ID, 'Anton', undefined, ANTON_ID);
  });

  describe('a group event the owner sees as a member but does not organise', () => {
    test('send_invitation, resend_invitation, cancel_invitation and get_invitation_status are all denied', async () => {
      grant('write');
      const eventId = groupEventSeenByOwner();
      // The owner themself can use it (their own, unchanged behaviour) — and that leaves an owner-inviter invitation.
      expect(fx.eventService.getEvent(eventId, OWNER_ID)).not.toBeNull();
      const byOwner = await handleSendInvitation(ctxOf(OWNER_ID), { event_id: eventId, invitee_id: ANTON_ID });
      expect(byOwner.success).toBe(true);
      const invitation = fx.invitationRepo.getByEvent(eventId)[0]!;
      deliveries.length = 0;

      const secretary = ctxOf(SECRETARY_ID);
      const sent = await handleSendInvitation(secretary, {
        event_id: eventId,
        owner_id: OWNER_ID,
        invitee_id: ANTON_ID,
      });
      expect(sent).toMatchObject({ success: false, mutationState: 'not_applied' });

      const resent = await handleResendInvitation(secretary, { invitation_id: invitation.id, owner_id: OWNER_ID });
      expect(resent.success).toBe(false);

      const cancelled = handleCancelInvitation(secretary, { invitation_id: invitation.id, owner_id: OWNER_ID });
      expect(cancelled.success).toBe(false);

      const roster = handleGetInvitationStatus(secretary, { event_id: eventId, owner_id: OWNER_ID });
      expect(roster.success).toBe(false);
      expect(roster.output ?? '').not.toContain('Anton');

      expect(deliveries).toEqual([]);
      expect(fx.invitationRepo.getByEvent(eventId)).toHaveLength(1);
      expect(fx.invitationRepo.findById(invitation.id)?.status).toBe('pending');
    });

    test("the owner's own personal event keeps working for the same secretary", async () => {
      grant('write');
      const eventId = personalEvent('Personal');
      const secretary = ctxOf(SECRETARY_ID);

      expect(
        (await handleSendInvitation(secretary, { event_id: eventId, owner_id: OWNER_ID, invitee_id: ANTON_ID }))
          .success,
      ).toBe(true);
      const invitation = fx.invitationRepo.getByEvent(eventId)[0]!;
      expect(handleGetInvitationStatus(secretary, { event_id: eventId, owner_id: OWNER_ID }).success).toBe(true);
      expect(
        (await handleResendInvitation(secretary, { invitation_id: invitation.id, owner_id: OWNER_ID })).success,
      ).toBe(true);
      expect(handleCancelInvitation(secretary, { invitation_id: invitation.id, owner_id: OWNER_ID }).success).toBe(
        true,
      );
    });
  });

  // A secretary of one owner who passes the id of another owner's invitation must learn nothing: not
  // that it exists, not which event it points to.
  describe("an invitation of another owner's calendar", () => {
    test('cancel_invitation answers exactly as for an invitation that does not exist, and cancels nothing', async () => {
      grant('write');
      fx.userRepo.create({ telegram_id: OTHER_OWNER_ID, first_name: 'Boris', language: 'ru' });
      contactRepo.upsert(OTHER_OWNER_ID, 'Anton', undefined, ANTON_ID);
      const foreignEventId = fx.eventService.createEvent({
        user_id: OTHER_OWNER_ID,
        title: 'Private plan',
        start_at: futureStartAt(),
        timezone: 'UTC',
      }).id;
      await handleSendInvitation(ctxOf(OTHER_OWNER_ID), { event_id: foreignEventId, invitee_id: ANTON_ID });
      const foreign = fx.invitationRepo.getByEvent(foreignEventId)[0]!;
      const secretary = ctxOf(SECRETARY_ID);

      const foreignResult = handleCancelInvitation(secretary, { invitation_id: foreign.id, owner_id: OWNER_ID });
      const missingResult = handleCancelInvitation(secretary, { invitation_id: foreign.id + 1000, owner_id: OWNER_ID });

      expect(foreignResult).toEqual(missingResult);
      expect(foreignResult.success).toBe(false);
      expect(JSON.stringify(foreignResult)).not.toContain(String(foreignEventId));
      expect(fx.invitationRepo.findById(foreign.id)?.status).toBe('pending');
    });
  });

  describe('a group event the managed owner created', () => {
    function groupEventCreatedByOwner(): number {
      fx.db.run('INSERT INTO group_members (chat_id, user_id) VALUES (?, ?)', [GROUP_CHAT_ID, OWNER_ID]);
      return fx.eventService.createEvent({
        user_id: OWNER_ID,
        title: 'Group planning',
        start_at: futureStartAt(),
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_CHAT_ID,
        created_by: OWNER_ID,
      }).id;
    }

    test('send_invitation with owner_id on a group event the owner sees is an explicit scope denial without a retry hint', async () => {
      grant('write');
      const eventId = groupEventCreatedByOwner();

      const result = await handleSendInvitation(ctxOf(SECRETARY_ID), {
        event_id: eventId,
        owner_id: OWNER_ID,
        invitee_id: ANTON_ID,
      });

      expect(result).toMatchObject({ success: false, mutationState: 'not_applied' });
      expect(result.error).toContain('personal events');
      expect(`${result.error} ${result.agentHint ?? ''}`).not.toContain('Retry with owner_id');
      expect(deliveries).toEqual([]);
    });

    test('a group event another member created, which the owner only sees, is a scope denial for owner_id', async () => {
      grant('write');
      fx.db.run('INSERT INTO group_members (chat_id, user_id) VALUES (?, ?)', [GROUP_CHAT_ID, OWNER_ID]);
      const eventId = fx.eventService.createEvent({
        user_id: THIRD_PERSON_ID,
        title: 'Member event',
        start_at: futureStartAt(),
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_CHAT_ID,
        created_by: THIRD_PERSON_ID,
      }).id;
      const result = await handleSendInvitation(ctxOf(SECRETARY_ID), {
        event_id: eventId,
        owner_id: OWNER_ID,
        invitee_id: ANTON_ID,
      });
      expect(result.error).toContain('personal events');
      expect(`${result.error} ${result.agentHint ?? ''}`).not.toContain('Retry with owner_id');
    });

    test('a group event of a managed owner is the same denial when owner_id was forgotten', async () => {
      grant('write');
      const eventId = groupEventCreatedByOwner();
      const result = await handleSendInvitation(ctxOf(SECRETARY_ID), { event_id: eventId, invitee_id: ANTON_ID });
      expect(result.error).toContain('personal events');
      expect(`${result.error} ${result.agentHint ?? ''}`).not.toContain('Retry with owner_id');
      expect(deliveries).toEqual([]);
    });

    test('a personal event of the owner still gets the retry hint when owner_id was forgotten', async () => {
      grant('write');
      const eventId = personalEvent('Personal');

      const result = await handleSendInvitation(ctxOf(SECRETARY_ID), { event_id: eventId, invitee_id: ANTON_ID });

      expect(result.success).toBe(false);
      expect(result.agentHint).toContain(`Retry with owner_id ${OWNER_ID}`);
    });
  });

  describe('an event of a second managed owner', () => {
    test('owner_id naming the wrong owner still gets the retry hint for the right one', async () => {
      grant('write');
      fx.userRepo.create({ telegram_id: OTHER_OWNER_ID, timezone: 'UTC' });
      const record = secretaryRepo.upsert({
        owner_id: OTHER_OWNER_ID,
        secretary_id: SECRETARY_ID,
        permission: 'write',
      });
      secretaryRepo.updateStatus(record.id, 'active');
      const eventId = personalEvent('Personal');
      const result = await handleSendInvitation(ctxOf(SECRETARY_ID), {
        event_id: eventId,
        owner_id: OTHER_OWNER_ID,
        invitee_id: ANTON_ID,
      });
      expect(result.agentHint).toContain(`Retry with owner_id ${OWNER_ID}`);
    });
  });

  describe('an event the owner cannot see answers as a missing id', () => {
    test('a deleted personal event, with and without owner_id', async () => {
      grant('write');
      const eventId = personalEvent('Gone');
      fx.eventService.deleteEvent(eventId, OWNER_ID);
      for (const owner of [{}, { owner_id: OWNER_ID }]) {
        const gone = await handleSendInvitation(ctxOf(SECRETARY_ID), {
          event_id: eventId,
          invitee_id: ANTON_ID,
          ...owner,
        });
        const missing = await handleSendInvitation(ctxOf(SECRETARY_ID), {
          event_id: eventId + 1000,
          invitee_id: ANTON_ID,
          ...owner,
        });
        expect(gone).toEqual(missing);
      }
    });
  });

  describe('the calendar owner is never invited to their own event by a secretary', () => {
    test('by id', async () => {
      grant('write');
      const eventId = personalEvent('Own event');
      const result = await handleSendInvitation(ctxOf(SECRETARY_ID), {
        event_id: eventId,
        owner_id: OWNER_ID,
        invitee_id: OWNER_ID,
      });
      expect(result).toMatchObject({ success: false, mutationState: 'not_applied' });
      expect(result.error).toBe('The calendar owner is the organizer of this event and needs no invitation.');
      expect(fx.invitationRepo.getByEvent(eventId)).toHaveLength(0);
      expect(deliveries).toEqual([]);
    });

    test('by a username that resolves to the owner after the lookup', async () => {
      grant('write');
      const eventId = personalEvent('Own event');
      let lookups = 0;
      const result = await handleSendInvitation(
        ctxOf(SECRETARY_ID, {
          messageText: 'invite @owner_demo',
          resolveUsername: async () => {
            lookups++;
            return { id: OWNER_ID, firstName: 'Olga', username: 'owner_demo' };
          },
        }),
        { event_id: eventId, owner_id: OWNER_ID, invitee_username: 'owner_demo' },
      );
      expect(result).toMatchObject({ success: false, mutationState: 'not_applied' });
      expect(result.error).toBe('The calendar owner is the organizer of this event and needs no invitation.');
      expect(lookups).toBe(1);
      expect(fx.invitationRepo.getByEvent(eventId)).toHaveLength(0);
      expect(deliveries).toEqual([]);
    });
  });

  describe('write access is re-checked after the awaited recipient lookup', () => {
    /** A username lookup that revokes the delegation while it is in flight, then answers. */
    function revokingLookup(): Pick<AgentContext, 'resolveUsername'> {
      return {
        resolveUsername: async () => {
          grant('write', 'revoked');
          return { id: ANTON_ID, firstName: 'Anton', username: 'anton_a' };
        },
      };
    }

    test('send_invitation creates and delivers nothing when access is revoked during the lookup', async () => {
      grant('write');
      const eventId = personalEvent('Revoked mid-send');
      const result = await handleSendInvitation(ctxOf(SECRETARY_ID, revokingLookup()), {
        event_id: eventId,
        owner_id: OWNER_ID,
        invitee_username: 'anton_a',
      });
      expect(result).toMatchObject({ success: false, error: 'SECRETARY_ACCESS_DENIED', mutationState: 'not_applied' });
      expect(fx.invitationRepo.getByEvent(eventId)).toHaveLength(0);
      expect(deliveries).toEqual([]);
    });

    test('resend_invitation delivers nothing when access is revoked during the lookup', async () => {
      grant('write');
      const eventId = personalEvent('Revoked mid-resend');
      await handleSendInvitation(ctxOf(SECRETARY_ID), { event_id: eventId, owner_id: OWNER_ID, invitee_id: ANTON_ID });
      const invitation = fx.invitationRepo.getByEvent(eventId)[0]!;
      deliveries.length = 0;

      const result = await handleResendInvitation(ctxOf(SECRETARY_ID, revokingLookup()), {
        invitation_id: invitation.id,
        owner_id: OWNER_ID,
        invitee_username: 'anton_a',
      });
      expect(result).toMatchObject({ success: false, error: 'SECRETARY_ACCESS_DENIED' });
      expect(deliveries).toEqual([]);
    });
  });

  describe('the invitation card shows the event as it is when the invitation is created', () => {
    function renamingLookup(eventId: number): Pick<AgentContext, 'resolveUsername'> {
      return {
        resolveUsername: async () => {
          fx.eventService.updateEvent(eventId, OWNER_ID, { title: 'Renamed during lookup' });
          return { id: ANTON_ID, firstName: 'Anton', username: 'anton_a' };
        },
      };
    }

    test('send_invitation', async () => {
      grant('write');
      const eventId = personalEvent('Original title');
      const result = await handleSendInvitation(ctxOf(SECRETARY_ID, renamingLookup(eventId)), {
        event_id: eventId,
        owner_id: OWNER_ID,
        invitee_username: 'anton_a',
      });
      expect(result.success).toBe(true);
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]!.text).toContain('Renamed during lookup');
      expect(deliveries[0]!.text).not.toContain('Original title');
    });

    test('an event deleted during the lookup gets no invitation', async () => {
      grant('write');
      const eventId = personalEvent('Deleted during lookup');
      const result = await handleSendInvitation(
        ctxOf(SECRETARY_ID, {
          resolveUsername: async () => {
            fx.eventService.deleteEvent(eventId, OWNER_ID);
            return { id: ANTON_ID, firstName: 'Anton', username: 'anton_a' };
          },
        }),
        { event_id: eventId, owner_id: OWNER_ID, invitee_username: 'anton_a' },
      );
      const missing = await handleSendInvitation(ctxOf(SECRETARY_ID), {
        event_id: eventId + 1000,
        owner_id: OWNER_ID,
        invitee_id: ANTON_ID,
      });
      expect(result).toEqual(missing);
      expect(fx.invitationRepo.getByEvent(eventId)).toHaveLength(0);
      expect(deliveries).toEqual([]);
    });
  });
});
