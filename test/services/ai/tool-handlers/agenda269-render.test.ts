// AI image entry points use real visibility/metadata storage and capture render jobs locally.
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { migrations } from '../../../../src/database/migrations.ts';
import { AgendaRepository } from '../../../../src/database/repositories/agenda.repository.ts';
import { ChatHistoryRepository } from '../../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../../src/database/repositories/event-reminder.repository.ts';
import { HolidayRepository } from '../../../../src/database/repositories/holiday.repository.ts';
import { InvitationRepository } from '../../../../src/database/repositories/invitation.repository.ts';
import { ParticipantRepository } from '../../../../src/database/repositories/participant.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import {
  handleRenderDayImage,
  handleRenderMonthImage,
  handleRenderWeekImage,
} from '../../../../src/services/ai/tool-handlers/render.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { ConversationLogger } from '../../../../src/services/conversation-logger.ts';
import { EventService } from '../../../../src/services/event/event-service.ts';
import { HolidayService } from '../../../../src/services/holiday/holiday-service.ts';
import type { ImageRenderJob } from '../../../../src/worker/image-render.queue.ts';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, migrations);
});
afterEach(() => db.close());
function setup(userId: number, group = false) {
  const users = new UserRepository(db);
  for (const [id, name] of [
    [1, 'Owner'],
    [2, 'Attendee'],
    [3, 'Private Other'],
  ] as const)
    users.create({ telegram_id: id, first_name: name, timezone: 'UTC', language: 'en' });
  const participantRepo = new ParticipantRepository(db);
  const eventService = new EventService({
    eventRepo: new EventRepository(db),
    participantRepo,
    agendaRepository: new AgendaRepository(db),
  });
  const event = eventService.createEvent({
    user_id: 1,
    title: 'PRIVATE MEETING',
    location: 'PRIVATE VENUE',
    description: 'TEXT ONLY SECRET NOTES',
    start_at: '2099-06-01T10:00:00Z',
    timezone: 'UTC',
  });
  const invitations = new InvitationRepository(db);
  invitations.create({ event_id: event.id, inviter_id: 1, invitee_id: 2 });
  invitations.create({ event_id: event.id, inviter_id: 1, invitee_id: 3 });
  participantRepo.add(event.id, 2, 'accepted');
  const noInvite = eventService.createEvent({
    user_id: 1,
    title: 'Participation only',
    start_at: '2099-06-01T12:00:00Z',
    timezone: 'UTC',
  });
  participantRepo.add(noInvite.id, 2, 'accepted');
  const groupEvent = eventService.createEvent({
    user_id: 1,
    owner_type: 'group',
    group_id: -10,
    title: 'GROUP MEETING',
    start_at: '2099-06-01T10:00:00Z',
    timezone: 'UTC',
  });
  participantRepo.add(groupEvent.id, 2, 'accepted');
  const jobs: ImageRenderJob[] = [];
  const chatHistory = new ChatHistoryRepository(db);
  const ctx: AgentContext = {
    user: users.findByTelegramId(userId)!,
    chatId: group ? -10 : userId,
    isGroup: group,
    groupChatId: group ? -10 : undefined,
    messageText: '',
    eventService,
    userRepo: users,
    holidayService: new HolidayService(new HolidayRepository(db)),
    chatHistory,
    conversationLogger: new ConversationLogger(chatHistory),
    eventReminderRepo: new EventReminderRepository(db),
    sender: {
      editMessageText: async () => {},
      sendMessage: async () => ({ message_id: 1 }),
      sendPhoto: async () => ({ message_id: 2 }),
    },
    renderService: {
      renderDirect: async (job) => {
        jobs.push(job);
        return Buffer.from('png');
      },
    },
  };
  return { ctx, jobs };
}
const handlers = {
  day: (ctx: AgentContext, owner_id?: number) => handleRenderDayImage(ctx, { date: '2099-06-01', owner_id }),
  week: (ctx: AgentContext, owner_id?: number) => handleRenderWeekImage(ctx, { week_start: '2099-06-01', owner_id }),
  month: (ctx: AgentContext, owner_id?: number) => handleRenderMonthImage(ctx, { month: '2099-06', owner_id }),
};
for (const [name, handler] of Object.entries(handlers)) {
  for (const userId of [1, 2, 3]) {
    test(`${name} actual handler preserves authorized viewer ${userId} metadata boundary`, async () => {
      const { ctx, jobs } = setup(userId);
      expect((await handler(ctx)).success).toBe(true);
      expect(jobs).toHaveLength(1);
      const payload = JSON.stringify(jobs);
      expect(payload).not.toContain('TEXT ONLY SECRET NOTES');
      if (userId === 1) {
        expect(payload).toContain('Attendee: ⏳ pending');
        expect(payload).toContain('Private Other: ⏳ pending');
      } else if (userId === 2) {
        expect(payload).toContain('Your invitation: ⏳ pending');
        expect(payload).toContain('Your participation: ✅ accepted');
        expect(payload).not.toContain('Private Other');
      } else expect(payload).not.toContain('PRIVATE MEETING');
    });
  }
  test(`${name} group handler exposes group aggregates only`, async () => {
    const { ctx, jobs } = setup(1, true);
    expect((await handler(ctx)).success).toBe(true);
    const payload = JSON.stringify(jobs);
    expect(payload).toContain('GROUP MEETING');
    expect(payload).toContain('Participants: 1');
    expect(payload).not.toContain('PRIVATE');
    expect(payload).not.toContain('Private Other');
  });
  test(`${name} missing metadata repository leaves invitation evidence unknown`, async () => {
    const { ctx, jobs } = setup(1);
    ctx.eventService = new EventService({ eventRepo: new EventRepository(db) });
    expect((await handler(ctx)).success).toBe(true);
    const payload = JSON.stringify(jobs);
    expect(payload).toContain('PRIVATE MEETING');
    expect(payload).not.toContain('invitationStatus');
    expect(payload).not.toContain('No invitations');
  });
  test(`${name} denied secretary request renders nothing`, async () => {
    const { ctx, jobs } = setup(2);
    expect((await handler(ctx, 1)).success).toBe(false);
    expect(jobs).toHaveLength(0);
  });
}

for (const [timezone, start] of [['Pacific/Kiritimati', '2099-05-31T11:00:00Z'], ['Pacific/Honolulu', '2099-06-02T09:00:00Z']]) {
  test(`day image selects the requested local date in ${timezone}`, async () => {
    const {ctx, jobs} = setup(1);
    ctx.user.timezone = timezone!;
    ctx.eventService.createEvent({user_id: 1, title: 'LOCAL DATE SENTINEL', start_at: start!, timezone: timezone!});
    await handleRenderDayImage(ctx, {date: '2099-06-01'});
    expect(JSON.stringify(jobs)).toContain('LOCAL DATE SENTINEL');
  });
}
