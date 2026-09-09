import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { migrations } from '../../../../src/database/migrations.ts';
import { CalendarProposalRepository } from '../../../../src/database/repositories/calendar-proposal.repository.ts';
import { ChatHistoryRepository } from '../../../../src/database/repositories/chat-history.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { EventReminderRepository } from '../../../../src/database/repositories/event-reminder.repository.ts';
import { GoogleCalendarRepository } from '../../../../src/database/repositories/google-calendar.repository.ts';
import { GroupChatRepository } from '../../../../src/database/repositories/group-chat.repository.ts';
import { GroupMemberRepository } from '../../../../src/database/repositories/group-member.repository.ts';
import { HolidayRepository } from '../../../../src/database/repositories/holiday.repository.ts';
import { ParticipantRepository } from '../../../../src/database/repositories/participant.repository.ts';
import { SecretaryRepository } from '../../../../src/database/repositories/secretary.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import { approveDeletes } from '../../../../src/services/ai/delete-confirmation.ts';
import {
  handleCreateEvent,
  handleDeleteEvent,
  handleGetEvent,
  handleGetEvents,
  handleGetUpcoming,
  handleNotifyParticipants,
  handleSearchEvents,
  handleSnoozeEvent,
  handleUpdateEvent,
} from '../../../../src/services/ai/tool-handlers/events.ts';
import type { AgentContext, GroupCapability } from '../../../../src/services/ai/types.ts';
import { EventService } from '../../../../src/services/event/event-service.ts';
import { localToGoogle } from '../../../../src/services/google/event-mapper.ts';
import type { GroupMemberService } from '../../../../src/services/group/member-service.ts';
import { HolidayService } from '../../../../src/services/holiday/holiday-service.ts';
import { generateIcs } from '../../../../src/services/ics/generator.ts';
import { buildUserSessionInvitationText } from '../../../../src/services/telegram-session/invitation-text.ts';

function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

describe('event tool handlers', () => {
  let db: Database;
  let ctx: AgentContext;
  const USER_ID = 123;

  beforeEach(() => {
    db = createTestDb();
    const userRepo = new UserRepository(db);
    const eventRepo = new EventRepository(db);
    const eventReminderRepo = new EventReminderRepository(db);
    const chatHistoryRepo = new ChatHistoryRepository(db);
    const holidayRepo = new HolidayRepository(db);
    userRepo.create({ telegram_id: USER_ID, timezone: 'UTC' });
    const eventService = new EventService({ eventRepo });
    const holidayService = new HolidayService(holidayRepo);
    ctx = {
      user: userRepo.findByTelegramId(USER_ID)!,
      chatId: USER_ID,
      messageText: '',
      isGroup: false,
      eventService,
      holidayService,
      chatHistory: chatHistoryRepo,
      userRepo,
      eventReminderRepo,
      conversationLogger: null as never,
    };
  });

  describe('handleGetEvents', () => {
    test('returns events in range', async () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Test Event',
        start_at: '2026-03-15T10:00:00Z',
        end_at: '2026-03-15T11:00:00Z',
        timezone: 'UTC',
      });
      const result = await handleGetEvents(ctx, {
        start_date: '2026-03-15T00:00:00Z',
        end_date: '2026-03-15T23:59:59Z',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Test Event');
    });

    test('returns message when no events found', async () => {
      const result = await handleGetEvents(ctx, {
        start_date: '2026-03-15T00:00:00Z',
        end_date: '2026-03-15T23:59:59Z',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('No events');
    });

    describe('empty successful read names the checked day and calendar', () => {
      const OWNER_ID = 456;

      beforeEach(() => {
        // Evening of 2026-09-19 in Belgrade; UTC is still the same calendar day.
        setSystemTime(new Date('2026-09-19T19:30:00Z'));
        ctx.user.timezone = 'Europe/Belgrade';
        ctx.user.language = 'ru';
      });
      afterEach(() => {
        setSystemTime();
      });

      test('"Что завтра?" answers with the local date instead of database-range wording', async () => {
        const result = await handleGetEvents(ctx, { start_date: '2026-09-20', end_date: '2026-09-20' });
        expect(result.success).toBe(true);
        expect(result.data).toEqual([]);
        expect(result.output).toBe(
          'На завтра, 20 сентября, в твоём календаре пока нет событий, которые начинаются в этот день.',
        );
        expect(result.output).not.toMatch(/диапазон|не найдено|свобод/i);
      });

      test('English wording is equally specific', async () => {
        ctx.user.language = 'en';
        const result = await handleGetEvents(ctx, { start_date: '2026-09-20', end_date: '2026-09-20' });
        expect(result.output).toBe('No events in your calendar start tomorrow, September 20.');
      });

      test('an event on another day does not leak into the empty answer for tomorrow', async () => {
        ctx.eventService.createEvent({
          user_id: USER_ID,
          title: 'Synthetic dentist',
          start_at: '2026-09-21T08:00:00Z',
          end_at: '2026-09-21T09:00:00Z',
          timezone: 'Europe/Belgrade',
        });
        const result = await handleGetEvents(ctx, { start_date: '2026-09-20', end_date: '2026-09-20' });
        expect(result.output).toBe(
          'На завтра, 20 сентября, в твоём календаре пока нет событий, которые начинаются в этот день.',
        );
      });

      test('group scope names the group calendar', async () => {
        const result = await handleGetEvents(
          { ...ctx, isGroup: true, groupChatId: -100777, chatId: -100777 },
          { start_date: '2026-09-20', end_date: '2026-09-20', scope: 'group' },
        );
        expect(result.output).toBe(
          'На завтра, 20 сентября, в календаре этой группы пока нет событий, которые начинаются в этот день.',
        );
      });

      test('a delegated read names the selected calendar, not the caller calendar', async () => {
        new UserRepository(db).create({ telegram_id: OWNER_ID, timezone: 'Europe/Belgrade' });
        const secretaryRepo = new SecretaryRepository(db);
        const grant = secretaryRepo.upsert({ owner_id: OWNER_ID, secretary_id: USER_ID, permission: 'read' });
        secretaryRepo.updateStatus(grant.id, 'active');
        const delegatedCtx: AgentContext = {
          ...ctx,
          secretary: {
            secretaryRepo,
            secretaryForLine: undefined,
            calendarProposalRepo: new CalendarProposalRepository(db),
          },
        };
        const result = await handleGetEvents(delegatedCtx, {
          start_date: '2026-09-20',
          end_date: '2026-09-20',
          owner_id: OWNER_ID,
        });
        expect(result.output).toBe(
          'На завтра, 20 сентября, в выбранном календаре пока нет событий, которые начинаются в этот день.',
        );
      });

      test('an hour-only query says nothing starts then, never that the day is free', async () => {
        const result = await handleGetEvents(ctx, {
          start_date: '2026-09-20T09:00:00+02:00',
          end_date: '2026-09-20T10:00:00+02:00',
        });
        expect(result.output).toBe(
          'Завтра, 20 сентября, с 09:00 до 10:00 в твоём календаре нет событий, которые начинаются в это время.',
        );
      });

      test('UTC-midnight bounds of a day are read and described as that local day', async () => {
        const result = await handleGetEvents(ctx, {
          start_date: '2026-09-20T00:00:00Z',
          end_date: '2026-09-20T23:59:59Z',
        });
        expect(result.output).toBe(
          'На завтра, 20 сентября, в твоём календаре пока нет событий, которые начинаются в этот день.',
        );
      });

      test('a datetime without an offset is read as UTC by both the query and the answer', async () => {
        ctx.eventService.createEvent({
          user_id: USER_ID,
          title: 'Synthetic standup',
          start_at: '2026-09-20T07:30:00Z',
          end_at: '2026-09-20T08:00:00Z',
          timezone: 'Europe/Belgrade',
        });
        const hit = await handleGetEvents(ctx, { start_date: '2026-09-20T07:00:00', end_date: '2026-09-20T08:00:00' });
        expect(hit.output).toContain('Synthetic standup');
        const miss = await handleGetEvents(ctx, { start_date: '2026-09-20T08:00:00', end_date: '2026-09-20T09:00:00' });
        expect(miss.output).toBe(
          'Завтра, 20 сентября, с 10:00 до 11:00 в твоём календаре нет событий, которые начинаются в это время.',
        );
      });

      test('space-separated datetimes and colon-less offsets name the same instant as the query', async () => {
        const spaced = await handleGetEvents(ctx, {
          start_date: '2026-09-20 07:00:00',
          end_date: '2026-09-20 08:00:00',
        });
        expect(spaced.output).toBe(
          'Завтра, 20 сентября, с 09:00 до 10:00 в твоём календаре нет событий, которые начинаются в это время.',
        );
        const compact = await handleGetEvents(ctx, {
          start_date: '2026-09-20T09:00:00.123456+0200',
          end_date: '2026-09-20T10:00:00+0200',
        });
        expect(compact.output).toBe(
          'Завтра, 20 сентября, с 09:00 до 10:00 в твоём календаре нет событий, которые начинаются в это время.',
        );
      });

      test('an overnight event that started the day before is not denied by the empty-day answer', async () => {
        // Starts 22:00 on the 19th, ends 02:00 on the 20th (Belgrade). The start-matching read omits it
        // (tracked by #570), so the answer may only claim that nothing STARTS on the 20th.
        ctx.eventService.createEvent({
          user_id: USER_ID,
          title: 'Synthetic night train',
          start_at: '2026-09-19T20:00:00Z',
          end_at: '2026-09-20T00:00:00Z',
          timezone: 'Europe/Belgrade',
        });
        const result = await handleGetEvents(ctx, { start_date: '2026-09-20', end_date: '2026-09-20' });
        expect(result.data).toEqual([]);
        expect(result.output).toBe(
          'На завтра, 20 сентября, в твоём календаре пока нет событий, которые начинаются в этот день.',
        );
        expect(result.output).not.toMatch(/ничего не запланировано|свобод/i);
      });

      test('a failed read propagates instead of becoming an empty-calendar answer', async () => {
        ctx.eventService.getEventsInRange = () => {
          throw new Error('Synthetic storage failure');
        };
        await expect(handleGetEvents(ctx, { start_date: '2026-09-20', end_date: '2026-09-20' })).rejects.toThrow(
          'Synthetic storage failure',
        );
      });

      test.each([
        ['2026-09-21T00:00:00Z', '2026-09-20T00:00:00Z'],
        ['2026-09-20T09:00:00Z', '2026-09-20T09:00:00Z'],
        ['tomorrow', '2026-09-20T09:00:00Z'],
        ['2026-02-30', '2026-03-02'],
        ['2026-09-20', '2026-13-01'],
        ['0', '1'],
        ['2026-09-20T09:00:00Z', 'next week'],
        ['2026-02-30T09:00:00Z', '2026-03-05T09:00:00Z'],
        ['2026-02-30T00:00:00Z', '2026-02-30T23:59:59Z'],
      ])('a reversed, zero-length or unparseable interval %s .. %s is rejected before any read', async (start, end) => {
        let reads = 0;
        ctx.eventService.getEventsInRange = () => {
          reads++;
          return [];
        };
        const result = await handleGetEvents(ctx, { start_date: start, end_date: end });
        expect(result.success).toBe(false);
        expect(result.mutationState).toBe('not_applied');
        expect(result.error).toContain('INVALID_RANGE');
        expect(reads).toBe(0);
      });
    });

    describe('a day sent as UTC-midnight bounds is the user local day (#550)', () => {
      // Evening of 2026-09-27 in Belgrade (UTC+2): "tomorrow" is 28.09 local.
      const events = (...titles: string[]) => titles.map((title) => expect.objectContaining({ title }));

      beforeEach(() => {
        setSystemTime(new Date('2026-09-27T20:59:00Z'));
        ctx.user.timezone = 'Europe/Belgrade';
        ctx.user.language = 'en';
        const event = (title: string, start_at: string, end_at: string) =>
          ctx.eventService.createEvent({ user_id: USER_ID, title, start_at, end_at, timezone: 'Europe/Belgrade' });
        event('Synthetic early swim', '2026-09-27T22:30:00Z', '2026-09-27T23:00:00Z'); // 00:30 local on 28.09
        event('Synthetic night call', '2026-09-28T23:00:00Z', '2026-09-28T23:30:00Z'); // 01:00 local on 29.09
        event('Synthetic late run', '2026-09-29T22:30:00Z', '2026-09-29T23:00:00Z'); // 00:30 local on 30.09
      });
      afterEach(() => {
        setSystemTime();
      });

      test('00:00Z..23:59:59.999Z returns the early event of the local day, not the next local day', async () => {
        const result = await handleGetEvents(ctx, {
          start_date: '2026-09-28T00:00:00.000Z',
          end_date: '2026-09-28T23:59:59.999Z',
        });
        expect(result.success).toBe(true);
        expect(result.data).toEqual(events('Synthetic early swim'));
      });

      test('a multi-day UTC-midnight range covers exactly those local days', async () => {
        const result = await handleGetEvents(ctx, {
          start_date: '2026-09-28T00:00:00Z',
          end_date: '2026-09-29T23:59:59Z',
        });
        expect(result.data).toEqual(events('Synthetic early swim', 'Synthetic night call'));
      });

      test('date-only bounds keep reading the local day', async () => {
        const result = await handleGetEvents(ctx, { start_date: '2026-09-28', end_date: '2026-09-28' });
        expect(result.data).toEqual(events('Synthetic early swim'));
      });

      test('explicit offsets stay verbatim, even a +00:00 offset naming the UTC day', async () => {
        const local = await handleGetEvents(ctx, {
          start_date: '2026-09-28T00:00:00+02:00',
          end_date: '2026-09-28T23:59:59+02:00',
        });
        expect(local.data).toEqual(events('Synthetic early swim'));
        const utc = await handleGetEvents(ctx, {
          start_date: '2026-09-28T00:00:00+00:00',
          end_date: '2026-09-28T23:59:59+00:00',
        });
        expect(utc.data).toEqual(events('Synthetic night call'));
      });

      test('non-midnight instants and a half-matching pair stay verbatim', async () => {
        const hour = await handleGetEvents(ctx, {
          start_date: '2026-09-27T22:00:00Z',
          end_date: '2026-09-27T23:00:00Z',
        });
        expect(hour.data).toEqual(events('Synthetic early swim'));
        const halfDay = await handleGetEvents(ctx, {
          start_date: '2026-09-28T00:00:00Z',
          end_date: '2026-09-28T23:30:00Z',
        });
        expect(halfDay.data).toEqual(events('Synthetic night call'));
        const dayEnd = await handleGetEvents(ctx, {
          start_date: '2026-09-28T12:00:00Z',
          end_date: '2026-09-28T23:59:59Z',
        });
        expect(dayEnd.data).toEqual(events('Synthetic night call'));
      });

      test('a UTC+14 user gets the requested local day, not the following one', async () => {
        ctx.user.timezone = 'Pacific/Kiritimati'; // 28.09 local is 2026-09-27T10:00Z..2026-09-28T09:59:59.999Z
        const edges = await handleGetEvents(ctx, {
          start_date: '2026-09-28T00:00:00Z',
          end_date: '2026-09-28T23:59:59Z',
        });
        expect(edges.data).toEqual(events('Synthetic early swim'));
        const dateOnly = await handleGetEvents(ctx, { start_date: '2026-09-28', end_date: '2026-09-28' });
        expect(dateOnly.data).toEqual(events('Synthetic early swim'));
      });

      test('a UTC user keeps the UTC day', async () => {
        ctx.user.timezone = 'UTC';
        const result = await handleGetEvents(ctx, {
          start_date: '2026-09-28T00:00:00Z',
          end_date: '2026-09-28T23:59:59Z',
        });
        expect(result.data).toEqual(events('Synthetic night call'));
      });
    });

    test('accepts date-only format (YYYY-MM-DD) and finds events on that day', async () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Morning Meeting',
        start_at: '2026-03-15T10:00:00Z',
        end_at: '2026-03-15T11:00:00Z',
        timezone: 'UTC',
      });
      const result = await handleGetEvents(ctx, {
        start_date: '2026-03-15',
        end_date: '2026-03-15',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Morning Meeting');
    });

    test('populates data with EventSummary array', async () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Standup',
        start_at: '2026-03-15T09:00:00Z',
        end_at: '2026-03-15T09:30:00Z',
        timezone: 'UTC',
      });
      const result = await handleGetEvents(ctx, {
        start_date: '2026-03-15T00:00:00Z',
        end_date: '2026-03-15T23:59:59Z',
      });
      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
      const data = result.data as Array<{ id: number; title: string; date: string; time: string }>;
      expect(data).toHaveLength(1);
      expect(data[0]!.title).toBe('Standup');
      expect(data[0]!.date).toBe('2026-03-15');
      expect(data[0]!.time).toBe('09:00');
      expect(typeof data[0]!.id).toBe('number');
    });

    test('data is empty array when no events found', async () => {
      const result = await handleGetEvents(ctx, {
        start_date: '2026-03-15T00:00:00Z',
        end_date: '2026-03-15T23:59:59Z',
      });
      expect(result.success).toBe(true);
      expect(result.data).toEqual([]);
    });
  });

  describe('handleCreateEvent', () => {
    const futureDate = new Date(Date.now() + 86400000).toISOString().slice(0, 11);

    test('creates event and returns details', async () => {
      const result = await handleCreateEvent(ctx, {
        title: 'New Meeting',
        start_at: `${futureDate}14:00:00Z`,
        end_at: `${futureDate}15:00:00Z`,
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('New Meeting');
      expect(result.output).toContain('id');
    });

    test('creates event with description and location', async () => {
      const result = await handleCreateEvent(ctx, {
        title: 'Lunch',
        start_at: `${futureDate}12:00:00Z`,
        description: 'Team lunch',
        location: 'Cafe',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Lunch');
    });

    test('triggers location verification for concrete locations', async () => {
      const verifyMock = mock(() =>
        Promise.resolve({ resolved: true, geocoded: null, cityExtracted: null, candidates: [] }),
      );
      ctx.locationVerification = { verifyEventLocation: verifyMock } as never;
      await handleCreateEvent(ctx, {
        title: 'Meeting',
        start_at: `${futureDate}14:00:00Z`,
        location: 'Кофемания',
      });
      expect(verifyMock).toHaveBeenCalledTimes(1);
    });

    test('skips location verification when location_abstract is true', async () => {
      const verifyMock = mock(() =>
        Promise.resolve({ resolved: true, geocoded: null, cityExtracted: null, candidates: [] }),
      );
      ctx.locationVerification = { verifyEventLocation: verifyMock } as never;
      await handleCreateEvent(ctx, {
        title: 'Hangout',
        start_at: `${futureDate}14:00:00Z`,
        location: 'У Иры',
        location_abstract: true,
      });
      expect(verifyMock).not.toHaveBeenCalled();
    });

    test('rejects past event without force', async () => {
      const result = await handleCreateEvent(ctx, {
        title: 'Past Event',
        start_at: '2020-01-01T10:00:00Z',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('PAST_EVENT');
    });

    test('allows past event with force: true', async () => {
      const result = await handleCreateEvent(ctx, {
        title: 'Past Event',
        start_at: '2020-01-01T10:00:00Z',
        force: true,
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Past Event');
    });

    test('allows all-day past event without force', async () => {
      const result = await handleCreateEvent(ctx, {
        title: 'Past Holiday',
        start_at: '2020-01-01T00:00:00Z',
        all_day: true,
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Past Holiday');
    });
  });

  describe('handleUpdateEvent', () => {
    test('updates event title', async () => {
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Old Title',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      const result = await handleUpdateEvent(ctx, {
        event_id: event.id,
        title: 'New Title',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('New Title');
    });

    test('returns error for non-existent event', async () => {
      const result = await handleUpdateEvent(ctx, {
        event_id: 9999,
        title: 'Whatever',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('location in event tool output', () => {
    const SOON = new Date(Date.now() + 2 * 86400000).toISOString();
    const PLACE = 'verified place: Кафе Ромашка — ул. Примерная, 1, Москва';

    /** An event typed as "кафе у парка" that a geocode matched to a synthetic venue. */
    function createGeocodedEvent(locationVerified: 0 | 1): number {
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Обед',
        start_at: SOON,
        timezone: 'UTC',
        location: 'кафе у парка',
      });
      new EventRepository(db).updateLocationFields(event.id, {
        resolved_address: 'ул. Примерная, 1, Москва',
        latitude: 55.75,
        longitude: 37.61,
        google_maps_url: 'https://www.google.com/maps/search/?api=1&query=55.75,37.61',
        location_verified: locationVerified,
        venue_name: 'Кафе Ромашка',
      });
      return event.id;
    }

    test('get_event names the typed text and the verified venue with its address', async () => {
      const eventId = createGeocodedEvent(1);
      const result = await handleGetEvent(ctx, { event_id: eventId });
      expect(result.success).toBe(true);
      expect(result.output).toContain(`location: кафе у парка, ${PLACE}`);
    });

    test('get_event marks an unverified location and never shows its geocode', async () => {
      const eventId = createGeocodedEvent(0);
      const result = await handleGetEvent(ctx, { event_id: eventId });
      expect(result.output).toContain('location: кафе у парка (not verified)');
      expect(result.output).not.toContain('Примерная');
      expect(result.output).not.toContain('Ромашка');
    });

    test('update_event output keeps the verified place of the updated event', async () => {
      const eventId = createGeocodedEvent(1);
      const result = await handleUpdateEvent(ctx, { event_id: eventId, title: 'Обед с Леной' });
      expect(result.success).toBe(true);
      expect(result.output).toContain(`location: кафе у парка, ${PLACE}`);
    });

    test('update_event output marks an unverified location', async () => {
      const eventId = createGeocodedEvent(0);
      const result = await handleUpdateEvent(ctx, { event_id: eventId, title: 'Обед с Леной' });
      expect(result.output).toContain('location: кафе у парка (not verified)');
      expect(result.output).not.toContain('Примерная');
    });

    test('a new location on a verified event is reported and pushed to Google as the new typed text', async () => {
      const eventId = createGeocodedEvent(1);
      const result = await handleUpdateEvent(ctx, { event_id: eventId, location: 'Starbucks Тверская' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('location: Starbucks Тверская (not verified)');
      expect(result.output).not.toContain('Ромашка');
      const row = new EventRepository(db).findById(eventId, USER_ID)!;
      expect(localToGoogle(row).location).toBe('Starbucks Тверская');
    });

    test('event lists (get_events, search_events, get_upcoming) show the verified place', async () => {
      createGeocodedEvent(1);
      const day = SOON.slice(0, 10);
      const listed = await handleGetEvents(ctx, { start_date: day, end_date: day });
      const searched = await handleSearchEvents(ctx, { query: 'Обед' });
      const upcoming = await handleGetUpcoming(ctx, {});
      for (const result of [listed, searched, upcoming]) {
        expect(result.output).toContain(`location: кафе у парка, ${PLACE}`);
      }
    });

    test('a place confirmed with a pin on an event without typed text is shown and pushed to Google', async () => {
      const event = ctx.eventService.createEvent({ user_id: USER_ID, title: 'Обед', start_at: SOON, timezone: 'UTC' });
      new EventRepository(db).updateLocationFields(event.id, {
        resolved_address: 'ул. Примерная, 1, Москва',
        latitude: 55.75,
        longitude: 37.61,
        google_maps_url: 'https://www.google.com/maps/search/?api=1&query=55.75,37.61',
        location_verified: 1,
        venue_name: 'Кафе Ромашка',
      });

      const single = await handleGetEvent(ctx, { event_id: event.id });
      const day = SOON.slice(0, 10);
      const lists = [
        await handleGetEvents(ctx, { start_date: day, end_date: day }),
        await handleSearchEvents(ctx, { query: 'Обед' }),
        await handleGetUpcoming(ctx, {}),
      ];

      for (const result of [single, ...lists]) {
        expect(result.output).toContain(PLACE);
        expect(result.output).not.toContain('location: null');
      }
      const row = new EventRepository(db).findById(event.id, USER_ID)!;
      expect(localToGoogle(row).location).toBe('Кафе Ромашка — ул. Примерная, 1, Москва');
    });

    test('removing the location drops a pin-confirmed place from every surface', async () => {
      const event = ctx.eventService.createEvent({ user_id: USER_ID, title: 'Обед', start_at: SOON, timezone: 'UTC' });
      new EventRepository(db).updateLocationFields(event.id, {
        resolved_address: 'ул. Примерная, 1, Москва',
        latitude: 55.75,
        longitude: 37.61,
        google_maps_url: 'https://www.google.com/maps/search/?api=1&query=55.75,37.61',
        location_verified: 1,
        venue_name: 'Кафе Ромашка',
      });

      const cleared = await handleUpdateEvent(ctx, { event_id: event.id, location: null });
      const shown = await handleGetEvent(ctx, { event_id: event.id });

      expect(cleared.success).toBe(true);
      for (const result of [cleared, shown]) expect(result.output).not.toContain('Ромашка');
      const row = new EventRepository(db).findById(event.id, USER_ID)!;
      expect(localToGoogle(row).location).toBeUndefined();
      expect(generateIcs([row])).not.toContain('LOCATION');
      const invitation = buildUserSessionInvitationText({
        event: row,
        inviterTimezone: 'UTC',
        deepLink: 'https://t.me/hypercal_bot?start=invite_1',
        lang: 'ru',
      });
      expect(invitation).not.toContain('📍');
    });
  });

  describe('handleDeleteEvent', () => {
    test('deletes event', async () => {
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'To Delete',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      approveDeletes(ctx.user.telegram_id, ctx.chatId, [event.id]);
      const result = await handleDeleteEvent(ctx, { event_id: event.id });
      expect(result.success).toBe(true);
    });

    test('returns error for non-existent event', async () => {
      const result = await handleDeleteEvent(ctx, { event_id: 9999 });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('handleSearchEvents', () => {
    test('finds events by title', async () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Team Standup',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Lunch Break',
        start_at: '2026-03-15T12:00:00Z',
        timezone: 'UTC',
      });
      const result = await handleSearchEvents(ctx, { query: 'Standup' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Team Standup');
      expect(result.output).not.toContain('Lunch Break');
    });

    test('returns message when nothing found', async () => {
      const result = await handleSearchEvents(ctx, { query: 'nonexistent' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('No events');
    });

    test('event_type=birthday returns only birthday events', async () => {
      const eventRepo = new EventRepository(db);
      eventRepo.create({
        user_id: USER_ID,
        title: 'Д/р Иван',
        start_at: '2026-05-10T00:00:00Z',
        all_day: true,
        timezone: 'UTC',
        event_type: 'birthday',
      });
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Team Meeting',
        start_at: '2026-05-10T10:00:00Z',
        timezone: 'UTC',
      });
      const result = await handleSearchEvents(ctx, { event_type: 'birthday' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Д/р Иван');
      expect(result.output).not.toContain('Team Meeting');
    });

    test('event_type=regular excludes birthday events', async () => {
      const eventRepo = new EventRepository(db);
      eventRepo.create({
        user_id: USER_ID,
        title: 'Д/р Иван',
        start_at: '2026-05-10T00:00:00Z',
        all_day: true,
        timezone: 'UTC',
        event_type: 'birthday',
      });
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Team Meeting',
        start_at: '2026-05-10T10:00:00Z',
        timezone: 'UTC',
      });
      const result = await handleSearchEvents(ctx, { event_type: 'regular' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Team Meeting');
      expect(result.output).not.toContain('Д/р Иван');
    });
  });

  describe('handleUpdateEvent — participant info', () => {
    test('output mentions participant count when event has accepted participants', async () => {
      const participantRepo = new ParticipantRepository(db);
      const otherUserId = 999;
      const userRepo = new UserRepository(db);
      userRepo.create({ telegram_id: otherUserId, timezone: 'UTC' });

      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Shared Meeting',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      participantRepo.add(event.id, otherUserId, 'accepted');

      const ctxWithParticipants = { ...ctx, participantRepo };
      const result = await handleUpdateEvent(ctxWithParticipants, {
        event_id: event.id,
        title: 'Renamed Meeting',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('1 participant');
      expect(result.output).toContain('notify');
    });

    test('output does not mention participants when event has none', async () => {
      const participantRepo = new ParticipantRepository(db);
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Solo Event',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });

      const ctxWithParticipants = { ...ctx, participantRepo };
      const result = await handleUpdateEvent(ctxWithParticipants, {
        event_id: event.id,
        title: 'Still Solo',
      });
      expect(result.success).toBe(true);
      expect(result.output).not.toContain('participant');
    });
  });

  describe('handleNotifyParticipants', () => {
    test('sends message to accepted participants', async () => {
      const participantRepo = new ParticipantRepository(db);
      const otherUserId = 999;
      const userRepo = new UserRepository(db);
      userRepo.create({ telegram_id: otherUserId, timezone: 'UTC' });

      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Team Standup',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      participantRepo.add(event.id, otherUserId, 'accepted');

      const enqueuedBatches: { recipientId: number; text: string; origin: string }[][] = [];
      const ctxWithBroadcast = {
        ...ctx,
        participantRepo,
        broadcast: {
          enqueue: async () => {},
          enqueueBatch: async (items: { recipientId: number; text: string; origin: string }[]) => {
            enqueuedBatches.push(items);
          },
        },
      };

      const result = await handleNotifyParticipants(ctxWithBroadcast, {
        event_id: event.id,
        message: 'Meeting moved to 11:00',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('1 participant');
      expect(enqueuedBatches).toHaveLength(1);
      expect(enqueuedBatches[0]).toHaveLength(1);
      expect(enqueuedBatches[0]![0]!.recipientId).toBe(otherUserId);
      expect(enqueuedBatches[0]![0]!.text).toContain('Meeting moved to 11:00');
    });

    test('returns error when event not found', async () => {
      const result = await handleNotifyParticipants(ctx, {
        event_id: 9999,
        message: 'hello',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('returns error when no participants', async () => {
      const participantRepo = new ParticipantRepository(db);
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Solo',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });

      const ctxWithParticipants = {
        ...ctx,
        participantRepo,
        broadcast: { enqueue: async () => {}, enqueueBatch: async () => {} },
      };
      const result = await handleNotifyParticipants(ctxWithParticipants, {
        event_id: event.id,
        message: 'Test',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('no accepted participants');
    });
  });

  describe('group scope', () => {
    const GROUP_CHAT_ID = -100999;

    function makeGroupCtx(): AgentContext {
      return {
        ...ctx,
        isGroup: true,
        groupChatId: GROUP_CHAT_ID,
        chatId: GROUP_CHAT_ID,
        groupTitle: 'Test Group',
      };
    }

    function createGroupEvent(title: string, startAt: string, endAt?: string) {
      return ctx.eventService.createEvent({
        user_id: USER_ID,
        title,
        start_at: startAt,
        end_at: endAt,
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_CHAT_ID,
        created_by: USER_ID,
      });
    }

    test('handleGetEvents with scope=group queries group calendar', async () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Personal Event',
        start_at: '2026-03-15T10:00:00Z',
        end_at: '2026-03-15T11:00:00Z',
        timezone: 'UTC',
      });
      createGroupEvent('Group Event', '2026-03-15T14:00:00Z', '2026-03-15T15:00:00Z');

      const gCtx = makeGroupCtx();
      const result = await handleGetEvents(gCtx, {
        start_date: '2026-03-15T00:00:00Z',
        end_date: '2026-03-15T23:59:59Z',
        scope: 'group',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Group Event');
      expect(result.output).not.toContain('Personal Event');
    });

    test('handleCreateEvent with scope=group creates group event', async () => {
      const gCtx = makeGroupCtx();
      const result = await handleCreateEvent(gCtx, {
        title: 'Group Meeting',
        start_at: '2026-03-15T14:00:00Z',
        scope: 'group',
        force: true,
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Group Meeting');

      const events = ctx.eventService.getEventsInRangeForGroup(
        GROUP_CHAT_ID,
        '2026-03-15T00:00:00Z',
        '2026-03-15T23:59:59Z',
      );
      expect(events.length).toBe(1);
      expect(events[0]!.event.owner_type).toBe('group');
      expect(events[0]!.event.group_id).toBe(GROUP_CHAT_ID);
      expect(events[0]!.event.created_by).toBe(USER_ID);
    });

    test('handleCreateEvent with scope=group and no group capability: event saved, agentHint flags skipped notifications', async () => {
      // Regression (issue #51): enqueueGroupNotifications silently returned 0 when
      // ctx.group/ctx.broadcast were missing, with no logging and only an existing
      // agentHint to signal the degradation. This locks the degraded-but-honest outcome.
      const gCtx = makeGroupCtx();
      expect(gCtx.group).toBeUndefined();
      expect(gCtx.broadcast).toBeUndefined();
      const result = await handleCreateEvent(gCtx, {
        title: 'No Broadcast Meeting',
        start_at: '2026-03-16T14:00:00Z',
        scope: 'group',
        force: true,
      });
      expect(result.success).toBe(true);
      expect(result.agentHint).toContain('no member notifications were queued');
    });

    test('handleUpdateEvent with scope=group updates group event', async () => {
      const event = createGroupEvent('Old Group Title', '2026-03-15T10:00:00Z');
      const gCtx = makeGroupCtx();
      const result = await handleUpdateEvent(gCtx, {
        event_id: event.id,
        title: 'New Group Title',
        scope: 'group',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('New Group Title');
    });

    test('handleDeleteEvent with scope=group deletes from group calendar', async () => {
      const event = createGroupEvent('To Delete Group', '2026-03-15T10:00:00Z');
      const gCtx = makeGroupCtx();
      approveDeletes(gCtx.user.telegram_id, gCtx.chatId, [event.id]);
      const result = await handleDeleteEvent(gCtx, { event_id: event.id, scope: 'group' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('To Delete Group');

      const found = ctx.eventService.getEventForGroup(event.id, GROUP_CHAT_ID);
      expect(found).toBeNull();
    });

    test('handleSearchEvents with scope=group searches group calendar', async () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Personal Standup',
        start_at: '2026-03-15T10:00:00Z',
        timezone: 'UTC',
      });
      createGroupEvent('Group Standup', '2026-03-15T10:00:00Z');

      const gCtx = makeGroupCtx();
      const result = await handleSearchEvents(gCtx, { query: 'Standup', scope: 'group' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Group Standup');
      expect(result.output).not.toContain('Personal Standup');
    });

    test('handleGetEvent with scope=group fetches group event', async () => {
      const event = createGroupEvent('Group Detail', '2026-03-15T10:00:00Z');
      const gCtx = makeGroupCtx();
      const result = await handleGetEvent(gCtx, { event_id: event.id, scope: 'group' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Group Detail');
    });

    test('handleGetUpcoming with scope=group returns group events', async () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Personal Soon',
        start_at: new Date(Date.now() + 3600_000).toISOString(),
        timezone: 'UTC',
      });
      createGroupEvent('Group Soon', new Date(Date.now() + 7200_000).toISOString());

      const gCtx = makeGroupCtx();
      const result = await handleGetUpcoming(gCtx, { scope: 'group' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Group Soon');
      expect(result.output).not.toContain('Personal Soon');
    });

    test('handleSnoozeEvent with scope=group snoozes group event', async () => {
      const event = createGroupEvent('Group Snooze', '2026-03-15T10:00:00Z', '2026-03-15T11:00:00Z');
      const gCtx = makeGroupCtx();
      const result = handleSnoozeEvent(gCtx, { event_id: event.id, minutes: 15, scope: 'group' });
      expect(result.success).toBe(true);
      expect(result.output).toContain('snoozed by 15 min');
    });

    test('scope defaults to group when isGroup=true and scope not specified', async () => {
      createGroupEvent('Group Default', '2026-03-15T14:00:00Z', '2026-03-15T15:00:00Z');
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Personal Default',
        start_at: '2026-03-15T14:00:00Z',
        timezone: 'UTC',
      });

      const gCtx = makeGroupCtx();
      const result = await handleGetEvents(gCtx, {
        start_date: '2026-03-15T00:00:00Z',
        end_date: '2026-03-15T23:59:59Z',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Group Default');
      expect(result.output).not.toContain('Personal Default');
    });

    test('scope defaults to personal when isGroup=false', async () => {
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Personal Visible',
        start_at: '2026-03-15T14:00:00Z',
        timezone: 'UTC',
      });

      // isGroup=false, no scope => personal path
      const result = await handleGetEvents(ctx, {
        start_date: '2026-03-15T00:00:00Z',
        end_date: '2026-03-15T23:59:59Z',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('Personal Visible');
    });

    test('handleDeleteEvent with scope=group returns error for non-existent group event', async () => {
      const gCtx = makeGroupCtx();
      const result = await handleDeleteEvent(gCtx, { event_id: 9999, scope: 'group' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('handleGetEvents includes group title and created_by in output', async () => {
      const groupChatRepo = new GroupChatRepository(db);
      groupChatRepo.upsertGroup({ chat_id: GROUP_CHAT_ID, title: 'Test Group', added_by: USER_ID });
      createGroupEvent('Team Drinks', '2026-03-15T20:00:00Z');

      const gCtx: AgentContext = {
        ...makeGroupCtx(),
        group: {
          groupChatRepo,
          groupMemberRepo: undefined as never,
          groupMemberService: undefined as never,
          checkGroupMembership: undefined as never,
        },
      };
      const result = await handleGetEvents(gCtx, {
        start_date: '2026-03-15T00:00:00Z',
        end_date: '2026-03-15T23:59:59Z',
        scope: 'group',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Team Drinks');
      expect(result.output).toContain('Test Group');
      expect(result.output).toContain('created_by');
    });

    test('handleGetEvent includes group title and created_by in output', async () => {
      const groupChatRepo = new GroupChatRepository(db);
      groupChatRepo.upsertGroup({ chat_id: GROUP_CHAT_ID, title: 'Test Group', added_by: USER_ID });
      const event = createGroupEvent('Group Detail Event', '2026-03-15T10:00:00Z');

      const gCtx: AgentContext = {
        ...makeGroupCtx(),
        group: {
          groupChatRepo,
          groupMemberRepo: undefined as never,
          groupMemberService: undefined as never,
          checkGroupMembership: undefined as never,
        },
      };
      const result = await handleGetEvent(gCtx, { event_id: event.id, scope: 'group' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Group Detail Event');
      expect(result.output).toContain('Test Group');
      expect(result.output).toContain('created_by');
    });

    function makeMemberService(memberIds: number[]): GroupMemberService {
      return { getRegisteredMembers: mock(async () => memberIds) } as Partial<GroupMemberService> as GroupMemberService;
    }

    // Collect enqueued broadcast jobs via a shared captor. Each test that
    // exercises the group-notification path wires this into ctx.broadcast so
    // we can assert on exactly what was queued for delivery.
    interface CapturedJob {
      recipientId: number;
      text: string;
      parseMode?: string;
      origin: string;
    }
    function makeCapturingBroadcast(): {
      captured: CapturedJob[];
      broadcast: { enqueue: (d: CapturedJob) => Promise<void>; enqueueBatch: (items: CapturedJob[]) => Promise<void> };
    } {
      const captured: CapturedJob[] = [];
      return {
        captured,
        broadcast: {
          enqueue: async (d) => {
            captured.push(d);
          },
          enqueueBatch: async (items) => {
            captured.push(...items);
          },
        },
      };
    }

    test('handleCreateEvent enqueues notifications for all group members including creator', async () => {
      const MEMBER_ID = 456;
      const groupMemberService = makeMemberService([USER_ID, MEMBER_ID]);
      const { captured, broadcast } = makeCapturingBroadcast();

      const mockGroupChatRepo = { findByChatId: () => null } as never;
      const gCtx: AgentContext = {
        ...makeGroupCtx(),
        group: {
          groupChatRepo: mockGroupChatRepo,
          groupMemberRepo: undefined as never,
          groupMemberService,
          checkGroupMembership: undefined as never,
        },
        broadcast,
      };
      const result = await handleCreateEvent(gCtx, {
        title: 'Party',
        start_at: '2026-03-20T18:00:00Z',
        scope: 'group',
        force: true,
      });

      expect(result.success).toBe(true);
      expect(captured.length).toBe(2);
      const chatIds = captured.map((j) => j.recipientId).sort();
      expect(chatIds).toEqual([USER_ID, MEMBER_ID].sort());
      expect(captured.every((j) => j.text.includes('Party'))).toBe(true);
      expect(captured.every((j) => j.text.includes('Test Group'))).toBe(true);
      expect(captured.every((j) => j.text.includes('18:00'))).toBe(true);
      expect(captured.every((j) => j.parseMode === 'HTML')).toBe(true);
      expect(captured.every((j) => j.origin.startsWith('group_event_created:'))).toBe(true);
    });

    test('handleCreateEvent renders notification in recipient language at enqueue time', async () => {
      const RU_MEMBER_ID = 789;
      const userRepo = ctx.userRepo as UserRepository;
      userRepo.create({ telegram_id: RU_MEMBER_ID, timezone: 'UTC', language: 'ru' });
      const groupMemberService = makeMemberService([USER_ID, RU_MEMBER_ID]);
      const { captured, broadcast } = makeCapturingBroadcast();

      await handleCreateEvent(
        {
          ...makeGroupCtx(),
          group: {
            groupChatRepo: { findByChatId: () => null } as never,
            groupMemberRepo: undefined as never,
            groupMemberService,
            checkGroupMembership: undefined as never,
          },
          broadcast,
        } as AgentContext,
        {
          title: 'Встреча',
          start_at: '2026-03-20T10:00:00Z',
          scope: 'group',
          force: true,
        },
      );

      expect(captured.length).toBe(2);
      const ruJob = captured.find((j) => j.recipientId === RU_MEMBER_ID);
      expect(ruJob?.text).toContain('Новое событие');
    });

    test('handleUpdateEvent enqueues notifications for group members on update', async () => {
      const MEMBER_ID = 456;
      const groupMemberService = makeMemberService([USER_ID, MEMBER_ID]);
      const { captured, broadcast } = makeCapturingBroadcast();

      const event = createGroupEvent('Sprint Planning', '2026-03-21T09:00:00Z');

      const result = await handleUpdateEvent(
        {
          ...makeGroupCtx(),
          group: {
            groupChatRepo: { findByChatId: () => null } as never,
            groupMemberRepo: undefined as never,
            groupMemberService,
            checkGroupMembership: undefined as never,
          },
          broadcast,
        } as AgentContext,
        {
          event_id: event.id,
          title: 'Sprint Planning Updated',
          scope: 'group',
        },
      );

      expect(result.success).toBe(true);
      expect(captured.length).toBe(2);
      const chatIds = captured.map((j) => j.recipientId).sort();
      expect(chatIds).toEqual([USER_ID, MEMBER_ID].sort());
      expect(captured.every((j) => j.text.includes('Sprint Planning Updated'))).toBe(true);
      expect(captured.every((j) => j.text.includes('Test Group'))).toBe(true);
      expect(captured.every((j) => j.parseMode === 'HTML')).toBe(true);
      expect(captured.every((j) => j.origin.startsWith('group_event_updated:'))).toBe(true);
    });

    // Centralized partial-mock factory: the Google fanout path only touches
    // groupMemberRepo, so the other GroupCapability members are supplied as a
    // partial mock per the test-only cast exception in CLAUDE.md.
    function makeGroupCapability(overrides: Partial<GroupCapability>): GroupCapability {
      return overrides as unknown as GroupCapability;
    }

    test('handleUpdateEvent (group) skips declined members in Google fanout, pushes undecided members', async () => {
      const DECLINED_MEMBER = 501;
      const PENDING_MEMBER = 502;
      const NO_ROW_MEMBER = 503;

      const event = createGroupEvent('Quarterly Review', '2026-03-22T09:00:00Z');

      const groupMemberRepo = new GroupMemberRepository(db);
      groupMemberRepo.upsert(GROUP_CHAT_ID, USER_ID);
      groupMemberRepo.upsert(GROUP_CHAT_ID, DECLINED_MEMBER);
      groupMemberRepo.upsert(GROUP_CHAT_ID, PENDING_MEMBER);
      groupMemberRepo.upsert(GROUP_CHAT_ID, NO_ROW_MEMBER);

      // RSVP state: one explicitly declined, one tapped-but-not-declined,
      // one who never tapped anything (no participant row at all).
      const participantRepo = new ParticipantRepository(db);
      participantRepo.add(event.id, DECLINED_MEMBER, 'declined');
      participantRepo.add(event.id, PENDING_MEMBER, 'pending');

      const pushed: { userId: number; action: string }[] = [];
      const scheduleParticipantPush = mock(
        async (userId: number, _eventId: number, action: 'create' | 'update' | 'delete') => {
          pushed.push({ userId, action });
        },
      );

      const gCtx: AgentContext = {
        ...makeGroupCtx(),
        participantRepo,
        group: makeGroupCapability({ groupMemberRepo }),
        google: { googleCalendarRepo: new GoogleCalendarRepository(db), scheduleParticipantPush },
      };

      const result = await handleUpdateEvent(gCtx, {
        event_id: event.id,
        title: 'Quarterly Review Updated',
        scope: 'group',
      });

      expect(result.success).toBe(true);
      const updatedIds = pushed.filter((p) => p.action === 'update').map((p) => p.userId);
      // Declined member's "Not going" must NOT be undone by an edit.
      expect(updatedIds).not.toContain(DECLINED_MEMBER);
      // Members who never declined still receive the edit.
      expect(updatedIds).toContain(PENDING_MEMBER);
      expect(updatedIds).toContain(NO_ROW_MEMBER);
      // Organizer is never part of the member fanout.
      expect(updatedIds).not.toContain(USER_ID);
    });

    test('handleCreateEvent uses invite link as clickable group link when available', async () => {
      const INVITE_LINK = 'https://t.me/+abc123';
      const groupChatRepo = new GroupChatRepository(db);
      groupChatRepo.upsertGroup({ chat_id: GROUP_CHAT_ID, title: 'Test Group', added_by: USER_ID });
      groupChatRepo.setInviteLink(GROUP_CHAT_ID, INVITE_LINK);

      const groupMemberService = makeMemberService([USER_ID]);
      const { captured, broadcast } = makeCapturingBroadcast();

      const gCtx: AgentContext = {
        ...makeGroupCtx(),
        group: {
          groupChatRepo,
          groupMemberRepo: undefined as never,
          groupMemberService,
          checkGroupMembership: undefined as never,
        },
        broadcast,
      };
      await handleCreateEvent(gCtx, {
        title: 'Drinks',
        start_at: '2026-03-20T19:00:00Z',
        scope: 'group',
        force: true,
      });

      expect(captured.length).toBe(1);
      expect(captured[0]!.text).toContain(`href="${INVITE_LINK}"`);
      expect(captured[0]!.text).toContain('Test Group');
    });
  });

  describe('personal scope isolation from group events', () => {
    const GROUP_ID = -100888;

    test('handleGetEvents (personal) returns group-owned events created by the user', async () => {
      db.run('INSERT INTO group_members (chat_id, user_id) VALUES (?, ?)', [GROUP_ID, USER_ID]);
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Group Drinks',
        start_at: '2026-03-18T18:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: USER_ID,
      });
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Personal Dinner',
        start_at: '2026-03-18T19:00:00Z',
        timezone: 'UTC',
      });

      const result = await handleGetEvents(ctx, {
        start_date: '2026-03-18T00:00:00Z',
        end_date: '2026-03-18T23:59:59Z',
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Personal Dinner');
      expect(result.output).toContain('Group Drinks');
    });

    test('handleGetEvents (personal) does not return group-owned events created by another user', async () => {
      const OTHER_USER = 999;
      new UserRepository(db).create({ telegram_id: OTHER_USER });
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Group Drinks By Other',
        start_at: '2026-03-18T18:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: OTHER_USER,
      });

      const result = await handleGetEvents(ctx, {
        start_date: '2026-03-18T00:00:00Z',
        end_date: '2026-03-18T23:59:59Z',
      });

      expect(result.success).toBe(true);
      expect(result.output).not.toContain('Group Drinks By Other');
    });

    test('handleDeleteEvent (personal) succeeds for group-owned events created by the user', async () => {
      db.run('INSERT INTO group_members (chat_id, user_id) VALUES (?, ?)', [GROUP_ID, USER_ID]);
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Group Meeting',
        start_at: '2026-03-18T10:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: USER_ID,
      });

      approveDeletes(ctx.user.telegram_id, ctx.chatId, [event.id]);
      const result = await handleDeleteEvent(ctx, { event_id: event.id });

      expect(result.success).toBe(true);
    });

    test('handleDeleteEvent (personal) refuses to delete group-owned events created by another user', async () => {
      const OTHER_USER = 998;
      new UserRepository(db).create({ telegram_id: OTHER_USER });
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Group Meeting By Other',
        start_at: '2026-03-18T10:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: OTHER_USER,
      });

      const result = await handleDeleteEvent(ctx, { event_id: event.id });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('handleSearchEvents (personal) returns group-owned events created by the user', async () => {
      db.run('INSERT INTO group_members (chat_id, user_id) VALUES (?, ?)', [GROUP_ID, USER_ID]);
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Group Planning',
        start_at: '2026-03-18T10:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: USER_ID,
      });
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Personal Planning',
        start_at: '2026-03-18T11:00:00Z',
        timezone: 'UTC',
      });

      const result = await handleSearchEvents(ctx, { query: 'Planning' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Personal Planning');
      expect(result.output).toContain('Group Planning');
    });

    test('handleSearchEvents (personal) does not return group-owned events created by another user', async () => {
      const OTHER_USER = 997;
      new UserRepository(db).create({ telegram_id: OTHER_USER });
      ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Group Planning By Other',
        start_at: '2026-03-18T10:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: OTHER_USER,
      });

      const result = await handleSearchEvents(ctx, { query: 'Planning' });

      expect(result.success).toBe(true);
      expect(result.output).not.toContain('Group Planning By Other');
    });

    test('handleUpdateEvent (personal) succeeds for group-owned events created by the user', async () => {
      db.run('INSERT INTO group_members (chat_id, user_id) VALUES (?, ?)', [GROUP_ID, USER_ID]);
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Group Meeting',
        start_at: '2026-03-18T10:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: USER_ID,
      });

      const result = await handleUpdateEvent(ctx, { event_id: event.id, title: 'Updated Group Meeting' });

      expect(result.success).toBe(true);
      expect(result.output).toContain('Updated Group Meeting');
    });

    test('handleUpdateEvent (personal) refuses to update group-owned events created by another user', async () => {
      const OTHER_USER = 996;
      new UserRepository(db).create({ telegram_id: OTHER_USER });
      const event = ctx.eventService.createEvent({
        user_id: USER_ID,
        title: 'Group Meeting By Other',
        start_at: '2026-03-18T10:00:00Z',
        timezone: 'UTC',
        owner_type: 'group',
        group_id: GROUP_ID,
        created_by: OTHER_USER,
      });

      const result = await handleUpdateEvent(ctx, { event_id: event.id, title: 'Tampered' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });
});
