import { describe, expect, mock, test } from 'bun:test';

const user = { telegram_id: 100, language: 'en' as const, timezone: 'UTC' };
const userRu = { telegram_id: 100, language: 'ru' as const, timezone: 'UTC' };

function makeGroupRepo(country: string | null) {
  return {
    findByChatId: mock(() => ({
      chat_id: -100,
      country,
      timezone: null,
      title: null,
      added_by: 1,
      added_at: '',
      is_active: 1,
      pin_hint_shown: 0,
    })),
  };
}

function makeCommandCtx(overrides = {}) {
  return {
    args: null as string | null,
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

function makeHolidayService(overrides: Record<string, unknown> = {}) {
  return {
    getSubscriptions: mock(() => []),
    getCountryName: mock((code: string) => `Country-${code}`),
    getUpcomingHolidays: mock(() => []),
    getUpcomingForCountry: mock(() => [
      { date: '2026-01-01', name: 'New Year', type: 'public', countryCode: 'RU', countryName: 'Russia' },
    ]),
    getAvailableRegions: mock(() => ['Europe', 'Asia']),
    getCountriesForRegion: mock(() => [{ code: 'US', name: 'United States' }]),
    subscribeUser: mock(() => {}),
    unsubscribeUser: mock(() => {}),
    setPrimary: mock(() => {}),
    toggleNotify: mock(() => {}),
    getSubscription: mock(() => ({ country_code: 'US', is_primary: 1, notify: 1 })),
    ...overrides,
  };
}

describe('handleHolidays', () => {
  test('shows main menu when no args', async () => {
    const { handleHolidays } = await import('../../../src/bot/commands/holidays.ts');
    const ctx = makeCommandCtx();
    const svc = makeHolidayService();

    await handleHolidays(ctx as never, svc as never);

    expect(ctx.send).toHaveBeenCalledTimes(1);
    const args = ctx.send.mock.calls[0] as unknown[];
    const msg = args[0] as string;
    expect(msg).toContain('Holiday Subscriptions');
    expect(args[1]).toHaveProperty('reply_markup');
  });

  test('shows no_subs text when no subscriptions', async () => {
    const { handleHolidays } = await import('../../../src/bot/commands/holidays.ts');
    const ctx = makeCommandCtx();
    const svc = makeHolidayService();

    await handleHolidays(ctx as never, svc as never);

    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('No countries added');
  });

  test('lists subscriptions in main menu', async () => {
    const { handleHolidays } = await import('../../../src/bot/commands/holidays.ts');
    const ctx = makeCommandCtx();
    const svc = makeHolidayService({
      getSubscriptions: mock(() => [{ country_code: 'US', is_primary: true }]),
    });

    await handleHolidays(ctx as never, svc as never);

    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Country-US');
  });

  test('shows upcoming holidays with args="list"', async () => {
    const { handleHolidays } = await import('../../../src/bot/commands/holidays.ts');
    const ctx = makeCommandCtx({ args: 'list' });
    const svc = makeHolidayService({
      getUpcomingHolidays: mock(() => [{ date: '2026-03-17', name: 'St Patrick', countryName: 'Ireland' }]),
    });

    await handleHolidays(ctx as never, svc as never);

    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('St Patrick');
    expect(msg).toContain('Ireland');
  });

  test('shows none_upcoming when no holidays with args="list"', async () => {
    const { handleHolidays } = await import('../../../src/bot/commands/holidays.ts');
    const ctx = makeCommandCtx({ args: 'list' });
    const svc = makeHolidayService();

    await handleHolidays(ctx as never, svc as never);

    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('No upcoming holidays');
  });

  test('shows menu in russian', async () => {
    const { handleHolidays } = await import('../../../src/bot/commands/holidays.ts');
    const ctx = makeCommandCtx({ dbUser: userRu });
    const svc = makeHolidayService();

    await handleHolidays(ctx as never, svc as never);

    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Праздники');
  });
});

describe('handleHolidayCallback', () => {
  test('menu action edits main menu', async () => {
    const { handleHolidayCallback } = await import('../../../src/bot/commands/holidays.ts');
    const ctx = makeCallbackCtx();
    const svc = makeHolidayService();

    await handleHolidayCallback(ctx as never, svc as never, user as never, 'menu');

    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalled();
    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Holiday Subscriptions');
  });

  test('noop action only answers', async () => {
    const { handleHolidayCallback } = await import('../../../src/bot/commands/holidays.ts');
    const ctx = makeCallbackCtx();
    const svc = makeHolidayService();

    await handleHolidayCallback(ctx as never, svc as never, user as never, 'noop');

    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).not.toHaveBeenCalled();
  });

  test('add without region shows region picker', async () => {
    const { handleHolidayCallback } = await import('../../../src/bot/commands/holidays.ts');
    const ctx = makeCallbackCtx();
    const svc = makeHolidayService();

    await handleHolidayCallback(ctx as never, svc as never, user as never, 'add');

    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalled();
    expect(svc.getAvailableRegions).toHaveBeenCalled();
  });

  test('add with region shows country picker', async () => {
    const { handleHolidayCallback } = await import('../../../src/bot/commands/holidays.ts');
    const ctx = makeCallbackCtx();
    const svc = makeHolidayService();

    await handleHolidayCallback(ctx as never, svc as never, user as never, 'add:Europe');

    expect(svc.getCountriesForRegion).toHaveBeenCalledWith('Europe');
    expect(ctx.editText).toHaveBeenCalled();
  });

  test('add with region and page passes page number', async () => {
    const { handleHolidayCallback } = await import('../../../src/bot/commands/holidays.ts');
    const ctx = makeCallbackCtx();
    const svc = makeHolidayService();

    await handleHolidayCallback(ctx as never, svc as never, user as never, 'add:Asia:2');

    expect(svc.getCountriesForRegion).toHaveBeenCalledWith('Asia');
    expect(ctx.editText).toHaveBeenCalled();
  });

  test('sub subscribes and returns to main menu', async () => {
    const { handleHolidayCallback } = await import('../../../src/bot/commands/holidays.ts');
    const ctx = makeCallbackCtx();
    const svc = makeHolidayService();

    await handleHolidayCallback(ctx as never, svc as never, user as never, 'sub:US');

    expect(svc.subscribeUser).toHaveBeenCalledWith(100, 'US', true);
    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalled();
  });

  test('sub sets isPrimary=false when subs already exist', async () => {
    const { handleHolidayCallback } = await import('../../../src/bot/commands/holidays.ts');
    const ctx = makeCallbackCtx();
    const svc = makeHolidayService({
      getSubscriptions: mock(() => [{ country_code: 'DE' }]),
      getCountryName: mock((code: string) => `Country-${code}`),
    });

    await handleHolidayCallback(ctx as never, svc as never, user as never, 'sub:US');

    expect(svc.subscribeUser).toHaveBeenCalledWith(100, 'US', false);
  });

  test('manage without countryCode shows subscription list', async () => {
    const { handleHolidayCallback } = await import('../../../src/bot/commands/holidays.ts');
    const ctx = makeCallbackCtx();
    const svc = makeHolidayService({
      getSubscriptions: mock(() => [{ country_code: 'US', is_primary: 1 }]),
      getCountryName: mock((code: string) => `Country-${code}`),
    });

    await handleHolidayCallback(ctx as never, svc as never, user as never, 'manage');

    expect(ctx.editText).toHaveBeenCalled();
  });

  test('manage without subs shows no_subs', async () => {
    const { handleHolidayCallback } = await import('../../../src/bot/commands/holidays.ts');
    const ctx = makeCallbackCtx();
    const svc = makeHolidayService();

    await handleHolidayCallback(ctx as never, svc as never, user as never, 'manage');

    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('No countries added');
  });

  test('manage with countryCode shows country management', async () => {
    const { handleHolidayCallback } = await import('../../../src/bot/commands/holidays.ts');
    const ctx = makeCallbackCtx();
    const svc = makeHolidayService();

    await handleHolidayCallback(ctx as never, svc as never, user as never, 'manage:US');

    expect(svc.getSubscription).toHaveBeenCalledWith(100, 'US');
    expect(ctx.editText).toHaveBeenCalled();
    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toBe('Country-US');
  });

  test('manage with countryCode shows no_subs when not subscribed', async () => {
    const { handleHolidayCallback } = await import('../../../src/bot/commands/holidays.ts');
    const ctx = makeCallbackCtx();
    const svc = makeHolidayService({
      getSubscription: mock(() => null),
      getCountryName: mock((code: string) => `Country-${code}`),
    });

    await handleHolidayCallback(ctx as never, svc as never, user as never, 'manage:FR');

    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('No countries added');
  });

  test('primary sets primary and shows list', async () => {
    const { handleHolidayCallback } = await import('../../../src/bot/commands/holidays.ts');
    const ctx = makeCallbackCtx();
    const svc = makeHolidayService({
      getSubscriptions: mock(() => [{ country_code: 'US', is_primary: 1 }]),
      getCountryName: mock((code: string) => `Country-${code}`),
    });

    await handleHolidayCallback(ctx as never, svc as never, user as never, 'primary:US');

    expect(svc.setPrimary).toHaveBeenCalledWith(100, 'US');
    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalled();
  });

  test('remove unsubscribes and returns to menu', async () => {
    const { handleHolidayCallback } = await import('../../../src/bot/commands/holidays.ts');
    const ctx = makeCallbackCtx();
    const svc = makeHolidayService();

    await handleHolidayCallback(ctx as never, svc as never, user as never, 'remove:US');

    expect(svc.unsubscribeUser).toHaveBeenCalledWith(100, 'US');
    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalled();
  });

  test('notify toggles notification and shows updated state', async () => {
    const { handleHolidayCallback } = await import('../../../src/bot/commands/holidays.ts');
    const ctx = makeCallbackCtx();
    const svc = makeHolidayService({
      getSubscription: mock(() => ({ country_code: 'US', is_primary: 1, notify: 1 })),
      getCountryName: mock((code: string) => `Country-${code}`),
    });

    await handleHolidayCallback(ctx as never, svc as never, user as never, 'notify:US');

    expect(svc.toggleNotify).toHaveBeenCalledWith(100, 'US');
    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalled();
  });

  test('notify returns early when subscription not found after toggle', async () => {
    const { handleHolidayCallback } = await import('../../../src/bot/commands/holidays.ts');
    const ctx = makeCallbackCtx();
    const svc = makeHolidayService({
      getSubscription: mock(() => null),
      getCountryName: mock((code: string) => `Country-${code}`),
    });

    await handleHolidayCallback(ctx as never, svc as never, user as never, 'notify:XX');

    expect(svc.toggleNotify).toHaveBeenCalled();
    expect(ctx.editText).not.toHaveBeenCalled();
  });

  test('list shows upcoming holidays', async () => {
    const { handleHolidayCallback } = await import('../../../src/bot/commands/holidays.ts');
    const ctx = makeCallbackCtx();
    const svc = makeHolidayService({
      getUpcomingHolidays: mock(() => [{ date: '2026-12-25', name: 'Christmas', countryName: 'US' }]),
    });

    await handleHolidayCallback(ctx as never, svc as never, user as never, 'list');

    expect(ctx.answer).toHaveBeenCalled();
    expect(ctx.editText).toHaveBeenCalled();
    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Christmas');
  });

  test('list shows none_upcoming when empty', async () => {
    const { handleHolidayCallback } = await import('../../../src/bot/commands/holidays.ts');
    const ctx = makeCallbackCtx();
    const svc = makeHolidayService();

    await handleHolidayCallback(ctx as never, svc as never, user as never, 'list');

    const msg = (ctx.editText.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('No upcoming holidays');
  });
});

describe('handleHolidays group context', () => {
  test('in group with no country prompts to set country (ru)', async () => {
    const { handleHolidays } = await import('../../../src/bot/commands/holidays.ts');
    const groupRepo = makeGroupRepo(null);
    const ctx = {
      chat: { type: 'group', id: -100 },
      dbUser: userRu,
      args: '',
      send: mock(() => Promise.resolve()),
    };
    await handleHolidays(ctx as never, makeHolidayService() as never, groupRepo as never);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('страну');
  });

  test('in group with country shows upcoming holidays for group country', async () => {
    const { handleHolidays } = await import('../../../src/bot/commands/holidays.ts');
    const groupRepo = makeGroupRepo('RU');
    const svc = makeHolidayService();
    let sentText = '';
    const ctx = {
      chat: { type: 'group', id: -100 },
      dbUser: userRu,
      args: '',
      send: mock((text: string) => {
        sentText = text;
        return Promise.resolve();
      }),
    };
    await handleHolidays(ctx as never, svc as never, groupRepo as never);
    expect(svc.getUpcomingForCountry).toHaveBeenCalledWith('RU');
    expect(sentText).toContain('New Year');
  });

  test('in private uses personal flow without groupRepo', async () => {
    const { handleHolidays } = await import('../../../src/bot/commands/holidays.ts');
    const svc = makeHolidayService();
    const ctx = {
      chat: { type: 'private', id: 1 },
      dbUser: { telegram_id: 1, language: 'ru' as const, timezone: 'UTC', country_code: 'RU' },
      args: '',
      send: mock(() => Promise.resolve()),
    };
    await handleHolidays(ctx as never, svc as never);
    expect(ctx.send).toHaveBeenCalled();
  });
});
