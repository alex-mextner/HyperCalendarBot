// Real command output against migrated SQLite; the sender never reaches Telegram.
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Bot, MessageContext } from 'gramio';
import { handleToday } from '../../../src/bot/commands/today.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { AgendaRepository } from '../../../src/database/repositories/agenda.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { png } from '../../fixtures/png.ts';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, migrations);
});
afterEach(() => db.close());
test('today obtains outgoing invitation metadata from storage and preserves a maps-only description', async () => {
  const users = new UserRepository(db);
  const owner = users.create({ telegram_id: 101, first_name: 'Owner', timezone: 'UTC' });
  users.create({ telegram_id: 202, first_name: 'Alice' });
  const service = new EventService({ eventRepo: new EventRepository(db), agendaRepository: new AgendaRepository(db) });
  const event = service.createEvent({
    user_id: 101,
    title: 'Meeting',
    start_at: new Date().toISOString(),
    timezone: 'UTC',
    description: 'https://maps.google.com/?q=Actual+notes @nobody',
  });
  new InvitationRepository(db).create({ event_id: event.id, inviter_id: 101, invitee_id: 202 });
  const sent: string[] = [];
  const message = new MessageContext({
    bot: new Bot('123:test'),
    payload: { message_id: 1, date: 0, chat: { id: 101, type: 'private' } },
  });
  const ctx = Object.assign(message, {
    dbUser: owner,
    userTimezone: 'UTC',
    lang: 'en' as const,
    scene: { enter: async () => {} },
    send: async (text: string) => {
      sent.push(text);
      return message;
    },
  });
  await handleToday(ctx, service);
  expect(sent.join('\n')).toContain('Alice: ⏳');
  expect(sent.join('\n')).toContain('https://maps.google.com/?q=Actual+notes @nobody');
  expect(sent.join('\n')).not.toContain('📍');
});

import { handleMonth } from '../../../src/bot/commands/month.ts';
import { handleSearch } from '../../../src/bot/commands/search.ts';
// Both text and render payloads come from command execution, with no Bot API or queue.
import { handleTomorrow } from '../../../src/bot/commands/tomorrow.ts';
import { handleWeek } from '../../../src/bot/commands/week.ts';
import { GroupChatRepository } from '../../../src/database/repositories/group-chat.repository.ts';
import { ParticipantRepository } from '../../../src/database/repositories/participant.repository.ts';
import type { ImageRenderJob } from '../../../src/worker/image-render.queue.ts';

for (const command of ['today', 'tomorrow', 'week', 'search', 'month'] as const) {
  test(`${command} uses stored invitations in real text/render output with a fake sender`, async () => {
    const users = new UserRepository(db);
    const owner = users.create({ telegram_id: 101, first_name: 'Owner', timezone: 'UTC' });
    users.create({ telegram_id: 202, first_name: 'Alice <friend>' });
    const service = new EventService({
      eventRepo: new EventRepository(db),
      agendaRepository: new AgendaRepository(db),
    });
    const date = new Date();
    if (command === 'tomorrow') date.setUTCDate(date.getUTCDate() + 1);
    const event = service.createEvent({
      user_id: 101,
      title: 'Meeting',
      start_at: date.toISOString(),
      timezone: 'UTC',
      location: 'Actual venue',
      description: 'Text only notes',
    });
    new InvitationRepository(db).create({ event_id: event.id, inviter_id: 101, invitee_id: 202 });
    const sent: string[] = [];
    const jobs: ImageRenderJob[] = [];
    const photos: unknown[] = [];
    const documents: unknown[] = [];
    const bot = new Bot('123:test');
    bot.api.pinChatMessage = async () => true;
    bot.api.sendDocument = async (params) => {
      documents.push(params);
      return { message_id: 2, date: 0, chat: { id: 101, type: 'private' } };
    };
    const message = new MessageContext({
      bot,
      payload: { message_id: 1, date: 0, chat: { id: 101, type: 'private' } },
    });
    const ctx = Object.assign(message, {
      dbUser: owner,
      userTimezone: 'UTC',
      lang: 'en' as const,
      args: 'Meeting',
      scene: { enter: async () => {} },
      send: async (text: string) => {
        sent.push(text);
        return message;
      },
      sendPhoto: async (photo: Parameters<typeof message.sendPhoto>[0]) => {
        photos.push(photo);
        return message;
      },
    });
    const renderer = {
      renderDirect: async (job: ImageRenderJob) => {
        jobs.push(job);
        return png(2160, 9000);
      },
    };
    if (command === 'today') await handleToday(ctx, service, undefined, renderer);
    if (command === 'tomorrow') await handleTomorrow(ctx, service, undefined, renderer);
    if (command === 'week') await handleWeek(ctx, service, undefined, renderer);
    if (command === 'search') await handleSearch(ctx, service);
    if (command === 'month') await handleMonth(ctx, service, undefined, renderer);
    if (command !== 'month') {
      expect(sent.join('\n')).toContain('Alice &lt;friend&gt;: ⏳ pending');
      expect(sent.join('\n')).toContain('Text only notes');
      expect(sent.join('\n')).toContain('Actual venue');
    }
    if (command !== 'search') {
      expect(photos).toHaveLength(0);
      expect(documents).toHaveLength(1);
      expect(JSON.stringify(documents)).toContain('PNG');
      expect(JSON.stringify(jobs)).toContain('Alice <friend>: ⏳ pending');
      expect(JSON.stringify(jobs)).toContain('Actual venue');
      expect(JSON.stringify(jobs)).not.toContain('Text only notes');
    }
  });
}

test('real today output hides other invitees from accepted attendees and excludes pending-only events', async () => {
  const users = new UserRepository(db);
  users.create({ telegram_id: 101, first_name: 'Organizer' });
  const attendee = users.create({ telegram_id: 202, first_name: 'Alice', timezone: 'UTC' });
  users.create({ telegram_id: 303, first_name: 'Private Bob' });
  const repo = new EventRepository(db);
  const service = new EventService({ eventRepo: repo, agendaRepository: new AgendaRepository(db) });
  const event = service.createEvent({
    user_id: 101,
    title: 'Accepted event',
    start_at: new Date().toISOString(),
    timezone: 'UTC',
  });
  new ParticipantRepository(db).add(event.id, 202, 'accepted');
  const invitationRepo = new InvitationRepository(db);
  const inv = invitationRepo.create({ event_id: event.id, inviter_id: 101, invitee_id: 202 });
  invitationRepo.updateStatus(inv.id, 'accepted', 'pending');
  invitationRepo.create({ event_id: event.id, inviter_id: 101, invitee_id: 303 });
  const hidden = service.createEvent({
    user_id: 101,
    title: 'Pending only secret',
    start_at: new Date().toISOString(),
    timezone: 'UTC',
  });
  invitationRepo.create({ event_id: hidden.id, inviter_id: 101, invitee_id: 202 });
  const sent: string[] = [];
  const message = new MessageContext({
    bot: new Bot('123:test'),
    payload: { message_id: 1, date: 0, chat: { id: 202, type: 'private' } },
  });
  const ctx = Object.assign(message, {
    dbUser: attendee,
    userTimezone: 'UTC',
    lang: 'en' as const,
    scene: { enter: async () => {} },
    send: async (text: string) => {
      sent.push(text);
      return message;
    },
  });
  await handleToday(ctx, service);
  expect(sent.join('\n')).toContain('Your invitation: ✅ accepted; Organizer: Organizer');
  expect(sent.join('\n')).not.toMatch(/Private Bob|Pending only secret/);
});

test('real group today emits participant counts without private invitations', async () => {
  const users = new UserRepository(db);
  const owner = users.create({ telegram_id: 101, timezone: 'UTC' });
  users.create({ telegram_id: 202, first_name: 'Private Alice' });
  const groups = new GroupChatRepository(db);
  groups.upsertGroup({ chat_id: -10, added_by: 101 });
  groups.setTimezone(-10, 'UTC');
  const service = new EventService({ eventRepo: new EventRepository(db), agendaRepository: new AgendaRepository(db) });
  const e = service.createEvent({
    user_id: 101,
    title: 'Group meeting',
    owner_type: 'group',
    group_id: -10,
    start_at: new Date().toISOString(),
    timezone: 'UTC',
  });
  new ParticipantRepository(db).add(e.id, 202, 'accepted');
  new InvitationRepository(db).create({ event_id: e.id, inviter_id: 101, invitee_id: 202 });
  // If group enrichment attempts a private invitation query, this command cannot complete.
  db.exec('DROP TABLE invitations');
  const sent: string[] = [];
  const message = new MessageContext({
    bot: new Bot('123:test'),
    payload: { message_id: 1, date: 0, chat: { id: -10, type: 'group', title: 'Group' } },
  });
  const ctx = Object.assign(message, {
    dbUser: owner,
    userTimezone: 'UTC',
    lang: 'en' as const,
    scene: { enter: async () => {} },
    send: async (text: string) => {
      sent.push(text);
      return message;
    },
  });
  await handleToday(ctx, service, undefined, undefined, groups);
  expect(sent.join('\n')).toContain('Participants: 1 (✅ accepted 1)');
  expect(sent.join('\n')).not.toContain('Private Alice');
});
