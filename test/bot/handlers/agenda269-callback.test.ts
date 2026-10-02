// Registered callbacks use real SQLite selection and fake Telegram/render transports.
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, setSystemTime, test } from 'bun:test';
import { Scene } from '@gramio/scenes';
import { Bot, CallbackQueryContext } from 'gramio';
import { createCallbackHandler } from '../../../src/bot/handlers/callback.handler.ts';
import { CB } from '../../../src/config/constants.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { AgendaRepository } from '../../../src/database/repositories/agenda.repository.ts';
import { EventRepository } from '../../../src/database/repositories/event.repository.ts';
import { GroupChatRepository } from '../../../src/database/repositories/group-chat.repository.ts';
import { HolidayRepository } from '../../../src/database/repositories/holiday.repository.ts';
import { NotificationPreferencesRepository } from '../../../src/database/repositories/notification-preferences.repository.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { EventService } from '../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../src/services/holiday/holiday-service.ts';
import { NotificationPreferencesService } from '../../../src/services/notification/preferences.ts';
import type { ImageRenderJob } from '../../../src/worker/image-render.queue.ts';
import { png } from '../../fixtures/png.ts';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, migrations);
});
afterEach(() => {
  db.close();
  setSystemTime();
});
function setup(data: string, chatId = -10, chatType: 'private' | 'supergroup' = 'supergroup', image = png()) {
  const users = new UserRepository(db);
  const user = users.create({ telegram_id: 1, timezone: 'America/Los_Angeles', language: 'en' });
  const groups = new GroupChatRepository(db);
  groups.upsertGroup({ chat_id: -10, added_by: 1 });
  groups.setTimezone(-10, 'Asia/Tokyo');
  const service = new EventService({ eventRepo: new EventRepository(db), agendaRepository: new AgendaRepository(db) });
  service.createEvent({
    user_id: 1,
    title: 'PRIVATE CANARY',
    location: 'SECRET VENUE',
    start_at: '2099-06-01T12:00:00Z',
    timezone: 'UTC',
  });
  service.createEvent({
    user_id: 1,
    owner_type: 'group',
    group_id: -10,
    title: 'GROUP MEETING',
    location: 'GROUP VENUE',
    start_at: '2099-05-31T16:00:00Z',
    timezone: 'Asia/Tokyo',
  });
  const jobs: ImageRenderJob[] = [];
  const bot = new Bot('123:test');
  const message = { message_id: 10, date: 0, chat: { id: chatId, type: chatType } };
  bot.api.answerCallbackQuery = async () => true;
  bot.api.sendPhoto = async () => message;
  bot.api.pinChatMessage = async () => true;
  bot.api.sendMessage = async () => message;
  const ctx = Object.assign(
    new CallbackQueryContext({
      bot,
      update: { update_id: 1 },
      updateId: 1,
      payload: {
        id: 'callback',
        chat_instance: 'test',
        from: { id: 1, is_bot: false, first_name: 'Owner' },
        data,
        message,
      },
    }),
    { dbUser: user, userTimezone: user.timezone, lang: 'en' as const, scene: { enter: async () => {} } },
  );
  const handler = createCallbackHandler(
    service,
    new Scene('unused'),
    new HolidayService(new HolidayRepository(db)),
    new NotificationPreferencesService(new NotificationPreferencesRepository(db)),
    {
      invitationService: new InvitationService(
        new InvitationRepository(db),
        new EventRepository(db),
        new SharingSettingsRepository(db),
        new ParticipantRepository(db),
      ),
      eventRepo: new EventRepository(db),
      groupRepo: groups,
      renderService: {
        renderDirect: async (job) => {
          jobs.push(job);
          return image;
        },
      },
    },
  );
  return { handler, ctx, jobs, groups, service, bot, user };
}
for (const prefix of [CB.IMG_DAILY, CB.IMG_WEEKLY]) {
  test(`${prefix} selects group calendar and timezone before enrichment`, async () => {
    const { handler, ctx, jobs } = setup(`${prefix}:2099-06-01`);
    await handler(ctx);
    expect(jobs).toHaveLength(1);
    const payload = JSON.stringify(jobs[0]);
    expect(payload).toContain('GROUP MEETING');
    expect(payload).toContain('GROUP VENUE');
    expect(payload).toContain('"startMinutes":60');
    expect(payload).not.toContain('PRIVATE CANARY');
    expect(payload).not.toContain('SECRET VENUE');
  });
  for (const id of [-999, 0, Number.NaN]) {
    test(`${prefix} fails closed for invalid or missing group ${id}`, async () => {
      const { handler, ctx, jobs } = setup(`${prefix}:2099-06-01`, id);
      await handler(ctx);
      expect(jobs).toHaveLength(0);
    });
  }
}

for (const state of ['inactive', 'missing timezone', 'invalid timezone'] as const) {
  test(`group image fails closed with ${state}`, async () => {
    const { handler, ctx, jobs, groups } = setup(`${CB.IMG_DAILY}:2099-06-01`);
    if (state === 'inactive') groups.deactivate(-10);
    else
      db.query('UPDATE group_chats SET timezone = ? WHERE chat_id = -10').run(
        state === 'invalid timezone' ? 'Invalid/Zone' : null,
      );
    await handler(ctx);
    expect(jobs).toHaveLength(0);
  });
}

import { InvitationRepository } from '../../../src/database/repositories/invitation.repository.ts';
import { ParticipantRepository } from '../../../src/database/repositories/participant.repository.ts';
import { SharingSettingsRepository } from '../../../src/database/repositories/sharing-settings.repository.ts';
import { InvitationService } from '../../../src/services/sharing/invitation-service.ts';
import { stripHtml } from '../../../src/utils/telegram.ts';

for (const route of ['view', 'this', 'future', 'share'] as const) {
  test(`${route} delivers complete long detail HTML and final controls through registered callback`, async () => {
    const { handler, ctx, service, bot } = setup('', 1, 'private');
    const description = 'Notes <tag> & 😀 '.repeat(400);
    const event = service.createEvent({
      user_id: 1,
      title: 'Long detail',
      description,
      start_at: '2099-06-01T12:00:00Z',
      timezone: 'UTC',
      recurrence_rule: 'FREQ=DAILY;COUNT=10',
    });
    const users = new UserRepository(db);
    const invites = new InvitationRepository(db);
    for (let id = 2; id <= 11; id++) {
      users.create({ telegram_id: id, first_name: `${id} ${'Guest'.repeat(18)}`.slice(0, 80) });
      invites.create({ event_id: event.id, inviter_id: 1, invitee_id: id });
    }
    const data =
      route === 'view'
        ? `${CB.EVENT_VIEW}:${event.id}`
        : route === 'share'
          ? `${CB.SHARE_EVENT}:evt:${event.id}`
          : `${CB.EVENT_RECURRENCE}:${event.id}:2099-06-02T12:00:00Z:${route}`;
    Object.defineProperty(ctx, 'data', { value: data });
    const visible: string[] = [];
    const controls: unknown[] = [];
    let rejected = 0;
    const record = (text: string, markup: unknown) => {
      if (text.length > 4096) {
        rejected++;
        throw new Error('Telegram message too long');
      }
      expect(text.match(/<b>/g)?.length ?? 0).toBe(text.match(/<\/b>/g)?.length ?? 0);
      expect(text.match(/<a /g)?.length ?? 0).toBe(text.match(/<\/a>/g)?.length ?? 0);
      visible.push(stripHtml(text));
      controls.push(markup);
      return { message_id: 10, date: 0, chat: { id: 1, type: 'private' as const } };
    };
    bot.api.editMessageText = async (params) => record(String(params.text), params.reply_markup);
    bot.api.sendMessage = async (params) => record(String(params.text), params.reply_markup);
    await handler(ctx);
    expect(rejected).toBe(0);
    expect(visible.join('')).toContain(description);
    if (route === 'future') expect(visible.join('')).toContain('No invitations');
    else
      for (let id = 2; id <= 11; id++)
        expect(visible.join('')).toContain(`${`${id} ${'Guest'.repeat(18)}`.slice(0, 80)}: ⏳ pending`);
    if (route !== 'share') {
      expect(JSON.stringify(controls.at(-1))).toContain('callback_data');
      for (const control of controls.slice(0, -1)) expect(JSON.stringify(control) ?? '').not.toContain('callback_data');
    }
  });
}

test('accepted invitation callback sends complete long detail through bounded HTML transport', async () => {
  const { handler, ctx, service, bot } = setup('', 1, 'private');
  new UserRepository(db).create({ telegram_id: 2, first_name: 'Organizer' });
  const description = 'Invitation <notes> & 😀 '.repeat(400);
  const event = service.createEvent({
    user_id: 2,
    title: 'Invited event',
    description,
    start_at: '2099-06-01T12:00:00Z',
    timezone: 'UTC',
  });
  const invitation = new InvitationRepository(db).create({ event_id: event.id, inviter_id: 2, invitee_id: 1 });
  Object.defineProperty(ctx, 'data', { value: `${CB.INVITATION_ACTION}:accept:${invitation.id}` });
  const visible: string[] = [];
  let rejected = 0;
  const record = (text: string) => {
    if (text.length > 4096) {
      rejected++;
      throw new Error('Telegram message too long');
    }
    expect(text.match(/<b>/g)?.length ?? 0).toBe(text.match(/<\/b>/g)?.length ?? 0);
    expect(text.match(/<a /g)?.length ?? 0).toBe(text.match(/<\/a>/g)?.length ?? 0);
    visible.push(stripHtml(text));
    return { message_id: 10, date: 0, chat: { id: 1, type: 'private' as const } };
  };
  bot.api.editMessageText = async (params) => record(String(params.text));
  bot.api.sendMessage = async (params) => record(String(params.text));
  await handler(ctx);
  expect(rejected).toBe(0);
  expect(visible.join('')).toContain(description);
  expect(visible.join('')).toContain('Your invitation: ✅ accepted');
});

for (const action of ['today', 'tomorrow', 'week']) {
  for (const group of [false, true]) {
    test(`share ${action} preserves long text and correct ${group ? 'group' : 'private'} scope`, async () => {
      setSystemTime(new Date('2030-01-15T12:00:00Z'));
      const { handler, ctx, service, bot } = setup(
        `${CB.SHARE_EVENT}:${action}`,
        group ? -10 : 1,
        group ? 'supergroup' : 'private',
      );
      const day = action === 'tomorrow' ? '16' : '15';
      const at = `2030-01-${day}T12:00:00${group ? '+09:00' : '-08:00'}`;
      const description = `Notes <safe> & ${'x'.repeat(1800)}`;
      for (let i = 0; i < 3; i++)
        service.createEvent({
          user_id: 1,
          title: `Shared event ${i}`,
          location: `Venue ${i}`,
          description,
          start_at: at,
          timezone: group ? 'Asia/Tokyo' : 'America/Los_Angeles',
          ...(group ? { owner_type: 'group', group_id: -10 } : {}),
        });
      if (group)
        service.createEvent({
          user_id: 1,
          title: 'DO NOT DISCLOSE',
          location: 'PRIVATE HOME',
          start_at: at,
          timezone: 'Asia/Tokyo',
        });
      const delivered: string[] = [];
      const edits: string[] = [];
      let rejected = 0;
      const message = {
        message_id: 10,
        date: 0,
        chat: { id: group ? -10 : 1, type: group ? ('supergroup' as const) : ('private' as const) },
      };
      bot.api.sendMessage = async (params) => {
        const text = String(params.text);
        if (text.length > 4096) {
          rejected++;
          throw new Error('too long');
        }
        delivered.push(stripHtml(text));
        return message;
      };
      bot.api.editMessageText = async (params) => {
        edits.push(String(params.text));
        return message;
      };
      await handler(ctx);
      expect(rejected).toBe(0);
      expect(delivered.length).toBeGreaterThan(1);
      const text = delivered.join('');
      for (let i = 0; i < 3; i++) {
        expect(text).toContain(`Shared event ${i}`);
        expect(text).toContain(`Venue ${i}`);
      }
      expect(text.split(description)).toHaveLength(4);
      expect(text).not.toContain('DO NOT DISCLOSE');
      expect(text).not.toContain('PRIVATE HOME');
      expect(edits.join('')).toContain('Sent below');
    });
  }
}

test('share delivery failure never reports sent below', async () => {
  setSystemTime(new Date('2030-01-15T12:00:00Z'));
  const { handler, ctx, service, bot } = setup(`${CB.SHARE_EVENT}:today`, 1, 'private');
  service.createEvent({
    user_id: 1,
    title: 'Not delivered',
    start_at: '2030-01-15T20:00:00Z',
    timezone: 'America/Los_Angeles',
  });
  const edits: string[] = [];
  bot.api.sendMessage = async () => {
    throw new Error('synthetic send failed');
  };
  bot.api.editMessageText = async (params) => {
    edits.push(String(params.text));
    return { message_id: 10, date: 0, chat: { id: 1, type: 'private' as const } };
  };
  try {
    await handler(ctx);
  } catch {
    /* transport failure may propagate to global handler */
  }
  expect(edits.join('')).not.toContain('Sent below');
});

for (const prefix of [CB.IMG_DAILY, CB.IMG_WEEKLY]) {
  test(`${prefix} actual callback sends oversized image as document and reports rejection`, async () => {
    const { handler, ctx, bot } = setup(`${prefix}:2099-06-01`, -10, 'supergroup', png(2160, 9000));
    let documents = 0;
    const errors: string[] = [];
    bot.api.sendPhoto = async () => {
      throw new Error('Photo must not be called');
    };
    bot.api.sendDocument = async (params) => {
      expect(params.chat_id).toBe(-10);
      expect(String(params.caption)).toContain('PNG');
      documents++;
      return { message_id: 42, date: 0, chat: { id: -10, type: 'supergroup' } };
    };
    await handler(ctx);
    expect(documents).toBe(1);
    bot.api.sendDocument = async () => {
      throw new Error('Rejected');
    };
    bot.api.sendMessage = async (params) => {
      errors.push(String(params.text));
      return { message_id: 43, date: 0, chat: { id: -10, type: 'supergroup' } };
    };
    await handler(ctx);
    expect(errors.length).toBeGreaterThan(0);
  });
}
