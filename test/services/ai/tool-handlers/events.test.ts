// event tool handlers: get/create/update/delete/search for the personal calendar and location output.
import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { CalendarProposalRepository } from '../../../../src/database/repositories/calendar-proposal.repository.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { SecretaryRepository } from '../../../../src/database/repositories/secretary.repository.ts';
import { UserRepository } from '../../../../src/database/repositories/user.repository.ts';
import { approveDeletes } from '../../../../src/services/ai/delete-confirmation.ts';
import {
  handleCreateEvent,
  handleDeleteEvent,
  handleGetEvent,
  handleGetEvents,
  handleGetUpcoming,
  handleSearchEvents,
  handleUpdateEvent,
} from '../../../../src/services/ai/tool-handlers/events.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { localToGoogle } from '../../../../src/services/google/event-mapper.ts';
import { generateIcs } from '../../../../src/services/ics/generator.ts';
import { buildUserSessionInvitationText } from '../../../../src/services/telegram-session/invitation-text.ts';
import { createEventToolFixture, type EventToolFixture, USER_ID } from './events-fixtures.ts';

describe('event tool handlers', () => {
  let db: EventToolFixture['db'];
  let ctx: AgentContext;

  beforeEach(() => {
    ({ db, ctx } = createEventToolFixture());
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
});
