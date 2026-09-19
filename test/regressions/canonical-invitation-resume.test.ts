import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
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

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  runMigrations(db, migrations);
  _resetToolThrottleForTest();
});
afterEach(() => db.close());
function fixture() {
  const users = new UserRepository(db);
  users.create({ telegram_id: 10, timezone: 'UTC', language: 'en' });
  users.create({ telegram_id: 11, timezone: 'UTC', language: 'en' });
  users.create({ telegram_id: 5000000001, timezone: 'UTC', language: 'en', username: 'fixture_person' });
  const events = new EventRepository(db),
    service = new EventService({ eventRepo: events }),
    invitations = new InvitationRepository(db);
  const event = service.createEvent({
    user_id: 10,
    title: 'Fixture appointment',
    start_at: '2035-01-01T12:00:00Z',
    timezone: 'UTC',
  });
  const definition = seedIntents.find((x) => x.canonical_name === 'basis.invite.send')!;
  const intents = new IntentRepository(db);
  const intentId = intents.create({
    ...definition,
    workflow: WorkflowSchema.parse(definition.workflow),
    format: 'text',
  });
  intents.updateStatus(intentId, 'approved');
  const matcher = new IntentMatcher();
  matcher.load(intents.getApproved());
  const sessions = new WorkflowSessionRepository(db);
  const delivery = mock(async (_id: number) => ({ message_id: 1 }));
  const sent = mock(async (_text: string, _options?: unknown) => ({ message_id: 1 }));
  let current = '',
    actor = 10,
    chat = 10;
  const dispatch = (name: string, input: unknown, origin?: { text: string; actorId: number; chatId: number }) => {
    const user = users.findByTelegramId(actor)!;
    const text = origin?.actorId === actor && origin.chatId === chat ? origin.text : current;
    const context = {
      user,
      chatId: chat,
      messageText: text,
      isGroup: false,
      userRepo: users,
      contactRepo: new ContactRepository(db),
      eventService: service,
      eventReminderRepo: new EventReminderRepository(db),
      sharing: {
        invitationRepo: invitations,
        invitationService: new InvitationService(invitations, events, new SharingSettingsRepository(db)),
      },
      sender: {
        sendMessage: async () => ({ message_id: 1 }),
        editMessageText: async () => {},
        sendInvitation: delivery,
      },
    } as unknown as AgentContext;
    return executeTool(context, name, input);
  };
  const layer = createIntentMatcherLayer(matcher, intents, new IntentExecutor(), dispatch, sessions);
  return {
    event,
    invitations,
    delivery,
    sessions,
    say: async (text: string, user = 10, chatId = user) => {
      current = text;
      actor = user;
      chat = chatId;
      return layer(
        { dbUser: users.findByTelegramId(user)!, chatId, id: 1, send: sent } as unknown as BotCommandContext,
        text,
      );
    },
  };
}
test.each([
  '@fixture_person',
  '5000000001',
])('a confirmed invitation retains the original explicit recipient %s', async (recipient) => {
  const f = fixture();
  await f.say(`invite ${recipient} to event #${f.event.id}`);
  expect(f.invitations.getByEvent(f.event.id)).toHaveLength(0);
  expect(f.delivery).not.toHaveBeenCalled();
  await f.say('Yes');
  expect(f.invitations.getByEvent(f.event.id)).toHaveLength(1);
  expect(f.delivery).toHaveBeenCalledTimes(1);
  expect(f.delivery.mock.calls[0]?.[0]).toBe(5000000001);
  await f.say('Yes');
  expect(f.delivery).toHaveBeenCalledTimes(1);
});
test('wrong actor or chat cannot consume invitation confirmation; cancellation creates no invitation', async () => {
  const f = fixture();
  await f.say(`invite @fixture_person to event #${f.event.id}`);
  await f.say('Yes', 11, 10);
  await f.say('Yes', 10, 999);
  expect(f.delivery).not.toHaveBeenCalled();
  expect(f.sessions.get(10, 10)).not.toBeNull();
  await f.say('Cancel');
  expect(f.sessions.get(10, 10)).toBeNull();
  expect(f.invitations.getByEvent(f.event.id)).toHaveLength(0);
});
