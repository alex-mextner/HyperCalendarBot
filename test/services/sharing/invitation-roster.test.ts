// The roster block an invitation card carries: who organizes, who is invited, and each answer.
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { ContactRepository } from '../../../src/database/repositories/contact.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { ParticipantRepository } from '../../../src/database/repositories/participant.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { CalendarEvent, InvitationStatus } from '../../../src/database/types.ts';
import { formatInvitation } from '../../../src/services/event/formatters.ts';
import { formatAnsweredInvitationCard } from '../../../src/services/sharing/answered-invitation-card.ts';
import { readInvitationRoster } from '../../../src/services/sharing/invitation-roster.ts';

const ORGANIZER = 100;
const GROUP_CHAT = -1001;

function seed(description?: string) {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  const users = new UserRepository(db);
  const invitations = new InvitationRepository(db);
  const participants = new ParticipantRepository(db);
  const contacts = new ContactRepository(db);
  users.create({ telegram_id: ORGANIZER, first_name: 'Anna', username: 'anna_org' });
  const event = new EventRepository(db).create({
    user_id: ORGANIZER,
    title: 'Dinner',
    description,
    start_at: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    timezone: 'Europe/Belgrade',
  });
  const invite = (inviteeId: number, status: InvitationStatus = 'pending', inviteeUsername?: string) => {
    const inv = invitations.create({
      event_id: event.id,
      inviter_id: ORGANIZER,
      invitee_id: inviteeId,
      invitee_username: inviteeUsername,
    });
    if (status !== 'pending') invitations.updateStatus(inv.id, status, 'pending');
    return inv;
  };
  const person = (telegramId: number, firstName: string | null, username: string | null = null) =>
    users.create({ telegram_id: telegramId, first_name: firstName ?? undefined, username: username ?? undefined });
  return { db, event, invitations, participants, contacts, invite, person };
}

/** Card text for `chatId`, rendered through the production formatter with the roster read for that chat. */
function card(event: CalendarEvent, invitations: InvitationRepository, chatId: number, lang: 'en' | 'ru' = 'en') {
  return formatInvitation(
    event,
    event.timezone,
    lang,
    'Anna',
    ORGANIZER,
    'anna_org',
    'Europe/Belgrade',
    true,
    readInvitationRoster(invitations, event.id, chatId),
  );
}

/** The dinner of the 2026-09-27 incident, anonymized: four live invitees, one withdrawn. */
function seedDinner() {
  const s = seed();
  s.person(201, 'Boris');
  s.person(202, 'Vera');
  s.person(203, 'Gleb');
  s.person(204, 'Dina');
  s.person(205, 'Egor');
  s.invite(201, 'accepted');
  s.invite(202, 'maybe');
  s.invite(203);
  s.invite(204, 'declined');
  s.invite(205, 'cancelled');
  return s;
}

describe('invitation card roster', () => {
  test('lists the organizer and every live invitee with their answer, marking the reader', () => {
    const { event, invitations } = seedDinner();

    expect(
      card(event, invitations, 203).endsWith(
        [
          '👥 Participants:',
          '👑 Anna — organizer',
          '✅ Boris — going',
          '🤔 Vera — maybe',
          '⏳ Gleb (you) — no answer yet',
          '❌ Dina — not going',
        ].join('\n'),
      ),
    ).toBe(true);
    expect(card(event, invitations, 203)).not.toContain('Egor');
  });

  test('Russian card uses the informal reader mark', () => {
    const { event, invitations } = seedDinner();

    expect(
      card(event, invitations, 201, 'ru').endsWith(
        [
          '👥 Участники:',
          '👑 Anna — организатор',
          '✅ Boris (ты) — придёт',
          '🤔 Vera — возможно',
          '⏳ Gleb — ждём ответа',
          '❌ Dina — не придёт',
        ].join('\n'),
      ),
    ).toBe(true);
  });

  test('a group card shows the roster only in a group chat the organizer invited', () => {
    const { event, invitations, invite, person } = seedDinner();
    person(301, 'Member');
    invite(GROUP_CHAT);
    invite(-1002, 'cancelled');

    const invitedGroup = card(event, invitations, GROUP_CHAT);
    expect(invitedGroup).toContain('👑 Anna — organizer');
    expect(invitedGroup).toContain('✅ Boris — going');
    expect(invitedGroup).not.toContain('(you)');
    for (const chatId of [-1002, -1003]) {
      expect(card(event, invitations, chatId)).not.toContain('Participants:');
    }
  });

  test('a private reader who is not invited gets no roster', () => {
    const { event, invitations } = seedDinner();

    expect(card(event, invitations, 205)).not.toContain('Participants:');
    expect(card(event, invitations, 999)).not.toContain('Participants:');
  });

  test('group members who answered in the invited group are listed with their answer', () => {
    const { event, invitations, participants, invite, person } = seed();
    person(201, 'Boris');
    person(301, 'Mila');
    person(302, 'Oleg');
    invite(201);
    invite(GROUP_CHAT);
    participants.add(event.id, 301, 'accepted', 'attendee', GROUP_CHAT);
    participants.add(event.id, 302, 'declined', 'attendee', GROUP_CHAT);
    // A pending re-invite never masks a "going" the invitee already gave through the group card
    participants.add(event.id, 201, 'accepted', 'attendee', GROUP_CHAT);

    const text = card(event, invitations, GROUP_CHAT);
    expect(text).toContain('✅ Boris — going');
    expect(text).toContain('✅ Mila — going');
    expect(text).toContain('❌ Oleg — not going');
  });

  test('group answers are not listed once the group invitation is withdrawn', () => {
    const { event, invitations, participants, invite, person } = seed();
    person(201, 'Boris');
    person(301, 'Mila');
    invite(201);
    const group = invite(GROUP_CHAT);
    participants.add(event.id, 301, 'accepted', 'attendee', GROUP_CHAT);
    invitations.updateStatus(group.id, 'cancelled', 'pending');

    expect(card(event, invitations, 201)).not.toContain('Mila');
  });

  test("a member's answer in a withdrawn group never reaches a group invited later", () => {
    const { event, invitations, participants, invite, person } = seed();
    person(201, 'Boris');
    person(301, 'Mila');
    invite(201);
    const groupA = invite(GROUP_CHAT);
    participants.add(event.id, 301, 'accepted', 'attendee', GROUP_CHAT);
    invitations.updateStatus(groupA.id, 'cancelled', 'pending');
    invite(-1002);

    expect(card(event, invitations, -1002)).toContain('⏳ Boris — no answer yet');
    expect(card(event, invitations, -1002)).not.toContain('Mila');
    expect(card(event, invitations, 201)).not.toContain('Mila');
  });

  test("each group card lists only its own members' answers; answers of unknown origin are never listed", () => {
    const { event, invitations, participants, invite, person } = seed();
    person(301, 'Mila');
    person(302, 'Oleg');
    person(303, 'Legacy');
    invite(GROUP_CHAT);
    invite(-1002);
    participants.add(event.id, 301, 'accepted', 'attendee', GROUP_CHAT);
    participants.add(event.id, 302, 'accepted', 'attendee', -1002);
    participants.add(event.id, 303, 'accepted');

    const groupA = card(event, invitations, GROUP_CHAT);
    expect(groupA).toContain('✅ Mila — going');
    expect(groupA).not.toContain('Oleg');
    expect(groupA).not.toContain('Legacy');
    expect(card(event, invitations, -1002)).not.toContain('Mila');
  });

  test("an invitee's latest invitation is the one sent last, even after the clock stepped back", () => {
    const { db, event, invitations, invite, person } = seed();
    person(201, 'Boris');
    person(202, 'Vera');
    invite(202);
    // Past dates, so no later insert's datetime('now') can collide with UNIQUE(event_id, invitee_id, created_at)
    const sentAt = db.prepare('UPDATE invitations SET created_at = ? WHERE id = ?');
    sentAt.run('2020-01-01 12:00:00', invite(201, 'accepted').id);
    sentAt.run('2020-01-01 11:00:00', invite(201, 'cancelled').id);
    expect(card(event, invitations, 202)).not.toContain('Boris');

    sentAt.run('2020-01-01 10:00:00', invite(201, 'accepted').id);
    expect(card(event, invitations, 202)).toContain('✅ Boris — going');

    // A group whose re-invitation was withdrawn no longer sees the roster.
    sentAt.run('2020-01-01 12:00:00', invite(GROUP_CHAT).id);
    sentAt.run('2020-01-01 11:00:00', invite(GROUP_CHAT, 'cancelled').id);
    expect(card(event, invitations, GROUP_CHAT)).not.toContain('Participants:');
  });

  test('names come from the profile, then the username, then the organizer contact, else a neutral label', () => {
    const { event, invitations, contacts, invite, person } = seed();
    person(201, 'Boris', 'boris_tg');
    person(202, null, 'vera_tg');
    invite(201);
    invite(202);
    invite(203, 'pending', 'gleb_tg');
    contacts.add(ORGANIZER, 'Dina Contact', undefined, 204);
    invite(204);
    invite(205);

    const text = card(event, invitations, 201);
    expect(text).toContain('⏳ Boris (you) — no answer yet');
    expect(text).toContain('⏳ @vera_tg — no answer yet');
    expect(text).toContain('⏳ @gleb_tg — no answer yet');
    expect(text).toContain('⏳ Dina Contact — no answer yet');
    expect(text).toContain('⏳ Guest — no answer yet');
  });

  test('names are HTML-escaped, stripped of control characters and shortened', () => {
    const { event, invitations, invite, person } = seed();
    person(201, '<b>Mal & Co</b>\u202E');
    person(202, 'X'.repeat(80));
    invite(201);
    invite(202);

    const text = card(event, invitations, 201);
    expect(text).toContain('⏳ &lt;b&gt;Mal &amp; Co&lt;/b&gt; (you) — no answer yet');
    expect(text).not.toContain('\u202E');
    expect(text).toContain(`⏳ ${'X'.repeat(39)}… — no answer yet`);
  });

  test('a long roster shows the first ten, going first, and counts the rest', () => {
    const { event, invitations, invite, person } = seed();
    for (let i = 1; i <= 14; i++) {
      person(200 + i, `Guest${i}`);
      invite(200 + i, i === 14 ? 'accepted' : 'pending');
    }

    const en = card(event, invitations, 201);
    const roster = en.slice(en.indexOf('👥'));
    expect(roster.split('\n')).toHaveLength(1 + 1 + 10 + 1);
    expect(roster).toContain('👑 Anna — organizer\n✅ Guest14 — going\n⏳ Guest1 (you)');
    expect(roster.endsWith('…and 4 more')).toBe(true);
    expect(card(event, invitations, 201, 'ru').endsWith('…и ещё 4 человека')).toBe(true);

    for (let i = 15; i <= 16; i++) {
      person(200 + i, `Guest${i}`);
      invite(200 + i);
    }
    expect(card(event, invitations, 201, 'ru').endsWith('…и ещё 6 человек')).toBe(true);
  });

  test('the roster never pushes a card past the Telegram message limit', () => {
    const { event, invitations, invite, person } = seed('Notes '.repeat(640));
    for (let i = 1; i <= 12; i++) {
      person(200 + i, `Guest${i}`.padEnd(40, 'x'));
      invite(200 + i);
    }

    const text = card(event, invitations, 201);
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toContain('👑 Anna — organizer');
    expect(text).toMatch(/…and \d+ more$/);
  });

  test('an answered card lists the roster instead of the single own-answer line', async () => {
    const { event, invitations } = seedDinner();

    const text = await formatAnsweredInvitationCard(
      'accepted',
      event,
      { userId: 201, language: 'en', timezone: 'Europe/Belgrade' },
      {},
      readInvitationRoster(invitations, event.id, 201),
    );
    expect(text).toContain('✅ Boris (you) — going\n🤔 Vera — maybe');
    expect(text).not.toContain('Your invitation');
  });
});
