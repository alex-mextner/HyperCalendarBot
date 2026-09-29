// Delivered invitation cards follow their roster: every invitation, answer or withdrawal re-renders
// the other cards of the event in place, keeping each card's buttons.
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { CB, t } from '../../../src/config/constants.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { ParticipantRepository } from '../../../src/database/repositories/participant.repository.ts';
import { SharingSettingsRepository } from '../../../src/database/repositories/sharing-settings.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { DomainEventBus } from '../../../src/services/scheduled/domain-event-bus.ts';
import { InvitationCardRefresher, type InvitationEditOptions } from '../../../src/services/sharing/invitation-cards.ts';
import { groupRsvpKeyboard, invitationRsvpKeyboard } from '../../../src/services/sharing/invitation-rsvp-keyboard.ts';
import { InvitationService } from '../../../src/services/sharing/invitation-service.ts';

const ORGANIZER = 100;
const GROUP_CHAT = -1001;

interface CardEdit {
  chatId: number;
  messageId: number;
  text: string;
  /** The keyboard the edit sends, serialized as Telegram receives it */
  keyboard: string | undefined;
}

function setup() {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  const users = new UserRepository(db);
  const eventRepo = new EventRepository(db);
  const invitationRepo = new InvitationRepository(db);
  const bus = new DomainEventBus();
  const service = new InvitationService(
    invitationRepo,
    eventRepo,
    new SharingSettingsRepository(db),
    new ParticipantRepository(db),
    bus,
  );
  users.create({ telegram_id: ORGANIZER, first_name: 'Anna' });
  for (const [id, name] of [
    [201, 'Boris'],
    [202, 'Vera'],
    [203, 'Gleb'],
    [301, 'Mila'],
  ] as const) {
    users.create({ telegram_id: id, first_name: name });
  }
  const event = eventRepo.create({
    user_id: ORGANIZER,
    title: 'Dinner',
    start_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    timezone: 'Europe/Belgrade',
  });

  const edits: CardEdit[] = [];
  let editGate: Promise<void> = Promise.resolve();
  const refresher = new InvitationCardRefresher({
    eventRepo,
    invitationRepo,
    userRepo: users,
    editMessage: async (chatId: number, messageId: number, text: string, options: InvitationEditOptions) => {
      await editGate;
      edits.push({ chatId, messageId, text, keyboard: JSON.stringify(options.reply_markup) });
    },
  });
  const passes: Promise<void>[] = [];
  bus.on('invitationRoster.changed', (change) => {
    passes.push(refresher.refresh(change));
  });
  const settled = async () => {
    while (passes.length) await passes.shift();
  };

  /** Invite and deliver: the card the invitee (or group) received is message `messageId`. */
  const deliver = async (inviteeId: number, messageId: number) => {
    const invitation = service.sendInvitation(event.id, ORGANIZER, inviteeId).invitation!;
    invitationRepo.setMessageInfo(invitation.id, messageId, inviteeId);
    await settled();
    edits.length = 0;
    return invitation;
  };
  const lastEdit = (messageId: number) => edits.filter((edit) => edit.messageId === messageId).at(-1);
  const holdEdits = () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    editGate = promise;
    return resolve;
  };
  return { event, eventRepo, service, edits, deliver, settled, lastEdit, holdEdits };
}

describe('delivered invitation cards follow the roster', () => {
  test('an answer updates every other delivered card, each keeping its own buttons', async () => {
    const { event, service, edits, deliver, settled, lastEdit } = setup();
    const boris = await deliver(201, 11);
    const vera = await deliver(202, 12);
    await deliver(GROUP_CHAT, 13);
    const gleb = await deliver(203, 14);
    service.acceptInvitation(vera.id, 202);
    await settled();
    edits.length = 0;

    service.acceptInvitation(gleb.id, 203);
    await settled();

    const pending = lastEdit(11)!;
    expect(pending.chatId).toBe(201);
    expect(pending.text).toContain('⏳ Boris (you) — no answer yet');
    expect(pending.text).toContain('✅ Gleb — going');
    expect(pending.keyboard).toBe(JSON.stringify(invitationRsvpKeyboard(boris.id, 'en', event)));

    const answered = lastEdit(12)!;
    expect(answered.text).toContain('✅ Vera (you) — going');
    expect(answered.text).toContain('✅ Gleb — going');
    expect(answered.keyboard).toBeUndefined();

    const group = lastEdit(13)!;
    expect(group.chatId).toBe(GROUP_CHAT);
    expect(group.text).toContain('✅ Gleb — going');
    expect(group.keyboard).toBe(JSON.stringify(groupRsvpKeyboard(event.id, 'en', event)));

    // The answering invitee's own card is rewritten by their answer callback, not by the refresh.
    expect(lastEdit(14)).toBeUndefined();
  });

  test('a group member tapping Going updates the group card and the personal cards', async () => {
    const { event, service, deliver, settled, lastEdit } = setup();
    await deliver(201, 11);
    await deliver(GROUP_CHAT, 13);

    service.recordGroupAttendance(event.id, 301, 'accepted', GROUP_CHAT);
    await settled();

    expect(lastEdit(13)?.text).toContain('✅ Mila — going');
    expect(lastEdit(13)?.keyboard).toBe(JSON.stringify(groupRsvpKeyboard(event.id, 'en', event)));
    expect(lastEdit(11)?.text).toContain('✅ Mila — going');
  });

  test('an answer changed on the group card relabels the personal answered card to match its roster', async () => {
    const { event, service, deliver, settled, lastEdit } = setup();
    const boris = await deliver(201, 11);
    await deliver(GROUP_CHAT, 13);
    service.acceptInvitation(boris.id, 201);
    await settled();

    service.recordGroupAttendance(event.id, 201, 'declined', GROUP_CHAT);
    await settled();

    const card = lastEdit(11)!.text;
    expect(card.startsWith(t('en').invitation_declined)).toBe(true);
    expect(card).toContain('❌ Boris (you) — not going');
  });

  test('going on the group card after a personal decline relabels the personal card as going', async () => {
    const { event, service, deliver, settled, lastEdit } = setup();
    const boris = await deliver(201, 11);
    await deliver(GROUP_CHAT, 13);
    service.declineInvitation(boris.id, 201);
    await settled();

    service.recordGroupAttendance(event.id, 201, 'accepted', GROUP_CHAT);
    await settled();

    const card = lastEdit(11)!.text;
    expect(card.startsWith(t('en').invitation_accepted)).toBe(true);
    expect(card).toContain('✅ Boris (you) — going');
  });

  test('a confirmed place keeps its Map button on the cards a roster change re-renders', async () => {
    const { event, eventRepo, service, deliver, settled, lastEdit } = setup();
    const placed = eventRepo.update(event.id, ORGANIZER, {
      location: 'Harbour Cafe',
      resolved_address: 'Harbour Cafe, Quay 1',
      latitude: 42.1,
      longitude: 19.1,
      location_verified: 1,
    })!;
    const boris = await deliver(201, 11);
    await deliver(GROUP_CHAT, 13);
    const vera = await deliver(202, 12);

    service.acceptInvitation(vera.id, 202);
    await settled();

    const mapCallback = `"${CB.EVENT_MAP}:${event.id}"`;
    expect(lastEdit(11)?.keyboard).toContain(mapCallback);
    expect(lastEdit(11)?.keyboard).toBe(JSON.stringify(invitationRsvpKeyboard(boris.id, 'en', placed)));
    expect(lastEdit(13)?.keyboard).toContain(mapCallback);
    expect(lastEdit(13)?.keyboard).toBe(JSON.stringify(groupRsvpKeyboard(event.id, 'en', placed)));
  });

  test('a newly invited person appears on cards already delivered, a withdrawn one disappears', async () => {
    const { event, service, deliver, settled, lastEdit } = setup();
    await deliver(201, 11);

    const vera = service.sendInvitation(event.id, ORGANIZER, 202).invitation!;
    await settled();
    expect(lastEdit(11)?.text).toContain('⏳ Vera — no answer yet');

    service.cancelInvitation(vera.id, ORGANIZER);
    await settled();
    expect(lastEdit(11)?.text).not.toContain('Vera');
  });

  test('answers arriving mid-refresh end with every card showing the latest roster', async () => {
    const { service, deliver, edits, settled, lastEdit, holdEdits } = setup();
    await deliver(201, 11);
    const vera = await deliver(202, 12);
    const gleb = await deliver(203, 14);

    const release = holdEdits();
    service.acceptInvitation(vera.id, 202);
    service.declineInvitation(gleb.id, 203);
    release();
    await settled();

    expect(lastEdit(11)?.text).toContain('✅ Vera — going');
    expect(lastEdit(11)?.text).toContain('❌ Gleb — not going');
    // One pass for the first answer plus one catch-up pass, however many answers queued meanwhile.
    expect(edits.filter((edit) => edit.messageId === 11).length).toBeLessThanOrEqual(2);
  });
});
