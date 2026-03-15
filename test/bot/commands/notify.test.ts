import { describe, expect, mock, test } from 'bun:test';

const user = { telegram_id: 100, language: 'en' as const, timezone: 'UTC' };
const userRu = { telegram_id: 100, language: 'ru' as const, timezone: 'UTC' };

function defaultPrefs() {
  return {
    user_id: 100,
    morning_agenda_enabled: 0,
    morning_agenda_time: '08:00',
    morning_agenda_utc: '08:00',
    morning_agenda_format: 'text',
    default_reminder_intervals: '[15]',
    evening_review_enabled: 0,
    evening_review_time: '21:00',
    evening_review_utc: '21:00',
    evening_review_format: 'text',
    quiet_hours_enabled: 0,
    quiet_hours_start: '23:00',
    quiet_hours_end: '07:00',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

function makeCommandCtx(overrides = {}) {
  return {
    dbUser: user,
    send: mock(() => Promise.resolve()),
    ...overrides,
  };
}

function makeCallbackCtx(overrides = {}) {
  return {
    dbUser: user,
    answer: mock(() => Promise.resolve()),
    editText: mock(() => Promise.resolve()),
    ...overrides,
  };
}

function makePrefsService(overrides: Record<string, unknown> = {}) {
  return {
    getOrCreate: mock(() => defaultPrefs()),
    toggleMorningAgenda: mock(() => {}),
    updateMorningTime: mock(() => {}),
    toggleEveningReview: mock(() => {}),
    updateEveningTime: mock(() => {}),
    resolveDefaultIntervals: mock(() => [15]),
    updateDefaultIntervals: mock(() => {}),
    toggleQuietHours: mock(() => {}),
    updateQuietHoursStart: mock(() => {}),
    updateQuietHoursEnd: mock(() => {}),
    ...overrides,
  };
}

describe('handleNotify', () => {
  test('sends notification settings menu', async () => {
    const { handleNotify } = await import('../../../src/bot/commands/notify.ts');
    const ctx = makeCommandCtx();
    const svc = makePrefsService();

    await handleNotify(ctx as never, svc as never);

    expect(ctx.send).toHaveBeenCalledTimes(1);
    const args = ctx.send.mock.calls[0] as unknown[];
    const msg = args[0] as string;
    expect(msg).toContain('Notification Settings');
    expect(args[1]).toHaveProperty('reply_markup');
  });

  test('sends menu in russian', async () => {
    const { handleNotify } = await import('../../../src/bot/commands/notify.ts');
    const ctx = makeCommandCtx({ dbUser: userRu });
    const svc = makePrefsService();

    await handleNotify(ctx as never, svc as never);

    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Настройки уведомлений');
  });

  test('shows morning and evening status', async () => {
    const { handleNotify } = await import('../../../src/bot/commands/notify.ts');
    const ctx = makeCommandCtx();
    const svc = makePrefsService();

    await handleNotify(ctx as never, svc as never);

    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Morning agenda');
    expect(msg).toContain('Evening review');
  });
});

describe('handleNotifyCallback', () => {
  test('menu returns to main menu', async () => {
    const { handleNotifyCallback } = await import('../../../src/bot/commands/notify.ts');
    const ctx = makeCallbackCtx();
    const svc = makePrefsService();

    await handleNotifyCallback(ctx as never, svc as never, user as never, 'menu');

    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalled();
    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Notification Settings');
  });

  test('morning without action shows morning section', async () => {
    const { handleNotifyCallback } = await import('../../../src/bot/commands/notify.ts');
    const ctx = makeCallbackCtx();
    const svc = makePrefsService();

    await handleNotifyCallback(ctx as never, svc as never, user as never, 'morning');

    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalled();
    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Morning Agenda');
  });

  test('morning:toggle toggles morning agenda', async () => {
    const { handleNotifyCallback } = await import('../../../src/bot/commands/notify.ts');
    const ctx = makeCallbackCtx();
    const svc = makePrefsService();

    await handleNotifyCallback(ctx as never, svc as never, user as never, 'morning:toggle');

    expect(svc.toggleMorningAgenda).toHaveBeenCalledWith(100);
    expect(ctx.answer).toHaveBeenCalled();
  });

  test('morning:time shows hour picker', async () => {
    const { handleNotifyCallback } = await import('../../../src/bot/commands/notify.ts');
    const ctx = makeCallbackCtx();
    const svc = makePrefsService();

    await handleNotifyCallback(ctx as never, svc as never, user as never, 'morning:time');

    expect(ctx.editText).toHaveBeenCalled();
    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Pick hour');
  });

  test('morning:hour shows minute picker', async () => {
    const { handleNotifyCallback } = await import('../../../src/bot/commands/notify.ts');
    const ctx = makeCallbackCtx();
    const svc = makePrefsService();

    await handleNotifyCallback(ctx as never, svc as never, user as never, 'morning:hour:08');

    expect(ctx.editText).toHaveBeenCalled();
    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Pick minute');
  });

  test('morning:minute sets time', async () => {
    const { handleNotifyCallback } = await import('../../../src/bot/commands/notify.ts');
    const ctx = makeCallbackCtx();
    const svc = makePrefsService();

    await handleNotifyCallback(ctx as never, svc as never, user as never, 'morning:minute:08:30');

    expect(svc.updateMorningTime).toHaveBeenCalledWith(100, '08:30', 'UTC');
    expect(ctx.answer).toHaveBeenCalled();
  });

  test('evening without action shows evening section', async () => {
    const { handleNotifyCallback } = await import('../../../src/bot/commands/notify.ts');
    const ctx = makeCallbackCtx();
    const svc = makePrefsService();

    await handleNotifyCallback(ctx as never, svc as never, user as never, 'evening');

    expect(ctx.editText).toHaveBeenCalled();
    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Evening Review');
  });

  test('evening:toggle toggles evening review', async () => {
    const { handleNotifyCallback } = await import('../../../src/bot/commands/notify.ts');
    const ctx = makeCallbackCtx();
    const svc = makePrefsService();

    await handleNotifyCallback(ctx as never, svc as never, user as never, 'evening:toggle');

    expect(svc.toggleEveningReview).toHaveBeenCalledWith(100);
  });

  test('evening:time shows hour picker', async () => {
    const { handleNotifyCallback } = await import('../../../src/bot/commands/notify.ts');
    const ctx = makeCallbackCtx();
    const svc = makePrefsService();

    await handleNotifyCallback(ctx as never, svc as never, user as never, 'evening:time');

    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Pick hour');
  });

  test('evening:hour shows minute picker', async () => {
    const { handleNotifyCallback } = await import('../../../src/bot/commands/notify.ts');
    const ctx = makeCallbackCtx();
    const svc = makePrefsService();

    await handleNotifyCallback(ctx as never, svc as never, user as never, 'evening:hour:20');

    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Pick minute');
  });

  test('evening:minute sets time', async () => {
    const { handleNotifyCallback } = await import('../../../src/bot/commands/notify.ts');
    const ctx = makeCallbackCtx();
    const svc = makePrefsService();

    await handleNotifyCallback(ctx as never, svc as never, user as never, 'evening:minute:21:00');

    expect(svc.updateEveningTime).toHaveBeenCalledWith(100, '21:00', 'UTC');
  });

  test('reminders without action shows intervals menu', async () => {
    const { handleNotifyCallback } = await import('../../../src/bot/commands/notify.ts');
    const ctx = makeCallbackCtx();
    const svc = makePrefsService();

    await handleNotifyCallback(ctx as never, svc as never, user as never, 'reminders');

    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalled();
    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Default Reminders');
  });

  test('reminders:toggle adds interval', async () => {
    const { handleNotifyCallback } = await import('../../../src/bot/commands/notify.ts');
    const ctx = makeCallbackCtx();
    const svc = makePrefsService({
      ...makePrefsService(),
      resolveDefaultIntervals: mock(() => [15]),
    });

    await handleNotifyCallback(ctx as never, svc as never, user as never, 'reminders:toggle:30');

    expect(svc.updateDefaultIntervals).toHaveBeenCalledWith(100, [15, 30]);
  });

  test('reminders:toggle removes existing interval', async () => {
    const { handleNotifyCallback } = await import('../../../src/bot/commands/notify.ts');
    const ctx = makeCallbackCtx();
    const svc = makePrefsService({
      ...makePrefsService(),
      resolveDefaultIntervals: mock(() => [15, 30]),
    });

    await handleNotifyCallback(ctx as never, svc as never, user as never, 'reminders:toggle:15');

    expect(svc.updateDefaultIntervals).toHaveBeenCalledWith(100, [30]);
  });

  test('quiet without action shows quiet section', async () => {
    const { handleNotifyCallback } = await import('../../../src/bot/commands/notify.ts');
    const ctx = makeCallbackCtx();
    const svc = makePrefsService();

    await handleNotifyCallback(ctx as never, svc as never, user as never, 'quiet');

    expect(ctx.editText).toHaveBeenCalled();
    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Quiet Hours');
  });

  test('quiet:toggle toggles quiet hours', async () => {
    const { handleNotifyCallback } = await import('../../../src/bot/commands/notify.ts');
    const ctx = makeCallbackCtx();
    const svc = makePrefsService();

    await handleNotifyCallback(ctx as never, svc as never, user as never, 'quiet:toggle');

    expect(svc.toggleQuietHours).toHaveBeenCalledWith(100);
  });

  test('quiet:toggle sets defaults when enabled without start', async () => {
    const { handleNotifyCallback } = await import('../../../src/bot/commands/notify.ts');
    const ctx = makeCallbackCtx();
    const svc = makePrefsService({
      ...makePrefsService(),
      getOrCreate: mock(() => ({
        ...defaultPrefs(),
        quiet_hours_enabled: 1,
        quiet_hours_start: null,
      })),
    });

    await handleNotifyCallback(ctx as never, svc as never, user as never, 'quiet:toggle');

    expect(svc.updateQuietHoursStart).toHaveBeenCalledWith(100, '23:00');
    expect(svc.updateQuietHoursEnd).toHaveBeenCalledWith(100, '07:00');
  });

  test('quiet:start shows hour picker', async () => {
    const { handleNotifyCallback } = await import('../../../src/bot/commands/notify.ts');
    const ctx = makeCallbackCtx();
    const svc = makePrefsService();

    await handleNotifyCallback(ctx as never, svc as never, user as never, 'quiet:start');

    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Pick hour');
  });

  test('quiet:end shows hour picker', async () => {
    const { handleNotifyCallback } = await import('../../../src/bot/commands/notify.ts');
    const ctx = makeCallbackCtx();
    const svc = makePrefsService();

    await handleNotifyCallback(ctx as never, svc as never, user as never, 'quiet:end');

    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Pick hour');
  });

  test('quiet_start:hour shows minute picker', async () => {
    const { handleNotifyCallback } = await import('../../../src/bot/commands/notify.ts');
    const ctx = makeCallbackCtx();
    const svc = makePrefsService();

    await handleNotifyCallback(ctx as never, svc as never, user as never, 'quiet_start:hour:23');

    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Pick minute');
  });

  test('quiet_start:minute updates start time', async () => {
    const { handleNotifyCallback } = await import('../../../src/bot/commands/notify.ts');
    const ctx = makeCallbackCtx();
    const svc = makePrefsService();

    await handleNotifyCallback(ctx as never, svc as never, user as never, 'quiet_start:minute:22:00');

    expect(svc.updateQuietHoursStart).toHaveBeenCalledWith(100, '22:00');
  });

  test('quiet_end:minute updates end time', async () => {
    const { handleNotifyCallback } = await import('../../../src/bot/commands/notify.ts');
    const ctx = makeCallbackCtx();
    const svc = makePrefsService();

    await handleNotifyCallback(ctx as never, svc as never, user as never, 'quiet_end:minute:06:30');

    expect(svc.updateQuietHoursEnd).toHaveBeenCalledWith(100, '06:30');
  });

  test('unknown section just answers', async () => {
    const { handleNotifyCallback } = await import('../../../src/bot/commands/notify.ts');
    const ctx = makeCallbackCtx();
    const svc = makePrefsService();

    await handleNotifyCallback(ctx as never, svc as never, user as never, 'unknown_section');

    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).not.toHaveBeenCalled();
  });

  test('morning unknown action just answers', async () => {
    const { handleNotifyCallback } = await import('../../../src/bot/commands/notify.ts');
    const ctx = makeCallbackCtx();
    const svc = makePrefsService();

    await handleNotifyCallback(ctx as never, svc as never, user as never, 'morning:unknown');

    expect(ctx.answer).toHaveBeenCalled();
  });

  test('evening unknown action just answers', async () => {
    const { handleNotifyCallback } = await import('../../../src/bot/commands/notify.ts');
    const ctx = makeCallbackCtx();
    const svc = makePrefsService();

    await handleNotifyCallback(ctx as never, svc as never, user as never, 'evening:unknown');

    expect(ctx.answer).toHaveBeenCalled();
  });

  test('reminders unknown action just answers', async () => {
    const { handleNotifyCallback } = await import('../../../src/bot/commands/notify.ts');
    const ctx = makeCallbackCtx();
    const svc = makePrefsService();

    await handleNotifyCallback(ctx as never, svc as never, user as never, 'reminders:unknown');

    expect(ctx.answer).toHaveBeenCalled();
  });

  test('quiet unknown action just answers', async () => {
    const { handleNotifyCallback } = await import('../../../src/bot/commands/notify.ts');
    const ctx = makeCallbackCtx();
    const svc = makePrefsService();

    await handleNotifyCallback(ctx as never, svc as never, user as never, 'quiet:unknown');

    expect(ctx.answer).toHaveBeenCalled();
  });

  test('quiet_start unknown action just answers', async () => {
    const { handleNotifyCallback } = await import('../../../src/bot/commands/notify.ts');
    const ctx = makeCallbackCtx();
    const svc = makePrefsService();

    await handleNotifyCallback(ctx as never, svc as never, user as never, 'quiet_start:unknown');

    expect(ctx.answer).toHaveBeenCalled();
  });
});
