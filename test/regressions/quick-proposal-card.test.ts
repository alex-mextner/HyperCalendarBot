import { Database } from 'bun:sqlite';
import { describe, expect, mock, test } from 'bun:test';
import type { InlineKeyboard } from 'gramio';
import { t } from '../../src/config/constants.ts';
import { migrations } from '../../src/database/migrations.ts';
import { AgendaRepository } from '../../src/database/repositories/agenda.repository.ts';
import { EventRepository } from '../../src/database/repositories/event.repository.ts';
import { InvitationRepository } from '../../src/database/repositories/invitation.repository.ts';
import { SharingSettingsRepository } from '../../src/database/repositories/sharing-settings.repository.ts';
import { UserRepository } from '../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';
import {
  type LocationVerificationDeps,
  LocationVerificationService,
} from '../../src/services/location/location-verification-service.ts';
import { invitationRsvpKeyboard } from '../../src/services/sharing/invitation-rsvp-keyboard.ts';
import { InvitationService } from '../../src/services/sharing/invitation-service.ts';
import { formatProposedTime } from '../../src/utils/invite-time-format.ts';
import { makeCallbackHandler, makeCallbackTap } from '../helpers/callback-handler.ts';

const INVITER = 100;
const INVITEE = 200;
const CARD_MESSAGE_ID = 111;
const RESOLVED_ADDRESS = 'Fixture Cafe, 1 Example Street, Testville';

/** A Telegram chat: editing a message without reply_markup removes its inline keyboard. */
interface ChatMessage {
  text: string;
  keyboard: InlineKeyboard | null;
}

/** applyResolvedLocation only needs the repositories and the edit callback; the rest stays unset. */
function makeLocationService(deps: Partial<LocationVerificationDeps>): LocationVerificationService {
  return new LocationVerificationService(deps as unknown as LocationVerificationDeps);
}

const INVITEE_USER = { telegram_id: INVITEE, language: 'en', timezone: 'UTC' } as const;

/** A pending invitation whose card (message CARD_MESSAGE_ID) sits in the invitee's chat, and the bot around it. */
function setup() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  const userRepo = new UserRepository(db);
  userRepo.create({ telegram_id: INVITER, timezone: 'UTC', language: 'en' });
  userRepo.create({ telegram_id: INVITEE, timezone: 'UTC', language: 'en' });
  const eventRepo = new EventRepository(db);
  const invitationRepo = new InvitationRepository(db);
  const invitationService = new InvitationService(invitationRepo, eventRepo, new SharingSettingsRepository(db));
  const event = eventRepo.create({
    user_id: INVITER,
    title: 'Fixture meetup',
    start_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    timezone: 'UTC',
    location: 'Fixture Cafe',
  });
  const invitation = invitationService.sendInvitation(event.id, INVITER, INVITEE).invitation!;
  invitationRepo.setMessageInfo(invitation.id, CARD_MESSAGE_ID, INVITEE);

  const chat = new Map<number, ChatMessage>([
    [
      CARD_MESSAGE_ID,
      { text: 'Fixture meetup at Fixture Cafe', keyboard: invitationRsvpKeyboard(invitation.id, 'en') },
    ],
  ]);
  const editMessage = async (_chatId: number, messageId: number, text: string, keyboard?: InlineKeyboard) => {
    chat.set(messageId, { text, keyboard: keyboard ?? null });
  };
  const handler = makeCallbackHandler({
    invitationService,
    eventRepo,
    invitationRepo,
    invitationNotifyDeps: { userRepo, sendMessage: mock(() => Promise.resolve()), editMessage },
  });
  return { db, userRepo, eventRepo, invitationRepo, event, invitation, chat, editMessage, handler };
}

describe('quick +30/+60 time proposal', () => {
  test('replaces the invitation card, so a later location resolution leaves no stale card with live buttons', async () => {
    const { db, userRepo, eventRepo, invitationRepo, event, invitation, chat, editMessage, handler } = setup();
    // The +30 button sits on the separate "What time do you suggest?" prompt, not on the card.
    const tap = makeCallbackTap(`inv:propose:${invitation.id}:+30`, INVITEE_USER);
    await handler(tap.ctx);

    const proposedTime = invitationRepo.findById(invitation.id)!.proposed_time;
    expect(proposedTime).not.toBeNull();
    const proposalSent = t('en').invite_propose_sent(formatProposedTime(proposedTime!, 'UTC', 'en'));

    await makeLocationService({
      eventRepo,
      userRepo,
      invitationRepo,
      agendaRepository: new AgendaRepository(db),
      editMessage: (chatId, messageId, text, options) => editMessage(chatId, messageId, text, options.reply_markup),
    }).applyResolvedLocation(eventRepo.findById(event.id, INVITER)!, {
      formattedAddress: RESOLVED_ADDRESS,
      latitude: 1.5,
      longitude: 2.5,
      city: 'Testville',
      country: 'Testland',
      placeId: 'fixture-place',
      googleMapsUrl: 'https://www.google.com/maps/search/?api=1&query=1.5,2.5',
      venueName: null,
    });

    expect(chat.get(CARD_MESSAGE_ID)).toEqual({ text: proposalSent, keyboard: null });
  });

  test('a stale +30 tapped after the invitee declined leaves the declined card as it is', async () => {
    const { invitationRepo, invitation, chat, handler } = setup();

    // The invitee taps Other time (the +30/+60 prompt appears), then Decline on the card itself.
    const decline = makeCallbackTap(`inv:decline:${invitation.id}`, INVITEE_USER);
    await handler(decline.ctx);
    const [declinedText] = decline.editText.mock.calls.at(-1)!;
    chat.set(CARD_MESSAGE_ID, { text: declinedText, keyboard: null });

    // The prompt kept its buttons, so the stale +30 is still tappable.
    await handler(makeCallbackTap(`inv:propose:${invitation.id}:+30`, INVITEE_USER).ctx);

    expect(invitationRepo.findById(invitation.id)!.status).toBe('declined');
    expect(chat.get(CARD_MESSAGE_ID)).toEqual({ text: declinedText, keyboard: null });
  });

  test('a proposal superseded while the tap awaits Telegram does not overwrite the card', async () => {
    const { invitationRepo, invitation, chat, handler } = setup();
    const cardBefore = chat.get(CARD_MESSAGE_ID);
    const newerProposal = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const tap = makeCallbackTap(`inv:propose:${invitation.id}:+30`, INVITEE_USER);
    // Another proposal (a second quick tap or a typed time) is stored while this tap is answered.
    tap.answer.mockImplementation(async () => {
      invitationRepo.setProposedTime(invitation.id, newerProposal);
      return true;
    });

    await handler(tap.ctx);

    expect(invitationRepo.findById(invitation.id)!.proposed_time).toBe(newerProposal);
    expect(chat.get(CARD_MESSAGE_ID)).toEqual(cardBefore);
  });
});
