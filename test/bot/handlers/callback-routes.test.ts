import { describe, expect, mock, test } from 'bun:test';
import { InlineKeyboard } from 'gramio';
import { createCallbackHandler } from '../../../src/bot/handlers/callback.handler';
import { t } from '../../../src/config/constants.ts';
import type { GoogleCalendar } from '../../../src/database/types.ts';
import { png } from '../../fixtures/png.ts';

function makeCtx(data: string, language = 'en', extras: { chat?: unknown; message?: unknown } = {}) {
  return {
    data,
    dbUser: { telegram_id: 100, language, timezone: 'UTC' },
    chat: extras.chat,
    message: extras.message,
    answer: mock(() => Promise.resolve()),
    editText: mock(() => Promise.resolve()),
    send: mock(() => Promise.resolve()),
  };
}

function makeEventService(overrides: { [key: string]: unknown } = {}) {
  return {
    getEvent: mock(() => null),
    getEventsForDay: mock(() => []),
    getEventsInRange: mock(() => []),
    editOccurrence: mock(() => null),
    splitRecurrence: mock(() => null),
    cancelOccurrence: mock(() => undefined),
    deleteFuture: mock(() => undefined),
    ...overrides,
  };
}

function makeHandler(
  overrides: {
    eventService?: { [key: string]: unknown };
    editValueScene?: unknown;
    holidayService?: unknown;
    prefsService?: unknown;
    calendarRepo?: unknown;
    disconnectDeps?: unknown;
    onCalendarsDone?: unknown;
    renderService?: unknown;
    invitationService?: unknown;
    eventRepo?: unknown;
  } = {},
) {
  return createCallbackHandler(
    (overrides.eventService ?? makeEventService()) as never,
    (overrides.editValueScene ?? {}) as never,
    (overrides.holidayService ?? {}) as never,
    (overrides.prefsService ?? {}) as never,
    {
      calendarRepo: overrides.calendarRepo as never,
      disconnectDeps: overrides.disconnectDeps as never,
      onCalendarsDone: overrides.onCalendarsDone as never,
      renderService: overrides.renderService as never,
      invitationService: overrides.invitationService as never,
      eventRepo: overrides.eventRepo as never,
    },
  );
}

// ── EVENT_VIEW ──

describe('EVENT_VIEW callback', () => {
  test('cancel payload edits text to closed', async () => {
    const ctx = makeCtx('ev:cancel');
    const handler = makeHandler();
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalledWith('❌ Closed');
  });

  test('event not found returns answer with Not found', async () => {
    const eventService = makeEventService({ getEvent: mock(() => null) });
    const ctx = makeCtx('ev:42');
    const handler = makeHandler({ eventService });
    await handler(ctx as never);
    expect(eventService.getEvent).toHaveBeenCalledWith(42, 100);
    expect(ctx.answer).toHaveBeenCalledWith({ text: 'Not found' });
  });

  test('event found shows detail with actions keyboard', async () => {
    const eventService = makeEventService({
      getEvent: mock(() => ({
        id: 42,
        title: 'Standup',
        start_at: '2026-03-15T10:00:00Z',
        end_at: '2026-03-15T10:30:00Z',
        description: null,
        location: null,
        recurrence_rule: null,
        user_id: 100,
      })),
    });
    const ctx = makeCtx('ev:42');
    const handler = makeHandler({ eventService });
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalled();
    const callArgs = ctx.editText.mock.calls[0] as unknown[];
    expect(callArgs[0]).toContain('Standup');
    const opts = callArgs[1] as { parse_mode: string; reply_markup: unknown };
    expect(opts.parse_mode).toBe('HTML');
    expect(opts.reply_markup).toBeDefined();
  });
});

// ── EVENT_EDIT ──

describe('EVENT_EDIT callback', () => {
  test('cancel payload edits text to edit cancelled', async () => {
    const ctx = makeCtx('ee:cancel');
    const handler = makeHandler();
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalledWith('❌ Edit cancelled');
  });

  test('one-off event delegates to handleEditCallback', async () => {
    const eventService = makeEventService({
      getEvent: mock(() => ({
        id: 42,
        title: 'Meeting',
        start_at: '2026-03-15T10:00:00Z',
        end_at: null,
        recurrence_rule: null,
      })),
    });
    const ctx = makeCtx('ee:42');
    const handler = makeHandler({ eventService });
    // Should not throw — delegates to handleEditCallback
    await handler(ctx as never);
    expect(eventService.getEvent).toHaveBeenCalledWith(42, 100);
  });

  test('recurring event with occurrence date delegates correctly', async () => {
    const eventService = makeEventService({
      getEvent: mock(() => ({
        id: 42,
        title: 'Daily',
        start_at: '2026-03-10T10:00:00Z',
        recurrence_rule: 'FREQ=DAILY',
      })),
    });
    const ctx = makeCtx('ee:42:2026-03-15T10:00:00Z');
    const handler = makeHandler({ eventService });
    await handler(ctx as never);
    expect(eventService.getEvent).toHaveBeenCalledWith(42, 100);
  });
});

// ── EDIT_FIELD ──

describe('EDIT_FIELD callback', () => {
  test('cancel in event id position edits text to edit cancelled', async () => {
    const ctx = makeCtx('ef:cancel');
    const handler = makeHandler();
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalledWith('❌ Edit cancelled');
  });

  test('cancel as field name edits text to edit cancelled', async () => {
    const ctx = makeCtx('ef:42:cancel');
    const handler = makeHandler();
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalledWith('❌ Edit cancelled');
  });
});

// ── EVENT_DELETE ──

describe('EVENT_DELETE callback', () => {
  test('cancel payload edits text to deletion cancelled', async () => {
    const ctx = makeCtx('ed:cancel');
    const handler = makeHandler();
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalledWith('❌ Deletion cancelled');
  });

  test('one-off event delegates to handleDeleteCallback', async () => {
    const eventService = makeEventService({
      getEvent: mock(() => ({
        id: 42,
        title: 'Meeting',
        start_at: '2026-03-15T10:00:00Z',
        recurrence_rule: null,
      })),
    });
    const ctx = makeCtx('ed:42');
    const handler = makeHandler({ eventService });
    await handler(ctx as never);
    expect(eventService.getEvent).toHaveBeenCalledWith(42, 100);
  });

  test('recurring event with occurrence date delegates correctly', async () => {
    const eventService = makeEventService({
      getEvent: mock(() => ({
        id: 42,
        title: 'Daily',
        start_at: '2026-03-10T10:00:00Z',
        recurrence_rule: 'FREQ=DAILY',
      })),
    });
    const ctx = makeCtx('ed:42:2026-03-15T10:00:00Z');
    const handler = makeHandler({ eventService });
    await handler(ctx as never);
    expect(eventService.getEvent).toHaveBeenCalledWith(42, 100);
  });
});

// ── EVENT_DELETE_CONFIRM ──

describe('EVENT_DELETE_CONFIRM callback', () => {
  test('delegates to handleDeleteConfirmCallback', async () => {
    const eventService = makeEventService({
      getEvent: mock(() => ({
        id: 42,
        title: 'Meeting',
      })),
      deleteEvent: mock(() => true),
    });
    const ctx = makeCtx('edc:42');
    const handler = makeHandler({ eventService });
    await handler(ctx as never);
  });
});

// ── MONTH_NAV ──

describe('MONTH_NAV callback', () => {
  test('answers and delegates to handleMonth', async () => {
    const eventService = makeEventService({
      getEventsForMonth: mock(() => []),
    });
    const ctx = makeCtx('mn:2026-03');
    const handler = makeHandler({ eventService });
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
  });
});

// ── NOTIFY ──

describe('NOTIFY callback', () => {
  test('delegates to handleNotifyCallback with payload', async () => {
    const prefsService = {
      getOrCreate: mock(() => ({
        morning_agenda_enabled: 1,
        morning_agenda_time: '08:00',
        evening_review_enabled: 0,
        evening_review_time: '21:00',
        quiet_hours_enabled: 0,
        quiet_hours_start: '23:00',
        quiet_hours_end: '07:00',
        default_reminder_intervals: '[15]',
      })),
    };
    const ctx = makeCtx('nf:menu');
    const handler = makeHandler({ prefsService });
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
  });
});

// ── HOLIDAYS ──

describe('HOLIDAYS callback', () => {
  test('delegates to handleHolidayCallback', async () => {
    const holidayService = {
      getRegions: mock(() => []),
      getSubscriptions: mock(() => []),
    };
    const ctx = makeCtx('hl:menu');
    const handler = makeHandler({ holidayService });
    await handler(ctx as never);
  });
});

// ── GCAL ──

describe('GCAL callback', () => {
  test('gcal cal open acknowledges before sending the real calendar picker', async () => {
    const calendars: GoogleCalendar[] = [
      {
        id: 7,
        user_id: 100,
        google_calendar_id: 'synthetic-calendar@example.invalid',
        calendar_name: 'Synthetic Work',
        color: null,
        is_primary: 1,
        sync_enabled: 1,
        access_role: 'owner',
        sync_token: null,
        last_synced_at: null,
        created_at: '2030-01-01T00:00:00Z',
        updated_at: '2030-01-01T00:00:00Z',
      },
    ];
    const calendarRepo = { getCalendars: mock(() => calendars) };
    const operations: string[] = [];
    const answer = mock(async () => {
      operations.push('answer');
    });
    const send = mock(async (_text: string, _options: { reply_markup: InlineKeyboard }) => {
      operations.push('send');
    });
    const ctx = { ...makeCtx('gc:cal:open'), answer, send };
    await makeHandler({ calendarRepo })(ctx as never);

    expect(calendarRepo.getCalendars).toHaveBeenCalledWith(100);
    expect(operations).toEqual(['answer', 'send']);
    expect(answer).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    const sent = send.mock.calls[0]!;
    expect(sent[0]).toBe(t('en').gcal_calendar_picker);
    expect(sent[1].reply_markup).toBeInstanceOf(InlineKeyboard);
    const buttons = sent[1].reply_markup.toJSON().inline_keyboard.flat();
    expect(buttons).toContainEqual({ text: '✅ 📅 Synthetic Work ★', callback_data: 'gc:cal:7' });
    expect(buttons).toContainEqual({ text: t('en').gcal_calendar_done, callback_data: 'gc:cal:done' });
  });

  test('gcal cal done sub-action delegates to handleCalendarPickerCallback', async () => {
    const calendarRepo = {
      getCalendars: mock(() => []),
      toggleSync: mock(() => undefined),
    };
    const ctx = makeCtx('gc:cal:done');
    const handler = makeHandler({ calendarRepo });
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
  });

  test('gcal disconnect yes executes disconnect', async () => {
    const disconnectDeps = {
      config: { ENCRYPTION_KEY: undefined },
      oauthService: { revokeToken: mock(() => Promise.resolve()) },
      userRepo: {
        findByTelegramId: mock(() => null),
        clearGoogleToken: mock(() => undefined),
      },
      eventRepo: { clearGoogleSync: mock(() => undefined) },
      syncRepo: { deleteSyncState: mock(() => undefined) },
      calendarRepo: {
        deleteWatchChannelsForUser: mock(() => undefined),
        deleteUserCalendars: mock(() => undefined),
      },
    };
    const ctx = makeCtx('gc:disconnect:yes');
    const handler = makeHandler({ disconnectDeps });
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalled();
  });

  test('gcal disconnect no edits text to disconnect cancelled', async () => {
    const ctx = makeCtx('gc:disconnect:no');
    const handler = makeHandler();
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalledWith('❌ Disconnection cancelled');
  });

  test('gcal onboard later deletes message', async () => {
    const deleteFn = mock(() => Promise.resolve());
    const ctx = makeCtx('gc:onboard:later', 'en', {
      message: { delete: deleteFn },
    });
    const handler = makeHandler();
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
    expect(deleteFn).toHaveBeenCalled();
  });

  test('gcal onboard connect shows answer', async () => {
    const ctx = makeCtx('gc:onboard:connect');
    const handler = makeHandler();
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
  });
});

// ── IMG_DAILY ──

describe('IMG_DAILY callback', () => {
  test('renders daily image and sends photo', async () => {
    const sendPhoto = mock(() => Promise.resolve());
    const eventService = makeEventService({
      getEventsForDay: mock(() => []),
    });
    const holidayService = {
      getHolidaysForDate: mock(() => []),
    };
    const renderService = {
      renderDirect: mock(() => Promise.resolve(png())),
    };
    const ctx = makeCtx('imd:2026-03-15', 'en', {
      message: { chat: { id: 100, type: 'private' }, sendPhoto, send: mock(() => Promise.resolve()) },
    });
    const handler = makeHandler({ eventService, holidayService, renderService });
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
    expect(renderService.renderDirect).toHaveBeenCalled();
    expect(sendPhoto).toHaveBeenCalled();
  });

  test('render failure sends error message', async () => {
    const sendFn = mock(() => Promise.resolve());
    const eventService = makeEventService({
      getEventsForDay: mock(() => []),
    });
    const holidayService = {
      getHolidaysForDate: mock(() => []),
    };
    const renderService = {
      renderDirect: mock(() => Promise.reject(new Error('render boom'))),
    };
    const ctx = makeCtx('imd:2026-03-15', 'en', {
      message: { chat: { id: 100, type: 'private' }, sendPhoto: mock(() => Promise.resolve()), send: sendFn },
    });
    const handler = makeHandler({ eventService, holidayService, renderService });
    await handler(ctx as never);
    expect(sendFn).toHaveBeenCalled();
    const msg = (sendFn.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('failed');
  });

  test('missing message context fails closed before event selection or rendering', async () => {
    const eventService = makeEventService({
      getEventsForDay: mock(() => []),
    });
    const holidayService = {
      getHolidaysForDate: mock(() => []),
    };
    const renderService = {
      renderDirect: mock(() => Promise.reject(new Error('boom'))),
    };
    const ctx = makeCtx('imd:2026-03-15', 'en');
    const handler = makeHandler({ eventService, holidayService, renderService });
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(eventService.getEventsForDay).not.toHaveBeenCalled();
    expect(eventService.getEventsInRange).not.toHaveBeenCalled();
    expect(renderService.renderDirect).not.toHaveBeenCalled();
  });

  test('no renderService skips IMG_DAILY', async () => {
    const ctx = makeCtx('imd:2026-03-15');
    const handler = makeHandler();
    await handler(ctx as never);
    // Falls through to unknown action warning + answer
    expect(ctx.answer).toHaveBeenCalled();
  });
});

// ── IMG_WEEKLY ──

describe('IMG_WEEKLY callback', () => {
  test('renders weekly image and sends photo', async () => {
    const sendPhoto = mock(() => Promise.resolve());
    const eventService = makeEventService({
      getEventsInRange: mock(() => []),
    });
    const renderService = {
      renderDirect: mock(() => Promise.resolve(png())),
    };
    const ctx = makeCtx('imw:2026-03-09', 'en', {
      message: { chat: { id: 100, type: 'private' }, sendPhoto, send: mock(() => Promise.resolve()) },
    });
    const handler = makeHandler({ eventService, renderService });
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
    expect(renderService.renderDirect).toHaveBeenCalled();
    expect(sendPhoto).toHaveBeenCalled();
  });

  test('render failure sends error message', async () => {
    const sendFn = mock(() => Promise.resolve());
    const eventService = makeEventService({
      getEventsInRange: mock(() => []),
    });
    const renderService = {
      renderDirect: mock(() => Promise.reject(new Error('render boom'))),
    };
    const ctx = makeCtx('imw:2026-03-09', 'en', {
      message: { chat: { id: 100, type: 'private' }, sendPhoto: mock(() => Promise.resolve()), send: sendFn },
    });
    const handler = makeHandler({ eventService, renderService });
    await handler(ctx as never);
    expect(sendFn).toHaveBeenCalled();
    const msg = (sendFn.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('failed');
  });

  test('missing message context fails closed before event selection or rendering', async () => {
    const eventService = makeEventService({
      getEventsInRange: mock(() => []),
    });
    const renderService = {
      renderDirect: mock(() => Promise.reject(new Error('boom'))),
    };
    const ctx = makeCtx('imw:2026-03-09', 'en');
    const handler = makeHandler({ eventService, renderService });
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(eventService.getEventsForDay).not.toHaveBeenCalled();
    expect(eventService.getEventsInRange).not.toHaveBeenCalled();
    expect(renderService.renderDirect).not.toHaveBeenCalled();
  });

  test('no renderService skips IMG_WEEKLY', async () => {
    const ctx = makeCtx('imw:2026-03-09');
    const handler = makeHandler();
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
  });
});

// ── Unknown action ──

describe('unknown callback action', () => {
  test('answers without error', async () => {
    const ctx = makeCtx('unknown_action:whatever');
    const handler = makeHandler();
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
  });
});

// ── Empty data ──

describe('empty callback data', () => {
  test('returns early for empty data', async () => {
    const ctx = makeCtx('');
    const handler = makeHandler();
    await handler(ctx as never);
    expect(ctx.answer).not.toHaveBeenCalled();
  });
});

// ── Error handling ──

describe('error handling', () => {
  test('message not modified error is silently acknowledged', async () => {
    const eventService = makeEventService({
      getEvent: mock(() => {
        throw new Error('message is not modified');
      }),
    });
    const ctx = makeCtx('ev:42');
    const handler = makeHandler({ eventService });
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
  });

  test('generic error answers with Error', async () => {
    const eventService = makeEventService({
      getEvent: mock(() => {
        throw new Error('something broke');
      }),
    });
    const ctx = makeCtx('ev:42');
    const handler = makeHandler({ eventService });
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalledWith({ text: 'Error' });
  });
});
