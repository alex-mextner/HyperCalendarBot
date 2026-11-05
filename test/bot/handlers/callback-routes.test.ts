import { describe, expect, mock, test } from 'bun:test';
import { createCallbackHandler } from '../../../src/bot/handlers/callback.handler';
import { describePictureContract, gatedDelivery } from '../../fixtures/picture-contract.ts';

function makeCtx(data: string, language = 'en', extras: { chat?: unknown; message?: unknown } = {}) {
  return {
    id: 'cb-1',
    data,
    dbUser: { telegram_id: 100, language, timezone: 'UTC' },
    chat: extras.chat,
    message: extras.message,
    answer: mock(() => Promise.resolve()),
    editText: mock(() => Promise.resolve()),
    send: mock(() => Promise.resolve()),
    bot: { api: { pinChatMessage: mock(() => Promise.resolve()), sendMessage: mock(() => Promise.resolve()) } },
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
    imageDelivery?: unknown;
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
      imageDelivery: overrides.imageDelivery as never,
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

/** A tapped message whose sends are recorded: photos, documents and texts (notes). */
function makeTappedMessage() {
  const texts: string[] = [];
  let photos = 0;
  return {
    message: {
      chat: { id: 100, type: 'private' },
      sendPhoto: mock(() => {
        photos++;
        return Promise.resolve({ id: 5 });
      }),
      sendDocument: mock(() => {
        photos++;
        return Promise.resolve({ id: 6 });
      }),
      send: mock((text: string) => {
        texts.push(text);
        return Promise.resolve();
      }),
    },
    photos: () => photos,
    texts: () => [...texts],
  };
}

describe('IMG_DAILY callback', () => {
  const holidayService = { getHolidaysForDate: mock(() => []) };

  test('answers the tap at once, queues the picture and delivers it when the render ends', async () => {
    const eventService = makeEventService({ getEventsForDay: mock(() => []) });
    const { delivery, renderer, release } = gatedDelivery();
    const tapped = makeTappedMessage();
    const ctx = makeCtx('imd:2026-03-15', 'en', { message: tapped.message });
    const handler = makeHandler({ eventService, holidayService, imageDelivery: delivery });

    await handler(ctx as never);

    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(renderer.renderDirect).toHaveBeenCalledTimes(1);
    expect(tapped.photos()).toBe(0); // the handler returned while the render is pending

    release();
    await delivery.whenIdle();

    expect(tapped.photos()).toBe(1);
    expect(tapped.texts()).toEqual([]);
  });

  test('a render failure sends one note naming the day', async () => {
    const eventService = makeEventService({ getEventsForDay: mock(() => []) });
    const { delivery, fail, failures } = gatedDelivery();
    const tapped = makeTappedMessage();
    const ctx = makeCtx('imd:2026-03-15', 'en', { message: tapped.message });
    const handler = makeHandler({ eventService, holidayService, imageDelivery: delivery });

    await handler(ctx as never);
    fail(new Error('render boom'));
    await delivery.whenIdle();

    expect(tapped.texts()).toHaveLength(1);
    expect(tapped.texts()[0]).toContain('2026-03-15');
    expect(failures).toHaveLength(1);
  });

  test('missing message context fails closed before event selection or rendering', async () => {
    const eventService = makeEventService({ getEventsForDay: mock(() => []) });
    const { delivery, renderer } = gatedDelivery();
    const ctx = makeCtx('imd:2026-03-15', 'en');
    const handler = makeHandler({ eventService, holidayService, imageDelivery: delivery });
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(eventService.getEventsForDay).not.toHaveBeenCalled();
    expect(eventService.getEventsInRange).not.toHaveBeenCalled();
    expect(renderer.renderDirect).not.toHaveBeenCalled();
  });

  test('no image delivery skips IMG_DAILY', async () => {
    const ctx = makeCtx('imd:2026-03-15');
    const handler = makeHandler();
    await handler(ctx as never);
    // Falls through to unknown action warning + answer
    expect(ctx.answer).toHaveBeenCalled();
  });

  describePictureContract('IMG_DAILY', () => {
    const tapped = makeTappedMessage();
    return {
      run: (delivery, requestId) => {
        const ctx = makeCtx('imd:2026-03-15', 'en', { message: tapped.message });
        const handler = makeHandler({
          eventService: makeEventService({ getEventsForDay: mock(() => []) }),
          holidayService,
          imageDelivery: delivery,
        });
        return handler({ ...ctx, id: `cb-${requestId}` } as never);
      },
      photos: tapped.photos,
      texts: tapped.texts,
    };
  });
});

// ── IMG_WEEKLY ──

describe('IMG_WEEKLY callback', () => {
  test('answers the tap at once, queues the picture and delivers it when the render ends', async () => {
    const eventService = makeEventService({ getEventsInRange: mock(() => []) });
    const { delivery, renderer, release } = gatedDelivery();
    const tapped = makeTappedMessage();
    const ctx = makeCtx('imw:2026-03-09', 'en', { message: tapped.message });
    const handler = makeHandler({ eventService, imageDelivery: delivery });

    await handler(ctx as never);

    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(renderer.renderDirect).toHaveBeenCalledTimes(1);
    expect(tapped.photos()).toBe(0);

    release();
    await delivery.whenIdle();

    expect(tapped.photos()).toBe(1);
  });

  test('a render failure sends one note', async () => {
    const eventService = makeEventService({ getEventsInRange: mock(() => []) });
    const { delivery, fail } = gatedDelivery();
    const tapped = makeTappedMessage();
    const ctx = makeCtx('imw:2026-03-09', 'en', { message: tapped.message });
    const handler = makeHandler({ eventService, imageDelivery: delivery });

    await handler(ctx as never);
    fail(new Error('render boom'));
    await delivery.whenIdle();

    expect(tapped.texts()).toHaveLength(1);
    expect(tapped.texts()[0]).toContain('could not prepare the picture');
  });

  test('missing message context fails closed before event selection or rendering', async () => {
    const eventService = makeEventService({ getEventsInRange: mock(() => []) });
    const { delivery, renderer } = gatedDelivery();
    const ctx = makeCtx('imw:2026-03-09', 'en');
    const handler = makeHandler({ eventService, imageDelivery: delivery });
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(eventService.getEventsForDay).not.toHaveBeenCalled();
    expect(eventService.getEventsInRange).not.toHaveBeenCalled();
    expect(renderer.renderDirect).not.toHaveBeenCalled();
  });

  test('no image delivery skips IMG_WEEKLY', async () => {
    const ctx = makeCtx('imw:2026-03-09');
    const handler = makeHandler();
    await handler(ctx as never);
    expect(ctx.answer).toHaveBeenCalled();
  });

  describePictureContract('IMG_WEEKLY', () => {
    const tapped = makeTappedMessage();
    return {
      run: (delivery, requestId) => {
        const ctx = makeCtx('imw:2026-03-09', 'en', { message: tapped.message });
        const handler = makeHandler({
          eventService: makeEventService({ getEventsInRange: mock(() => []) }),
          imageDelivery: delivery,
        });
        return handler({ ...ctx, id: `cb-${requestId}` } as never);
      },
      photos: tapped.photos,
      texts: tapped.texts,
    };
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
