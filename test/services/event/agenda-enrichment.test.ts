// Privacy and recurrence are exercised with migrated SQLite and the real visibility service.
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { AgendaRepository } from '../../../src/database/repositories/agenda.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { GroupChatRepository } from '../../../src/database/repositories/group-chat.repository.ts';
import { GroupMemberRepository } from '../../../src/database/repositories/group-member.repository.ts';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { ParticipantRepository } from '../../../src/database/repositories/participant.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { CreateEventData, InvitationStatus } from '../../../src/database/types.ts';
import { enrichAgenda, enrichAgendaEvents } from '../../../src/services/event/agenda-enrichment.ts';
import { EventService } from '../../../src/services/event/event-service.ts';

let db: Database;
let events: EventRepository;
let invitations: InvitationRepository;
let participants: ParticipantRepository;
let agenda: AgendaRepository;
let service: EventService;
const start = '2099-06-01T00:00:00.000Z';
const end = '2099-06-08T00:00:00.000Z';
beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  const users = new UserRepository(db);
  users.create({ telegram_id: 1, first_name: 'Owner <boss>' });
  users.create({ telegram_id: 2, first_name: 'Alice' });
  users.create({ telegram_id: 3, first_name: 'Private Bob' });
  users.create({ telegram_id: 4 });
  events = new EventRepository(db);
  invitations = new InvitationRepository(db);
  participants = new ParticipantRepository(db);
  agenda = new AgendaRepository(db);
  service = new EventService({
    eventRepo: events,
    participantRepo: participants,
    groupMemberRepo: new GroupMemberRepository(db),
    agendaRepository: agenda,
  });
});
afterEach(() => db.close());
function event(extra: Partial<CreateEventData> = {}) {
  return service.createEvent({
    user_id: 1,
    title: 'Meeting',
    start_at: '2099-06-01T10:00:00.000Z',
    timezone: 'UTC',
    ...extra,
  });
}
function invite(id: number, user: number, status: InvitationStatus = 'pending') {
  const row = invitations.create({ event_id: id, inviter_id: 1, invitee_id: user });
  if (status !== 'pending') invitations.updateStatus(row.id, status, 'pending');
  return row;
}
function visible(userId: number) {
  return enrichAgenda(service.getEventsInRange(userId, start, end), { userId, language: 'en' }, agenda);
}
test('latest invitation wins; deduplicate accepted participation', () => {
  const e = event();
  const old = invite(e.id, 2, 'accepted');
  db.query('UPDATE invitations SET created_at = ? WHERE id = ?').run('2000-01-01 00:00:00', old.id);
  participants.add(e.id, 2, 'accepted');
  invite(e.id, 2, 'cancelled');
  invite(e.id, 3, 'expired');
  const label = visible(1)[0]!.event.displayMetadata!.invitationStatus!;
  expect(label).toContain('Alice: 🚫 cancelled');
  expect(label).toContain('Private Bob: ⌛ expired');
  expect(label.match(/Alice/g)).toHaveLength(1);
  expect(label).not.toContain('accepted');
  expect(service.getEvent(e.id, 1)?.displayMetadata).toBeUndefined();
});
for (const status of ['pending', 'maybe', 'accepted', 'declined', 'cancelled', 'expired'] as const) {
  test(`owner sees ${status}; pending/nonaccepted invitation alone never grants calendar visibility`, () => {
    const e = event();
    invite(e.id, 2, status);
    expect(visible(1)[0]?.event.displayMetadata?.invitationStatus).toContain(status);
    expect(visible(2)).toEqual([]);
  });
}
test('accepted attendee sees only their incoming status and organizer, never another invitee', () => {
  const e = event();
  invite(e.id, 2, 'accepted');
  invite(e.id, 3, 'maybe');
  participants.add(e.id, 2, 'accepted');
  const label = visible(2)[0]!.event.displayMetadata!.invitationStatus!;
  expect(label).toContain('Your invitation: ✅ accepted');
  expect(label).toContain('Organizer: Owner <boss>');
  expect(label).not.toContain('Private Bob');
  expect(label).not.toContain('maybe');
  expect(visible(4)).toEqual([]);
  expect(enrichAgendaEvents([e], { userId: 4 }, agenda)[0]?.displayMetadata).toBeUndefined();
});
test('group agendas and personal views of group events contain counts only', () => {
  const groups = new GroupChatRepository(db);
  groups.upsertGroup({ chat_id: -10, added_by: 1 });
  new GroupMemberRepository(db).upsert(-10, 1);
  const e = event({ owner_type: 'group', group_id: -10 });
  participants.add(e.id, 2, 'accepted');
  participants.add(e.id, 3, 'maybe');
  invite(e.id, 4, 'pending');
  for (const groupId of [-10, undefined]) {
    const occurrences = groupId
      ? service.getEventsInRangeForGroup(groupId, start, end)
      : service.getEventsInRange(1, start, end);
    const label = enrichAgenda(occurrences, { userId: 1, groupId }, agenda)[0]!.event.displayMetadata!
      .invitationStatus!;
    expect(label).toBe('Participants: 2 (✅ accepted 1, ❔ maybe 1)');
    expect(label).not.toMatch(/Alice|Private Bob|pending|Owner/);
  }
  const personal = event();
  invite(personal.id, 3);
  expect(enrichAgendaEvents([personal], { userId: 1, groupId: -10 }, agenda)[0]?.displayMetadata).toBeUndefined();
});
test('missing repository is unknown; checked empty storage explicitly says no invitations; mentions are description only', () => {
  const e = event({ description: 'Meet @alice at https://maps.google.com/?q=note' });
  expect(enrichAgendaEvents([e], { userId: 1 })[0]?.displayMetadata).toBeUndefined();
  expect(enrichAgendaEvents([e], { userId: 1 }, agenda)[0]?.displayMetadata?.invitationStatus).toBe('No invitations');
  expect(enrichAgendaEvents([e], { userId: 1, language: 'ru' }, agenda)[0]?.displayMetadata?.invitationStatus).toBe(
    'Нет приглашений',
  );
  expect(enrichAgendaEvents([e], { userId: 1 }, agenda)[0]?.description).toBe(e.description);
  expect(enrichAgendaEvents([e], { userId: 1 }, agenda)[0]?.location).toBeNull();
  db.exec('DROP TABLE invitations');
  expect(() => enrichAgendaEvents([e], { userId: 1 }, agenda)).toThrow();
});
test('safe fallback names and Russian statuses', () => {
  const e = event();
  invite(e.id, 4, 'maybe');
  expect(enrichAgendaEvents([e], { userId: 1, language: 'ru' }, agenda)[0]?.displayMetadata?.invitationStatus).toBe(
    'Гость: ❔ возможно',
  );
});
test('recurring master roster is inherited by valid exceptions and accepted attendees', () => {
  const master = event({ recurrence_rule: 'FREQ=DAILY;COUNT=3' });
  invite(master.id, 2, 'accepted');
  participants.add(master.id, 2, 'accepted');
  const child = events.createException(master.id, {
    user_id: 1,
    title: 'Moved',
    start_at: '2099-06-02T11:00:00.000Z',
    original_start_at: '2099-06-02T10:00:00.000Z',
    timezone: 'UTC',
  });
  expect(visible(1)).toHaveLength(3);
  expect(visible(1).every((occ) => occ.event.displayMetadata?.invitationStatus?.includes('Alice: ✅ accepted'))).toBe(
    true,
  );
  expect(visible(2).find((occ) => occ.event.id === child.id)?.event.displayMetadata?.invitationStatus).toContain(
    'Your invitation: ✅ accepted',
  );
  invite(child.id, 2, 'maybe');
  expect(visible(1).find((occ) => occ.event.id === child.id)?.event.displayMetadata?.invitationStatus).toBe(
    'Alice: ❔ maybe',
  );
  expect(visible(1).find((occ) => occ.event.id === master.id)?.event.displayMetadata?.invitationStatus).toBe(
    'Alice: ✅ accepted',
  );
});
test('deleted/cancelled/hidden events and invalid recurring parents cannot supply private metadata', () => {
  const e = event();
  invite(e.id, 3);
  db.query('UPDATE events SET is_deleted = 1 WHERE id = ?').run(e.id);
  expect(visible(1)).toEqual([]);
  expect(enrichAgendaEvents([e], { userId: 1 }, agenda)[0]?.displayMetadata).toBeUndefined();
  const hidden = event({ user_id: 3 });
  expect(visible(1)).toEqual([]);
  expect(enrichAgendaEvents([hidden], { userId: 1 }, agenda)[0]?.displayMetadata).toBeUndefined();
  const master = event({ recurrence_rule: 'FREQ=DAILY;COUNT=2' });
  invite(master.id, 3);
  const child = events.createException(master.id, {
    user_id: 2,
    title: 'Invalid owner',
    start_at: start,
    original_start_at: start,
    timezone: 'UTC',
  });
  expect(enrichAgendaEvents([child], { userId: 2 }, agenda)[0]?.displayMetadata?.invitationStatus).toBe(
    'No invitations',
  );
  db.query('UPDATE events SET is_cancelled = 1 WHERE id = ?').run(master.id);
  expect(visible(1)).toEqual([]);
});
test('large duplicate occurrence batches remain correct', () => {
  const e = event();
  invite(e.id, 2);
  const rows = enrichAgendaEvents(
    Array.from({ length: 700 }, () => e),
    { userId: 1 },
    agenda,
  );
  expect(rows).toHaveLength(700);
  expect(rows.every((row) => row.displayMetadata?.invitationStatus === 'Alice: ⏳ pending')).toBe(true);
});

test('accepted participation without an invitation row does not invent an invitation', () => {
  const e = event();
  participants.add(e.id, 2, 'accepted');
  const label = visible(2)[0]?.event.displayMetadata?.invitationStatus;
  expect(label).toContain('Your participation: ✅ accepted');
  expect(label).not.toContain('Your invitation');
});

test('reprojection cannot reuse private owner metadata across viewers or missing dependencies', () => {
  const e = event();
  invite(e.id, 3);
  const owner = enrichAgendaEvents([e], { userId: 1 }, agenda);
  expect(owner[0]?.displayMetadata?.invitationStatus).toContain('Private Bob');
  expect(enrichAgendaEvents(owner, { userId: 2 }, agenda)[0]?.displayMetadata).toBeUndefined();
  expect(enrichAgendaEvents(owner, { userId: 1, groupId: -10 }, agenda)[0]?.displayMetadata).toBeUndefined();
  expect(enrichAgendaEvents(owner, { userId: 1 })[0]?.displayMetadata).toBeUndefined();
});
