/**
 * The seeded "who is invited to event #N" intent (basis.invite.status) run end to end:
 * real SQLite, the real matcher layer and executor, and the real get_invitation_status
 * handler. Only Telegram is faked. Access is the handler's — the intent must not put an
 * owner-only lookup in front of it, or an invitee is denied what the assistant would answer.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { createIntentMatcherLayer } from '../../src/bot/pipeline/intent-matcher-layer.ts';
import type { BotCommandContext } from '../../src/bot/types.ts';
import { migrations } from '../../src/database/migrations.ts';
import { ContactRepository } from '../../src/database/repositories/contact.repository.ts';
import { EventRepository } from '../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../src/database/repositories/event-reminder.repository.ts';
import { IntentRepository } from '../../src/database/repositories/intent.repository.ts';
import { InvitationRepository } from '../../src/database/repositories/invitation.repository.ts';
import { SharingSettingsRepository } from '../../src/database/repositories/sharing-settings.repository.ts';
import { UserRepository } from '../../src/database/repositories/user.repository.ts';
import { WorkflowSessionRepository } from '../../src/database/repositories/workflow-session.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';
import { _resetToolThrottleForTest, executeTool } from '../../src/services/ai/tool-executor.ts';
import type { AgentContext } from '../../src/services/ai/types.ts';
import { EventService } from '../../src/services/event/event-service.ts';
import { IntentExecutor } from '../../src/services/intent/intent-executor.ts';
import { IntentMatcher } from '../../src/services/intent/intent-matcher.ts';
import { seedIntents } from '../../src/services/intent/seed-catalog.ts';
import { WorkflowSchema } from '../../src/services/intent/workflow-schema.ts';
import { InvitationService } from '../../src/services/sharing/invitation-service.ts';

const OWNER = 5000000010;
const INVITEE = 5000000011;
const STRANGER = 5000000012;
const GROUP_CHAT = -5000000099;
const TITLE = 'Fixture roster meeting';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  runMigrations(db, migrations);
  _resetToolThrottleForTest();
});
afterEach(() => db.close());

interface Turn {
  as: number;
  group?: boolean;
}

function fixture() {
  const users = new UserRepository(db);
  for (const id of [OWNER, INVITEE, STRANGER]) users.create({ telegram_id: id, timezone: 'UTC', language: 'en' });
  const events = new EventRepository(db);
  const service = new EventService({ eventRepo: events });
  const invitations = new InvitationRepository(db);
  const event = service.createEvent({
    user_id: OWNER,
    title: TITLE,
    start_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    timezone: 'UTC',
  });
  const intents = new IntentRepository(db);
  const definition = seedIntents.find((x) => x.canonical_name === 'basis.invite.status')!;
  const intentId = intents.create({
    ...definition,
    workflow: WorkflowSchema.parse(definition.workflow),
    format: 'text',
  });
  intents.updateStatus(intentId, 'approved');
  const matcher = new IntentMatcher();
  matcher.load(intents.getApproved());

  const buildCtx = (turn: Turn) =>
    ({
      user: users.findByTelegramId(turn.as)!,
      chatId: turn.group ? GROUP_CHAT : turn.as,
      isGroup: turn.group === true,
      groupChatId: turn.group ? GROUP_CHAT : undefined,
      userRepo: users,
      contactRepo: new ContactRepository(db),
      eventService: service,
      eventReminderRepo: new EventReminderRepository(db),
      sharing: {
        invitationRepo: invitations,
        invitationService: new InvitationService(invitations, events, new SharingSettingsRepository(db)),
      },
      sender: { sendMessage: async () => ({ message_id: 1 }), editMessageText: async () => {} },
    }) as unknown as AgentContext;
  const calls: { name: string; ok: boolean; text: string }[] = [];
  const dispatchAs = (turn: Turn) => async (name: string, input: unknown) => {
    const result = await executeTool(buildCtx(turn), name, input);
    calls.push({ name, ok: result.success, text: result.success ? (result.output ?? '') : (result.error ?? '') });
    return result;
  };
  const send = mock(async (_text: string, _options?: unknown) => ({ message_id: 1 }));
  const sessions = new WorkflowSessionRepository(db);
  const layerAs = (turn: Turn) =>
    createIntentMatcherLayer(matcher, intents, new IntentExecutor(), dispatchAs(turn), sessions);

  const invite = (invitee: number) =>
    invitations.create({ event_id: event.id, inviter_id: OWNER, invitee_id: invitee });
  return {
    users,
    contacts: new ContactRepository(db),
    buildCtx,
    event,
    calls,
    send,
    invitations,
    service,
    invite,
    accept: (invitee: number) => {
      const inv = invite(invitee);
      invitations.updateStatus(inv.id, 'accepted', 'pending');
      return inv;
    },
    say: async (text: string, turn: Turn) => {
      calls.length = 0;
      send.mockClear();
      const chatId = turn.group ? GROUP_CHAT : turn.as;
      const ctx = { dbUser: users.findByTelegramId(turn.as)!, chatId, id: 1, send } as unknown as BotCommandContext;
      const extra = turn.group ? { groupContext: { isGroup: true, groupChatId: GROUP_CHAT } } : undefined;
      return layerAs(turn)(ctx, text, extra);
    },
    reply: () => String(send.mock.calls.at(-1)?.[0] ?? ''),
  };
}

test('the owner asking by #id gets the roster', async () => {
  const f = fixture();
  f.accept(INVITEE);
  const result = await f.say(`who is invited to event #${f.event.id}`, { as: OWNER });
  expect(result.handled).toBe(true);
  expect(f.reply()).toContain(TITLE);
  expect(f.reply()).toContain(String(INVITEE));
});

test('an accepted invitee asking by #id gets the roster, naming the organizer', async () => {
  const f = fixture();
  f.accept(INVITEE);
  const result = await f.say(`who is invited to event #${f.event.id}`, { as: INVITEE });
  expect(result.handled).toBe(true);
  expect(f.calls.map((c) => c.name)).toEqual(['get_invitation_status']);
  expect(f.reply()).toContain(TITLE);
  expect(f.reply()).toContain(String(OWNER));
});

// get_invitation_status admits every live invitation, answered or not; the intent adds no rule of its own.
test.each([
  'pending',
  'declined',
] as const)('an invitee whose invitation is %s asking by #id gets the roster', async (status) => {
  const f = fixture();
  const inv = f.invite(INVITEE);
  if (status !== 'pending') f.invitations.updateStatus(inv.id, status, 'pending');
  const result = await f.say(`who is invited to event #${f.event.id}`, { as: INVITEE });
  expect(result.handled).toBe(true);
  expect(f.calls.map((c) => c.name)).toEqual(['get_invitation_status']);
  expect(f.reply()).toContain(String(OWNER));
});

test('a stranger asking by #id is not answered by the intent', async () => {
  const f = fixture();
  f.accept(INVITEE);
  const result = await f.say(`who is invited to event #${f.event.id}`, { as: STRANGER });
  expect(result.handled).toBe(false);
  expect(f.send).not.toHaveBeenCalled();
  expect(f.calls.at(-1)).toMatchObject({ name: 'get_invitation_status', ok: false });
  expect(f.calls.at(-1)?.text).not.toContain(TITLE);
});

test.each(['cancelled', 'expired'] as const)('an invitee whose invitation is %s is not answered', async (status) => {
  const f = fixture();
  const inv = f.invite(INVITEE);
  f.invitations.updateStatus(inv.id, status, 'pending');
  const result = await f.say(`who is invited to event #${f.event.id}`, { as: INVITEE });
  expect(result.handled).toBe(false);
  expect(f.send).not.toHaveBeenCalled();
  expect(f.calls.at(-1)).toMatchObject({ name: 'get_invitation_status', ok: false });
});

test('a nonexistent #id is not answered', async () => {
  const f = fixture();
  const result = await f.say(`who is invited to event #${f.event.id + 1000}`, { as: OWNER });
  expect(result.handled).toBe(false);
  expect(f.send).not.toHaveBeenCalled();
});

test('a soft-deleted event is not answered, to its owner or its invitee', async () => {
  const f = fixture();
  f.accept(INVITEE);
  expect(f.service.deleteEvent(f.event.id, OWNER)).toBe(true);
  for (const as of [OWNER, INVITEE]) {
    const result = await f.say(`who is invited to event #${f.event.id}`, { as });
    expect(result.handled).toBe(false);
    expect(f.send).not.toHaveBeenCalled();
  }
});

test('an invitee naming the event by title searches only their own calendar', async () => {
  const f = fixture();
  f.accept(INVITEE);
  const result = await f.say(`who is invited to ${TITLE}`, { as: INVITEE });
  expect(result.handled).toBe(true);
  expect(f.calls.map((c) => c.name)).toEqual(['search_events']);
  expect(f.reply()).toContain("couldn't find that event");
});

test('the owner naming the event by title gets the roster', async () => {
  const f = fixture();
  f.accept(INVITEE);
  const result = await f.say(`who is invited to ${TITLE}`, { as: OWNER });
  expect(result.handled).toBe(true);
  expect(f.calls.map((c) => c.name)).toEqual(['search_events', 'get_event', 'get_invitation_status']);
  expect(f.reply()).toContain(String(INVITEE));
});

test('an invitee giving the bare event number gets the roster', async () => {
  const f = fixture();
  f.accept(INVITEE);
  const result = await f.say(`who is invited to ${f.event.id}`, { as: INVITEE });
  expect(result.handled).toBe(true);
  expect(f.calls.map((c) => c.name)).toEqual(['get_invitation_status']);
  expect(f.reply()).toContain(String(OWNER));
});

test('a title matching several events asks for the number and reads no roster', async () => {
  const f = fixture();
  f.accept(INVITEE);
  f.service.createEvent({ user_id: OWNER, title: TITLE, start_at: f.event.start_at, timezone: 'UTC' });
  const result = await f.say(`who is invited to ${TITLE}`, { as: OWNER });
  expect(result.handled).toBe(true);
  expect(f.calls.map((c) => c.name)).toEqual(['search_events']);
  expect(f.reply()).toContain('Several events match');
});

test('in a group chat the intent refuses before reading anything', async () => {
  const f = fixture();
  f.accept(INVITEE);
  for (const as of [OWNER, INVITEE]) {
    const result = await f.say(`who is invited to event #${f.event.id}`, { as, group: true });
    expect(result.handled).toBe(true);
    expect(f.calls).toHaveLength(0);
    expect(f.reply()).toContain('private chat');
  }
});

// GH-581: an already complete roster must be useful without a second AI reply.
test('a complete roster recognizes self, localizes RSVP and ends the pipeline', async () => {
  const f = fixture();
  f.users.update(INVITEE, { language: 'ru', first_name: 'Fixture viewer' });
  f.users.update(OWNER, { first_name: 'Fixture organizer' });
  f.accept(INVITEE);
  const result = await f.say(`кто приглашён на событие #${f.event.id}`, { as: INVITEE });
  expect(result).toEqual({ handled: true });
  expect(f.reply()).toContain('Fixture organizer');
  expect(f.reply()).toContain('вы');
  expect(f.reply()).toContain('принято');
  expect(f.reply()).not.toContain('accepted');
  expect(f.reply()).not.toContain(String(INVITEE));
  expect(f.send.mock.calls).toHaveLength(1);
});

test('roster names come only from the viewer contacts, never the organizer aliases', async () => {
  const f = fixture();
  f.users.update(STRANGER, { first_name: 'Public fixture profile' });
  f.contacts.upsert(OWNER, 'Private organizer alias', undefined, STRANGER);
  f.contacts.upsert(INVITEE, 'Viewer alias', undefined, STRANGER);
  f.accept(INVITEE);
  f.accept(STRANGER);
  await f.say(`who is invited to event #${f.event.id}`, { as: INVITEE });
  expect(f.reply()).toContain('Viewer alias');
  expect(f.reply()).not.toContain('Private organizer alias');
});

test('a group roster does not publish the requester private contact alias', async () => {
  const f = fixture();
  f.users.update(INVITEE, { first_name: 'Public fixture guest' });
  f.contacts.upsert(OWNER, 'Private viewer nickname', undefined, INVITEE);
  f.accept(INVITEE);
  const result = await executeTool(f.buildCtx({ as: OWNER, group: true }), 'get_invitation_status', {
    event_id: f.event.id,
  });
  expect(result.success).toBe(true);
  expect(result.output).toContain('Public fixture guest');
  expect(result.output).not.toContain('Private viewer nickname');
});

test('roster escapes display names and keeps unknown numeric identity', async () => {
  const f = fixture();
  f.contacts.upsert(OWNER, '<b>Fixture</b>\n@all', undefined, INVITEE);
  f.accept(INVITEE);
  f.accept(STRANGER);
  await f.say(`who is invited to event #${f.event.id}`, { as: OWNER });
  expect(f.reply()).toContain('&lt;b&gt;Fixture&lt;/b&gt;');
  expect(f.reply()).not.toContain('<b>Fixture</b>');
  expect(f.reply()).toContain(String(STRANGER));
});

test('human names do not remove verified numeric identity from the AI-only evidence', async () => {
  const f = fixture();
  f.users.update(INVITEE, { first_name: 'Fixture guest' });
  f.accept(INVITEE);
  const result = await executeTool(f.buildCtx({ as: OWNER }), 'get_invitation_status', { event_id: f.event.id });
  expect(result.agentHint).toContain('Verified roster identity:');
  expect(result.agentHint).toContain(`"invitee_ids":[${INVITEE}]`);
  expect(result.agentHint).toContain(`"organizer_id":${OWNER}`);
  await f.say(`who is invited to event #${f.event.id}`, { as: OWNER });
  expect(f.reply()).not.toContain('Verified roster identity:');
});

test('denied roster exposes neither user labels nor agent-only identity evidence', async () => {
  const f = fixture();
  f.users.update(OWNER, { first_name: 'Restricted fixture organizer' });
  f.accept(INVITEE);
  const result = await executeTool(f.buildCtx({ as: STRANGER }), 'get_invitation_status', { event_id: f.event.id });
  expect(result.success).toBe(false);
  expect(result.output).toBeUndefined();
  expect(result.agentHint).toBeUndefined();
  expect(result.completeResponse).not.toBe(true);
});

test('missing group RSVP registry cannot claim a complete roster', async () => {
  const f = fixture();
  f.accept(INVITEE);
  f.invite(GROUP_CHAT);
  const result = await f.say(`who is invited to event #${f.event.id}`, { as: OWNER });
  expect(result.handled).toBe(true);
  expect('needsSupplement' in result && result.needsSupplement).toBe(true);
  expect(f.reply()).toContain('participant registry unavailable');
});

test('empty personal roster is also a complete deterministic answer', async () => {
  const f = fixture();
  const result = await f.say(`who is invited to event #${f.event.id}`, { as: OWNER });
  expect(result).toEqual({ handled: true });
  expect(f.reply()).toContain('No invitations');
});

test('long emoji names remain valid Unicode after display truncation', async () => {
  const f = fixture();
  f.contacts.upsert(OWNER, `${'x'.repeat(119)}😀trailing`, undefined, INVITEE);
  f.accept(INVITEE);
  await f.say(`who is invited to event #${f.event.id}`, { as: OWNER });
  expect(f.reply()).toContain(`${'x'.repeat(119)}😀`);
  expect(f.reply()).not.toContain('trailing');
  expect(f.reply()).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
});

test('roster resolution uses bounded batch reads rather than one contact scan per invitee', async () => {
  const f = fixture();
  f.users.update(INVITEE, { first_name: 'Batch profile one' });
  f.users.update(STRANGER, { first_name: 'Batch profile two' });
  f.accept(INVITEE);
  f.accept(STRANGER);
  const ctx = f.buildCtx({ as: OWNER });
  const profiles = spyOn(f.users, 'findByTelegramId');
  const contacts = spyOn(ContactRepository.prototype, 'findByTelegramId');
  try {
    const result = await executeTool(ctx, 'get_invitation_status', { event_id: f.event.id });
    expect(result.output).toContain('Batch profile one');
    expect(result.output).toContain('Batch profile two');
    expect(profiles.mock.calls.length + contacts.mock.calls.length).toBe(0);
  } finally {
    profiles.mockRestore();
    contacts.mockRestore();
  }
});
