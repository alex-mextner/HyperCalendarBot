import { afterEach, expect, mock, test } from 'bun:test';
import { Scene } from '@gramio/scenes';
import { handleAdd } from '../../../src/bot/commands/add.ts';
import type { DialogueV3AddDeps } from '../../../src/bot/commands/add-v3.ts';
import type { AddEventParams } from '../../../src/bot/scenes/types.ts';
import type { BotCommandContext } from '../../../src/bot/types.ts';
import { DatabaseService } from '../../../src/database/index.ts';
import { createContactPeopleResolver, createManualPlaceResolver } from '../../../src/services/dialogue/resolvers.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { InvitationService } from '../../../src/services/sharing/invitation-service.ts';

const databases: DatabaseService[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.db.close();
});
function makeInput(args: string, groupTimezone?: string) {
  const db = new DatabaseService(':memory:');
  databases.push(db);
  const user = db.users.create({ telegram_id: 42, language: 'ru', timezone: 'Europe/Belgrade' });
  const chat = groupTimezone === undefined ? { type: 'private', id: 42 } : { type: 'group', id: -100 };
  if (groupTimezone !== undefined) {
    db.groupChats.upsertGroup({ chat_id: -100, added_by: 42 });
    if (groupTimezone) db.groupChats.setTimezone(-100, groupTimezone);
  }
  const send = mock(async (text: string, _options?: { reply_markup?: unknown }) => text);
  const enter = mock(async (scene: Scene, params?: AddEventParams) => ({ scene, params }));
  const context = {
    chat,
    chatId: 42,
    dbUser: user,
    args,
    lang: 'ru',
    send,
    scene: { enter },
  } as unknown as BotCommandContext;
  return { context, send, enter, db, scene: new Scene('add_event') };
}

function makeDialogueV3Deps(db: DatabaseService, now: Date): DialogueV3AddDeps {
  return {
    enabled: true,
    eventService: new EventService({ eventRepo: db.events }),
    dialogueSessions: db.dialogueSessions,
    invitationService: new InvitationService(db.invitations, db.events, db.sharingSettings, db.participants),
    invitationDelivery: {
      sender: {
        sendMessage: async () => ({ message_id: 1 }),
        editMessageText: async () => {},
        sendInvitation: async () => ({ message_id: 1 }),
      },
      invitationRepo: db.invitations,
      userRepo: db.users,
    },
    peopleResolver: createContactPeopleResolver(db.contacts),
    placeResolver: createManualPlaceResolver(),
    now: () => now,
  };
}

test('group with no args enters a group-scoped draft', async () => {
  const r = makeInput('', 'Europe/Moscow');
  await handleAdd(r.context, r.scene, r.db.groupChats);
  expect(r.enter.mock.calls[0]?.[1]).toMatchObject({ groupId: -100, timezone: 'Europe/Moscow' });
});
test('group without a timezone explains settings and does not enter', async () => {
  const r = makeInput('Встреча завтра', '');
  await handleAdd(r.context, r.scene, r.db.groupChats);
  expect(r.enter).not.toHaveBeenCalled();
  expect(r.send.mock.calls[0]?.[0]).toContain('/settings');
});
test('group quick-add retains group owner and waits for the missing time', async () => {
  const r = makeInput('Встреча завтра', 'Europe/Moscow');
  await handleAdd(r.context, r.scene, r.db.groupChats);
  const params = r.enter.mock.calls[0]?.[1];
  expect(params).toMatchObject({ title: 'Встреча', groupId: -100, timezone: 'Europe/Moscow' });
  expect(params?.pendingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(params?.startAt).toBeUndefined();
});
test('group quick-add converts the group timezone, not the author timezone', async () => {
  const r = makeInput('Митинг 2027-01-15 19:00', 'Asia/Tokyo');
  await handleAdd(r.context, r.scene, r.db.groupChats);
  expect(r.enter.mock.calls[0]?.[1]).toMatchObject({ timezone: 'Asia/Tokyo', startAt: '2027-01-15T10:00:00.000Z' });
});

test('private quick-add has no group fields and never invents midnight', async () => {
  const r = makeInput('Task завтра');
  await handleAdd(r.context, r.scene);
  expect(r.enter.mock.calls[0]?.[1]?.groupId).toBeUndefined();
  expect(r.enter.mock.calls[0]?.[1]?.startAt).toBeUndefined();
  expect(r.enter.mock.calls[0]?.[1]?.title).toBe('Task');
});
test('private chat without args starts a timezone-aware draft', async () => {
  const r = makeInput('');
  await handleAdd(r.context, r.scene);
  expect(r.enter.mock.calls[0]?.[1]).toEqual({ timezone: 'Europe/Belgrade' });
});
test.each([
  'Team standup',
  'Разбор ошибок',
  '  Важное   дело  ',
])('title without a recognized date is preserved: %s', async (title) => {
  const r = makeInput(title);
  await handleAdd(r.context, r.scene);
  expect(r.enter.mock.calls[0]?.[1]?.title).toBe(title.trim());
});
test('long natural date suffix does not become part of the title', async () => {
  const r = makeInput('Встреча 25 сентября 2027 в 7 вечера');
  await handleAdd(r.context, r.scene);
  expect(r.enter.mock.calls[0]?.[1]).toMatchObject({ title: 'Встреча', startAt: '2027-09-25T17:00:00.000Z' });
});

// ── GH-652: flag-gated full-field fast path (dialogueV3) ──

test('flag off (deps omitted) is byte-identical to the pre-GH-652 legacy path', async () => {
  const r = makeInput('Meeting tomorrow at 14:00 with Lena at the office');
  await handleAdd(r.context, r.scene);
  expect(r.enter).toHaveBeenCalledTimes(1);
  // No dialogueV3 deps: people/place clauses are opaque to the legacy suffix scanner and stay in the title.
  expect(r.enter.mock.calls[0]?.[1]?.title).toBe('Meeting tomorrow at 14:00 with Lena at the office');
});

test('a fully specified command creates the event immediately, zero scene.enter call', async () => {
  const r = makeInput('Meeting tomorrow at 14:00 with Lena at the office');
  r.db.contacts.add(42, 'Lena', undefined, 501);
  const deps = makeDialogueV3Deps(r.db, new Date('2026-09-29T08:00:00Z'));
  await handleAdd(r.context, r.scene, undefined, { dialogueV3: deps });

  expect(r.enter).not.toHaveBeenCalled();
  const events = r.db.events.getVisibleInRange(42, '2020-01-01T00:00:00Z', '2030-01-01T00:00:00Z');
  expect(events).toHaveLength(1);
  expect(events[0]?.title).toBe('Meeting');
  expect(events[0]?.location).toBe('the office');
  // A real Invitation record, not a raw pending participant row (blocker: participantRepo.add
  // is not an invitation).
  const invitations = r.db.invitations.getByEvent(events[0]!.id);
  expect(invitations).toHaveLength(1);
  expect(invitations[0]?.invitee_id).toBe(501);

  // Sends a normal formatted card with the standard event-actions keyboard, no raw JSON.
  expect(r.send.mock.calls[0]?.[0]).toContain('Meeting');
  expect(r.send.mock.calls[0]?.[1]?.reply_markup).toBeDefined();
});

test('an incomplete command (no time, no people/place at stake) still falls through to the legacy wizard, seeded from the better parser', async () => {
  const r = makeInput('Meeting tomorrow');
  const deps = makeDialogueV3Deps(r.db, new Date('2026-09-29T08:00:00Z'));
  await handleAdd(r.context, r.scene, undefined, { dialogueV3: deps });

  expect(r.enter).toHaveBeenCalledTimes(1);
  const params = r.enter.mock.calls[0]?.[1];
  expect(params?.title).toBe('Meeting');
  const events = r.db.events.getVisibleInRange(42, '2020-01-01T00:00:00Z', '2030-01-01T00:00:00Z');
  expect(events).toHaveLength(0);
});

test('all-day is created with all_day set and a date-only exclusive end, never a fake 00:00-24:00 timed event', async () => {
  const r = makeInput('Отпуск завтра весь день');
  const deps = makeDialogueV3Deps(r.db, new Date('2026-09-29T08:00:00Z'));
  await handleAdd(r.context, r.scene, undefined, { dialogueV3: deps });

  expect(r.enter).not.toHaveBeenCalled();
  const events = r.db.events.getVisibleInRange(42, '2020-01-01T00:00:00Z', '2030-01-01T00:00:00Z');
  expect(events).toHaveLength(1);
  expect(events[0]?.all_day).toBe(1);
});

test('a single fuzzy person match never falls back to the legacy wizard (blocker: fallback must not drop resolved/pending people) — it persists a v3 draft asking for confirmation instead', async () => {
  const r = makeInput('Meeting tomorrow at 14:00 with Kristin');
  r.db.contacts.add(42, 'Kristina', undefined, 501);
  const deps = makeDialogueV3Deps(r.db, new Date('2026-09-29T08:00:00Z'));
  await handleAdd(r.context, r.scene, undefined, { dialogueV3: deps });

  const events = r.db.events.getVisibleInRange(42, '2020-01-01T00:00:00Z', '2030-01-01T00:00:00Z');
  expect(events).toHaveLength(0);
  expect(r.enter).not.toHaveBeenCalled();
  const session = r.db.dialogueSessions.get({ chatId: 42, userId: 42, topicId: 0 });
  expect(session?.status).toBe('collecting');
  expect(session?.pendingFuzzyPeople[0]?.rawName).toBe('Kristin');
  expect(r.send.mock.calls[0]?.[0]).toContain('Kristina');
});

test('an exact-matched person with no other blocker executes immediately, never discarded and never re-asked to re-add', async () => {
  const r = makeInput('Meeting tomorrow at 14:00 with Lena');
  r.db.contacts.add(42, 'Lena', undefined, 501);
  const deps = makeDialogueV3Deps(r.db, new Date('2026-09-29T08:00:00Z'));
  await handleAdd(r.context, r.scene, undefined, { dialogueV3: deps });

  expect(r.enter).not.toHaveBeenCalled();
  const events = r.db.events.getVisibleInRange(42, '2020-01-01T00:00:00Z', '2030-01-01T00:00:00Z');
  expect(events).toHaveLength(1);
  expect(r.db.invitations.getByEvent(events[0]!.id)[0]?.invitee_id).toBe(501);
});

test('an exact-matched person alongside a later fuzzy blocker is never silently dropped on fallback — it persists a v3 draft carrying Lena forward', async () => {
  const r = makeInput('Meeting tomorrow at 14:00 with Lena and Kristin');
  r.db.contacts.add(42, 'Lena', undefined, 501);
  r.db.contacts.add(42, 'Kristina', undefined, 502);
  const deps = makeDialogueV3Deps(r.db, new Date('2026-09-29T08:00:00Z'));
  await handleAdd(r.context, r.scene, undefined, { dialogueV3: deps });

  expect(r.db.events.getVisibleInRange(42, '2020-01-01T00:00:00Z', '2030-01-01T00:00:00Z')).toHaveLength(0);
  // Never falls to the legacy wizard, which has no field to carry Lena forward.
  expect(r.enter).not.toHaveBeenCalled();
  const session = r.db.dialogueSessions.get({ chatId: 42, userId: 42, topicId: 0 });
  expect(session?.draft.people.map((p) => p.displayName)).toEqual(['Lena']);
  expect(session?.pendingFuzzyPeople[0]?.rawName).toBe('Kristin');
});

test('a negated command never creates an event and never enters the wizard', async () => {
  const r = makeInput('не создавай встречу завтра в 14:00');
  const deps = makeDialogueV3Deps(r.db, new Date('2026-09-29T08:00:00Z'));
  await handleAdd(r.context, r.scene, undefined, { dialogueV3: deps });

  expect(r.enter).not.toHaveBeenCalled();
  expect(r.db.events.getVisibleInRange(42, '2020-01-01T00:00:00Z', '2030-01-01T00:00:00Z')).toHaveLength(0);
});

test('a negated command with NO time yet (incomplete, no people/place obligation) still never falls through to the legacy wizard — regression: the negation check only covered the fully-specified-command path', async () => {
  const r = makeInput('не создавай встречу завтра');
  const deps = makeDialogueV3Deps(r.db, new Date('2026-09-29T08:00:00Z'));
  await handleAdd(r.context, r.scene, undefined, { dialogueV3: deps });

  expect(r.enter).not.toHaveBeenCalled();
  expect(r.db.events.getVisibleInRange(42, '2020-01-01T00:00:00Z', '2030-01-01T00:00:00Z')).toHaveLength(0);
  expect(r.db.dialogueSessions.get({ chatId: 42, userId: 42, topicId: 0 })).toBeNull();
});

test('an explicit unknown name blocks the fast path and persists a v3 draft rather than falling back', async () => {
  const r = makeInput('Meeting tomorrow at 14:00 with Zorblax');
  const deps = makeDialogueV3Deps(r.db, new Date('2026-09-29T08:00:00Z'));
  await handleAdd(r.context, r.scene, undefined, { dialogueV3: deps });

  expect(r.enter).not.toHaveBeenCalled();
  expect(r.db.events.getVisibleInRange(42, '2020-01-01T00:00:00Z', '2030-01-01T00:00:00Z')).toHaveLength(0);
  const session = r.db.dialogueSessions.get({ chatId: 42, userId: 42, topicId: 0 });
  expect(session?.pendingFuzzyPeople).toEqual([{ rawName: 'Zorblax', candidates: [] }]);
});
