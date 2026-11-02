// A write-secretary invites people to an event in the delegating owner's calendar (incident
// 2026-10-31: the event was created with owner_id, then every send_invitation said "Event not found"
// because the handler looked only into the caller's own calendar). Ids are synthetic.
import { beforeEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { t } from '../../../../src/config/constants.ts';
import { CalendarProposalRepository } from '../../../../src/database/repositories/calendar-proposal.repository.ts';
import { ContactRepository } from '../../../../src/database/repositories/contact.repository.ts';
import { SecretaryRepository } from '../../../../src/database/repositories/secretary.repository.ts';
import type { SecretaryPermission, SecretaryStatus } from '../../../../src/database/types.ts';
import { confirmRecipientApproval } from '../../../../src/services/ai/recipient-confirmation.ts';
import { buildSystemPrompt } from '../../../../src/services/ai/system-prompt.ts';
import { executeTool } from '../../../../src/services/ai/tool-executor.ts';
import {
  handleCancelInvitation,
  handleGetInvitationStatus,
  handleResendInvitation,
  handleSendInvitation,
} from '../../../../src/services/ai/tool-handlers/sharing.ts';
import { getToolDefinitions } from '../../../../src/services/ai/tools.ts';
import type { AgentContext, TelegramSender } from '../../../../src/services/ai/types.ts';
import { createSharingFixture, futureStartAt, type SharingFixture } from './sharing-fixtures.ts';

const SECRETARY_ID = 1001;
const OWNER_ID = 2002;
const ANTON_ID = 3001;
const YULIA_ID = 3002;
const STRANGER_ID = 4004;
/** An id no tool ever returned: what the model invented in the incident. */
const INVENTED_ID = 5005005;
const INCIDENT_MESSAGE = 'Настолки поставь в календарь Ольги и пригласи меня, Сэма и Кима';

interface DeliveryLog {
  invitations: { inviteeId: number; text: string; invitationId: number }[];
  messages: { chatId: number; text: string }[];
  connectedSessionSends: number;
}

/** A bot sender that reaches everyone (botReachable) or nobody; it records every delivery. */
function recordingSender(log: DeliveryLog, botReachable: boolean): TelegramSender {
  return {
    sendMessage: async (chatId, text) => {
      log.messages.push({ chatId, text });
      return { message_id: 1 };
    },
    editMessageText: async () => {},
    sendInvitation: async (inviteeId, text, invitationId) => {
      log.invitations.push({ inviteeId, text, invitationId });
      return botReachable ? { message_id: 700 + invitationId } : null;
    },
    sendAsConnectedUser: async () => {
      log.connectedSessionSends++;
      return true;
    },
  };
}

describe('send_invitation on behalf of the calendar owner (secretary)', () => {
  let fx: SharingFixture;
  let secretaryRepo: SecretaryRepository;
  let calendarProposalRepo: CalendarProposalRepository;
  let contactRepo: ContactRepository;
  let log: DeliveryLog;

  /** Sets the delegation to exactly this permission and status (the repository never demotes an active record). */
  function grant(permission: SecretaryPermission, status: SecretaryStatus = 'active', secretaryId = SECRETARY_ID) {
    secretaryRepo.upsert({ owner_id: OWNER_ID, secretary_id: secretaryId, permission });
    fx.db
      .prepare('UPDATE calendar_secretaries SET permission = ?, status = ? WHERE owner_id = ? AND secretary_id = ?')
      .run(permission, status, OWNER_ID, secretaryId);
  }

  function secretaryCtx(overrides: Partial<AgentContext> = {}, callerId = SECRETARY_ID): AgentContext {
    return fx.makeCtx({
      user: fx.userRepo.findByTelegramId(callerId)!,
      chatId: callerId,
      messageText: INCIDENT_MESSAGE,
      contactRepo,
      secretary: { secretaryRepo, secretaryForLine: undefined, calendarProposalRepo },
      sender: recordingSender(log, true),
      deepLinkService: fx.deepLinkService,
      botUsername: 'TestBot',
      ...overrides,
    });
  }

  function ownersEvent(title = 'Board games'): number {
    const startAt = futureStartAt();
    return fx.eventService.createEvent({
      user_id: OWNER_ID,
      title,
      start_at: startAt,
      end_at: new Date(Date.parse(startAt) + 3_600_000).toISOString(),
      timezone: 'UTC',
    }).id;
  }

  beforeEach(() => {
    fx = createSharingFixture();
    log = { invitations: [], messages: [], connectedSessionSends: 0 };
    secretaryRepo = new SecretaryRepository(fx.db);
    calendarProposalRepo = new CalendarProposalRepository(fx.db);
    contactRepo = new ContactRepository(fx.db);
    fx.userRepo.create({ telegram_id: SECRETARY_ID, username: 'requester_a', first_name: 'Kim', language: 'ru' });
    fx.userRepo.create({ telegram_id: OWNER_ID, first_name: 'Olga', language: 'ru' });
    fx.userRepo.create({ telegram_id: ANTON_ID, first_name: 'Anton' });
    fx.userRepo.create({ telegram_id: YULIA_ID, first_name: 'Yulia' });
    fx.userRepo.create({ telegram_id: STRANGER_ID, first_name: 'Stranger' });
    contactRepo.upsert(SECRETARY_ID, 'Anton', undefined, ANTON_ID);
    contactRepo.upsert(SECRETARY_ID, 'Yulia', undefined, YULIA_ID);
  });

  test('replays the incident: create in the owner calendar, then invite me and two contacts', async () => {
    grant('write');
    const ctx = secretaryCtx();
    const startAt = futureStartAt();
    const created = await executeTool(ctx, 'create_event', {
      title: 'Board games',
      start_at: startAt,
      end_at: new Date(Date.parse(startAt) + 3_600_000).toISOString(),
      owner_id: OWNER_ID,
      scope: 'personal',
    });
    expect(created.success).toBe(true);
    const eventId = fx.eventRepo.findLatestCreatedByUser(OWNER_ID)!.id;

    for (const inviteeId of [SECRETARY_ID, ANTON_ID, YULIA_ID]) {
      const sent = await executeTool(ctx, 'send_invitation', {
        event_id: eventId,
        owner_id: OWNER_ID,
        invitee_id: inviteeId,
      });
      expect(sent.error).toBeUndefined();
      expect(sent.success).toBe(true);
    }

    const rows = fx.invitationRepo.getByEvent(eventId);
    expect(rows.map((row) => row.invitee_id).sort()).toEqual([SECRETARY_ID, ANTON_ID, YULIA_ID].sort());
    // The organizer on every row is the event owner: cards, RSVP notices and the roster key off it.
    expect(rows.every((row) => row.inviter_id === OWNER_ID)).toBe(true);
    expect(log.invitations.map((d) => d.inviteeId).sort()).toEqual([SECRETARY_ID, ANTON_ID, YULIA_ID].sort());
    // Every card names the owner as the sender and organizer, and lists the requester as a plain invitee.
    for (const delivery of log.invitations) {
      expect(delivery.text).toContain(`приглашение от <a href="tg://user?id=${OWNER_ID}">Olga</a>`);
      expect(delivery.text).toContain('Olga — организатор');
    }
    // The requester is not added to his own address book by inviting himself.
    expect(contactRepo.findByTelegramId(SECRETARY_ID, SECRETARY_ID)).toBeNull();
  });

  test('the same call without owner_id still finds nothing and creates no invitation', async () => {
    grant('write');
    const eventId = ownersEvent();
    const result = await handleSendInvitation(secretaryCtx(), { event_id: eventId, invitee_id: ANTON_ID });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Event not found');
    expect(result.mutationState).toBe('not_applied');
    // The model is told where the event is: the calendar this caller manages, not a stranger's.
    expect(result.agentHint).toContain(`owner_id ${OWNER_ID}`);
    expect(fx.invitationRepo.getByEvent(eventId)).toHaveLength(0);
    expect(log.invitations).toHaveLength(0);
  });

  test('a stranger learns nothing about whose calendar holds the event', async () => {
    const eventId = ownersEvent();
    const result = await handleSendInvitation(secretaryCtx({}, STRANGER_ID), {
      event_id: eventId,
      invitee_id: ANTON_ID,
    });
    expect(result).toMatchObject({ success: false, error: 'Event not found' });
    expect(result.agentHint).toBeUndefined();
  });

  test('a read-only secretary cannot invite into the owner calendar', async () => {
    grant('read');
    const eventId = ownersEvent();
    const result = await handleSendInvitation(secretaryCtx(), {
      event_id: eventId,
      owner_id: OWNER_ID,
      invitee_id: ANTON_ID,
    });
    expect(result).toMatchObject({ success: false, error: 'SECRETARY_ACCESS_DENIED', mutationState: 'not_applied' });
    expect(fx.invitationRepo.getByEvent(eventId)).toHaveLength(0);
    expect(log.invitations).toHaveLength(0);
  });

  test('a stranger, a pending secretary and a missing secretary capability are denied', async () => {
    const eventId = ownersEvent();
    const input = { event_id: eventId, owner_id: OWNER_ID, invitee_id: ANTON_ID };

    expect(await handleSendInvitation(secretaryCtx({}, STRANGER_ID), input)).toMatchObject({
      success: false,
      error: 'SECRETARY_ACCESS_DENIED',
    });
    grant('write', 'pending');
    expect(await handleSendInvitation(secretaryCtx(), input)).toMatchObject({
      success: false,
      error: 'SECRETARY_ACCESS_DENIED',
    });
    grant('write', 'revoked');
    expect(await handleSendInvitation(secretaryCtx(), input)).toMatchObject({
      success: false,
      error: 'SECRETARY_ACCESS_DENIED',
    });
    expect(await handleSendInvitation(secretaryCtx({ secretary: undefined }), input)).toMatchObject({
      success: false,
      error: 'SECRETARY_ACCESS_DENIED',
    });
    expect(fx.invitationRepo.getByEvent(eventId)).toHaveLength(0);
    expect(log.invitations).toHaveLength(0);
  });

  test('an invented numeric id is refused even with write access', async () => {
    grant('write');
    const eventId = ownersEvent();
    const result = await executeTool(secretaryCtx(), 'send_invitation', {
      event_id: eventId,
      owner_id: OWNER_ID,
      invitee_id: INVENTED_ID,
    });
    expect(result.success).toBe(false);
    expect(result.error).toBe(t('ru').aiTools.meta.recipientUnverified);
    expect(fx.invitationRepo.getByEvent(eventId)).toHaveLength(0);
    expect(log.invitations).toHaveLength(0);
  });

  describe("a bare numeric id that needs the secretary's own confirmation tap", () => {
    function withKeyboard(): { ctx: AgentContext; keyboards: number[]; tokens: string[] } {
      const keyboards: number[] = [];
      const tokens: string[] = [];
      const sender = {
        ...recordingSender(log, true),
        sendMessageWithKeyboard: async (
          chatId: number,
          _text: string,
          keyboard: { toJSON(): { inline_keyboard?: { callback_data?: string }[][] } },
        ) => {
          keyboards.push(chatId);
          for (const row of keyboard.toJSON().inline_keyboard ?? [])
            for (const b of row) tokens.push(b.callback_data ?? '');
          return { message_id: 2 };
        },
      } as unknown as TelegramSender;
      return { ctx: secretaryCtx({ sender }), keyboards, tokens };
    }

    test("the hint offers no pick_users, which cannot invite into the owner's calendar", async () => {
      grant('write');
      const eventId = ownersEvent();
      const { ctx, keyboards } = withKeyboard();
      const result = await handleSendInvitation(ctx, {
        event_id: eventId,
        owner_id: OWNER_ID,
        invitee_id: INVENTED_ID,
      });
      expect(keyboards).toEqual([SECRETARY_ID]);
      expect(result.agentHint).toContain('Wait for the actual confirmation callback; it says how to send');
      expect(result.agentHint).not.toContain('pick_users');
    });

    test('after the tap, the secretary sends for the owner with force=true and owner_id; without the tap nothing is sent', async () => {
      grant('write');
      const eventId = ownersEvent();
      const { ctx, tokens } = withKeyboard();
      const send = { event_id: eventId, owner_id: OWNER_ID, invitee_id: INVENTED_ID, force: true };
      expect((await handleSendInvitation(ctx, send)).success).toBe(false);
      expect(fx.invitationRepo.getByEvent(eventId)).toHaveLength(0);
      await handleSendInvitation(ctx, { ...send, force: undefined });
      const token = tokens.find((data) => data.startsWith('ric:'))?.slice('ric:'.length) ?? '';
      expect(confirmRecipientApproval(token, SECRETARY_ID, SECRETARY_ID)).not.toBeNull();
      const sent = await handleSendInvitation(ctx, send);
      expect(sent.success).toBe(true);
      expect(fx.invitationRepo.getByEvent(eventId).map((row) => row.invitee_id)).toEqual([INVENTED_ID]);
      expect((await handleSendInvitation(ctx, send)).success).toBe(false);
    });

    test("the owner's own invitation keeps the hint with pick_users and remembers no owner", async () => {
      const eventId = ownersEvent();
      const tokens: string[] = [];
      const sender = {
        ...recordingSender(log, true),
        sendMessageWithKeyboard: async (
          _chatId: number,
          _text: string,
          keyboard: { toJSON(): { inline_keyboard?: { callback_data?: string }[][] } },
        ) => {
          for (const row of keyboard.toJSON().inline_keyboard ?? [])
            for (const b of row) tokens.push(b.callback_data ?? '');
          return { message_id: 2 };
        },
      } as unknown as TelegramSender;
      const result = await handleSendInvitation(secretaryCtx({ sender }, OWNER_ID), {
        event_id: eventId,
        invitee_id: INVENTED_ID,
      });
      expect(result.agentHint).toContain('pick_users');
      const token = tokens.find((data) => data.startsWith('ric:'))?.slice('ric:'.length) ?? '';
      const approval = confirmRecipientApproval(token, OWNER_ID, OWNER_ID);
      expect(approval).toMatchObject({ eventId, recipientId: INVENTED_ID });
      expect(approval?.ownerId).toBeUndefined();
    });

    test('the confirmation the secretary taps remembers the owner it was for', async () => {
      grant('write');
      const eventId = ownersEvent();
      const { ctx, tokens } = withKeyboard();
      await handleSendInvitation(ctx, { event_id: eventId, owner_id: OWNER_ID, invitee_id: INVENTED_ID });
      const token = tokens.find((data) => data.startsWith('ric:'))?.slice('ric:'.length) ?? '';
      expect(confirmRecipientApproval(token, SECRETARY_ID, SECRETARY_ID)).toMatchObject({
        eventId,
        recipientId: INVENTED_ID,
        ownerId: OWNER_ID,
      });
    });
  });

  test('inviting the calendar owner is rejected with a reason, not "cannot invite yourself"', async () => {
    grant('write');
    const eventId = ownersEvent();
    const result = await handleSendInvitation(secretaryCtx({ messageText: `invite ${OWNER_ID}` }), {
      event_id: eventId,
      owner_id: OWNER_ID,
      invitee_id: OWNER_ID,
    });
    expect(result.success).toBe(false);
    expect(result.mutationState).toBe('not_applied');
    expect(result.error).toContain('organizer');
    expect(fx.invitationRepo.getByEvent(eventId)).toHaveLength(0);
  });

  test('an unknown @username opens the picker for the owner but not for a secretary (the picker cannot invite there)', async () => {
    grant('write');
    const eventId = ownersEvent();
    const pickerRequests: number[] = [];
    const withPicker: TelegramSender = {
      ...recordingSender(log, true),
      sendUserPicker: async (_chatId, _text, requestId) => {
        pickerRequests.push(requestId);
        return { message_id: 9 };
      },
    };
    const unknownPerson = {
      messageText: 'invite @nobody_here',
      sender: withPicker,
      resolveUsername: async () => null,
    } satisfies Partial<AgentContext>;
    const input = { event_id: eventId, invitee_username: 'nobody_here' };

    const forSecretary = await handleSendInvitation(secretaryCtx(unknownPerson), { ...input, owner_id: OWNER_ID });
    expect(forSecretary.success).toBe(false);
    expect(forSecretary.agentHint).toContain('pick_users cannot invite into');
    expect(pickerRequests).toEqual([]);

    const forOwner = await handleSendInvitation(secretaryCtx(unknownPerson, OWNER_ID), input);
    expect(forOwner.awaitingInput).toEqual({ kind: 'chat' });
    expect(pickerRequests).toEqual([eventId]);
  });

  test('a failed bot delivery reaches the secretary as a link, never the connected account of anyone', async () => {
    grant('write');
    const eventId = ownersEvent();
    const result = await handleSendInvitation(secretaryCtx({ sender: recordingSender(log, false) }), {
      event_id: eventId,
      owner_id: OWNER_ID,
      invitee_id: ANTON_ID,
    });
    expect(result.success).toBe(true);
    expect(log.connectedSessionSends).toBe(0);
    expect(log.messages.map((m) => m.chatId)).toEqual([SECRETARY_ID]);
    expect(log.messages[0]!.text).toContain('t.me/TestBot');
    expect(result.effect).toEqual({ kind: 'invitation', delivery: 'manual_forward' });
  });

  test('the owner flow keeps using the connected account of the inviter', async () => {
    const eventId = ownersEvent();
    contactRepo.upsert(OWNER_ID, 'Anton', undefined, ANTON_ID);
    const ctx = secretaryCtx({ sender: recordingSender(log, false) }, OWNER_ID);
    const result = await handleSendInvitation(ctx, { event_id: eventId, invitee_id: ANTON_ID });
    expect(result.success).toBe(true);
    expect(log.connectedSessionSends).toBe(1);
  });

  test('cancel_invitation and resend_invitation act for the owner only with write access', async () => {
    grant('write');
    const eventId = ownersEvent();
    const ctx = secretaryCtx();
    await handleSendInvitation(ctx, { event_id: eventId, owner_id: OWNER_ID, invitee_id: ANTON_ID });
    await handleSendInvitation(ctx, { event_id: eventId, owner_id: OWNER_ID, invitee_id: YULIA_ID });
    const [toResend, toCancel] = fx.invitationRepo.getByEvent(eventId);

    expect(handleCancelInvitation(ctx, { invitation_id: toCancel!.id })).toMatchObject({ success: false });
    expect(await handleResendInvitation(ctx, { invitation_id: toResend!.id })).toMatchObject({ success: false });

    log.invitations.length = 0;
    const resent = await handleResendInvitation(ctx, { invitation_id: toResend!.id, owner_id: OWNER_ID });
    expect(resent.success).toBe(true);
    expect(log.invitations.map((d) => d.inviteeId)).toEqual([toResend!.invitee_id]);
    expect(log.connectedSessionSends).toBe(0);

    expect(handleCancelInvitation(ctx, { invitation_id: toCancel!.id, owner_id: OWNER_ID }).success).toBe(true);
    expect(fx.invitationRepo.findById(toCancel!.id)?.status).toBe('cancelled');

    grant('read');
    expect(handleCancelInvitation(ctx, { invitation_id: toResend!.id, owner_id: OWNER_ID })).toMatchObject({
      success: false,
      error: 'SECRETARY_ACCESS_DENIED',
    });
    expect(fx.invitationRepo.findById(toResend!.id)?.status).toBe('pending');
  });

  test('get_invitation_status shows the owner roster to a secretary with owner_id', async () => {
    grant('write');
    const eventId = ownersEvent('Board games roster');
    await handleSendInvitation(secretaryCtx(), { event_id: eventId, owner_id: OWNER_ID, invitee_id: ANTON_ID });

    const without = handleGetInvitationStatus(secretaryCtx(), { event_id: eventId });
    expect(without.success).toBe(false);

    const withOwner = handleGetInvitationStatus(secretaryCtx(), { event_id: eventId, owner_id: OWNER_ID });
    expect(withOwner.success).toBe(true);
    expect(withOwner.output).toContain('Anton');

    grant('read');
    expect(handleGetInvitationStatus(secretaryCtx(), { event_id: eventId, owner_id: OWNER_ID }).success).toBe(true);
    grant('write', 'revoked');
    expect(handleGetInvitationStatus(secretaryCtx(), { event_id: eventId, owner_id: OWNER_ID })).toMatchObject({
      success: false,
      error: 'SECRETARY_ACCESS_DENIED',
    });
  });

  test('get_invitation_status with owner_id never exposes an event another person organises, even one that invited the owner', () => {
    const THIRD_PERSON_ID = 7007;
    fx.userRepo.create({ telegram_id: THIRD_PERSON_ID, first_name: 'Third' });
    const foreignEvent = fx.eventService.createEvent({
      user_id: THIRD_PERSON_ID,
      title: 'Third party dinner',
      start_at: futureStartAt(),
      timezone: 'UTC',
    });
    expect(fx.invitationService.sendInvitation(foreignEvent.id, THIRD_PERSON_ID, OWNER_ID).success).toBe(true);
    fx.invitationService.sendInvitation(foreignEvent.id, THIRD_PERSON_ID, ANTON_ID);

    for (const permission of ['read', 'write'] as const) {
      grant(permission);
      const result = handleGetInvitationStatus(secretaryCtx(), { event_id: foreignEvent.id, owner_id: OWNER_ID });
      expect(result.success).toBe(false);
      expect(result.output ?? '').not.toContain('Anton');
      expect(result.agentHint ?? '').not.toContain(String(THIRD_PERSON_ID));
    }

    // The owner reading it as an invitee keeps working (the invitee path is the owner's own right).
    const asOwner = handleGetInvitationStatus(secretaryCtx({}, OWNER_ID), { event_id: foreignEvent.id });
    expect(asOwner.success).toBe(true);
  });

  test("get_invitation_status for the owner's own event names the owner as organizer and the secretary as requester", () => {
    grant('read');
    const eventId = ownersEvent('Roster identity');
    fx.invitationService.sendInvitation(eventId, OWNER_ID, ANTON_ID);

    const result = handleGetInvitationStatus(secretaryCtx(), { event_id: eventId, owner_id: OWNER_ID });
    expect(result.success).toBe(true);
    expect(result.agentHint).toContain(`"organizer_id":${OWNER_ID}`);
    expect(result.agentHint).toContain(`"requester_id":${SECRETARY_ID}`);
    expect(result.agentHint).toContain(`"calendar_owner_id":${OWNER_ID}`);
    expect(result.agentHint).toContain(`"invitee_ids":[${ANTON_ID}]`);
    // The secretary reads it as the organizer's roster, not as one of its invitees.
    expect(result.output).not.toContain('Organizer');
  });

  describe('a contact row id passed as invitee_id', () => {
    function contactRowId(ownerOfBook: number, name: string, telegramId?: number, username?: string): number {
      return contactRepo.upsert(ownerOfBook, name, username, telegramId).id;
    }

    test('the secretary is sent to the real telegram_id or an @username, never to pick_users', async () => {
      grant('write');
      const eventId = ownersEvent();
      const withTelegramId = contactRowId(SECRETARY_ID, 'Maria', 3003);
      const withoutTelegramId = contactRowId(SECRETARY_ID, 'Katya', undefined, 'katya_k');
      const noUsernameEither = contactRowId(SECRETARY_ID, 'Dmitry');

      for (const rowId of [withTelegramId, withoutTelegramId, noUsernameEither]) {
        const result = await handleSendInvitation(secretaryCtx(), {
          event_id: eventId,
          owner_id: OWNER_ID,
          invitee_id: rowId,
        });
        expect(result.success).toBe(false);
        expect(result.mutationState).toBe('not_applied');
        // Never advice to use the picker; the explanatory "does not work" note may name it.
        expect(result.agentHint).not.toMatch(/use pick_users|or pick_users|pick_users with/);
      }
      const hinted = await handleSendInvitation(secretaryCtx(), {
        event_id: eventId,
        owner_id: OWNER_ID,
        invitee_id: withTelegramId,
      });
      expect(hinted.agentHint).toContain('invitee_id 3003');
      const named = await handleSendInvitation(secretaryCtx(), {
        event_id: eventId,
        owner_id: OWNER_ID,
        invitee_id: withoutTelegramId,
      });
      expect(named.agentHint).toContain('invitee_username katya_k');
      const nameless = await handleSendInvitation(secretaryCtx(), {
        event_id: eventId,
        owner_id: OWNER_ID,
        invitee_id: noUsernameEither,
      });
      expect(nameless.agentHint).toContain('an @username the user gives you for that person');
    });

    test('the owner keeps the pick_users advice for their own event', async () => {
      const eventId = ownersEvent();
      const withTelegramId = contactRowId(OWNER_ID, 'Maria', 3003);
      const withoutTelegramId = contactRowId(OWNER_ID, 'Katya', undefined, 'katya_k');
      const ownerCtx = secretaryCtx({}, OWNER_ID);

      const first = await handleSendInvitation(ownerCtx, { event_id: eventId, invitee_id: withTelegramId });
      expect(first.agentHint).toContain('invitee_id 3003');
      expect(first.agentHint).toContain('pick_users');
      const second = await handleSendInvitation(ownerCtx, { event_id: eventId, invitee_id: withoutTelegramId });
      expect(second.agentHint).toContain('invitee_username katya_k');
      expect(second.agentHint).toContain(`pick_users with event_id ${eventId}`);
    });
  });

  test('the prompt tells a secretary the exact invitee_id for "me", and the real tool call it describes works', async () => {
    grant('write');
    // executeTool throttles identical writes for 5s process-wide, and every test's database starts at event 1.
    ownersEvent('Placeholder');
    const eventId = ownersEvent();
    const ctx = secretaryCtx({
      secretary: {
        secretaryRepo,
        secretaryForLine: `User ${OWNER_ID} (read+write)`,
        calendarProposalRepo,
      },
    });
    const prompt = buildSystemPrompt(ctx);
    const meId = Number(prompt.match(/invitee_id (\d+) is the user's own Telegram ID/)?.[1]);
    expect(meId).toBe(SECRETARY_ID);
    expect(prompt).toContain('SAME owner_id');
    expect(prompt).toContain('never write a telegram_id no tool returned');

    const sent = await executeTool(ctx, 'send_invitation', { event_id: eventId, owner_id: OWNER_ID, invitee_id: meId });
    expect(sent.success).toBe(true);
    expect(fx.invitationRepo.getByEvent(eventId)).toMatchObject([{ invitee_id: SECRETARY_ID, inviter_id: OWNER_ID }]);
  });

  test('a user without secretary access gets no invitation-on-behalf guidance and no own id', () => {
    const prompt = buildSystemPrompt(secretaryCtx({ secretary: undefined }));
    expect(prompt).not.toContain('SAME owner_id');
    expect(prompt).not.toContain("the user's own Telegram ID");
  });

  test('every invitation tool accepts owner_id with the one shared description', () => {
    const ownerIdParameters = z.object({
      properties: z.object({ owner_id: z.object({ description: z.string() }) }),
    });
    const tools = getToolDefinitions('text').filter((tool) => tool.type === 'function');
    const descriptions = ['send_invitation', 'get_invitation_status', 'cancel_invitation', 'resend_invitation'].map(
      (name) => {
        const tool = tools.find((candidate) => candidate.function.name === name);
        return ownerIdParameters.parse(tool?.function.parameters).properties.owner_id.description;
      },
    );
    expect(new Set(descriptions).size).toBe(1);
  });
});
