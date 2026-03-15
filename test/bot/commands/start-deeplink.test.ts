import { describe, expect, mock, test } from 'bun:test';

describe('handleStart with deep links', () => {
  test('s_ deep link shows event card', async () => {
    const { handleStart } = await import('../../../src/bot/commands/start.ts');
    const ctx = {
      args: 's_abc123',
      dbUser: { telegram_id: 100, language: 'en', onboarding_completed: 1 },
      send: mock(() => Promise.resolve()),
      scene: { enter: mock(() => Promise.resolve()) },
    };
    const deepLinkService = {
      resolve: mock(() => ({
        type: 'shared_event' as const,
        payload: { event_id: 42 },
        createdBy: 200,
      })),
    };
    const eventService = {
      getEvent: mock(() => ({
        title: 'Party',
        start_at: '2026-03-15T18:00:00Z',
        end_at: null,
        timezone: 'UTC',
        location: null,
        description: null,
        all_day: 0,
        category: null,
        recurrence_rule: null,
      })),
    };
    await handleStart(ctx as never, {} as never, deepLinkService as never, eventService as never);
    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Party');
  });

  test('s_ deep link includes formatted date and time', async () => {
    const { handleStart } = await import('../../../src/bot/commands/start.ts');
    const ctx = {
      args: 's_abc123',
      dbUser: { telegram_id: 100, language: 'en', onboarding_completed: 1 },
      send: mock(() => Promise.resolve()),
      scene: { enter: mock(() => Promise.resolve()) },
    };
    const deepLinkService = {
      resolve: mock(() => ({
        type: 'shared_event' as const,
        payload: { event_id: 42 },
        createdBy: 200,
      })),
    };
    const eventService = {
      getEvent: mock(() => ({
        title: 'Meeting',
        start_at: '2026-03-15T18:00:00Z',
        end_at: '2026-03-15T19:00:00Z',
        timezone: 'UTC',
        location: 'Office',
        description: 'Quarterly review',
        all_day: 0,
        category: null,
        recurrence_rule: null,
      })),
    };
    await handleStart(ctx as never, {} as never, deepLinkService as never, eventService as never);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('18:00');
    expect(msg).toContain('Office');
    expect(msg).toContain('Quarterly review');
  });

  test('i_ deep link shows invitation message', async () => {
    const { handleStart } = await import('../../../src/bot/commands/start.ts');
    const ctx = {
      args: 'i_invite123',
      dbUser: { telegram_id: 100, language: 'en', onboarding_completed: 1 },
      send: mock(() => Promise.resolve()),
      scene: { enter: mock(() => Promise.resolve()) },
    };
    const deepLinkService = {
      resolve: mock(() => ({
        type: 'invitation' as const,
        payload: { invitation_id: 10, event_id: 42 },
        createdBy: 200,
      })),
    };
    await handleStart(ctx as never, {} as never, deepLinkService as never);
    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('/invitations');
  });

  test('g_ deep link shows group connected message', async () => {
    const { handleStart } = await import('../../../src/bot/commands/start.ts');
    const ctx = {
      args: 'g_group456',
      dbUser: { telegram_id: 100, language: 'ru', onboarding_completed: 1 },
      send: mock(() => Promise.resolve()),
      scene: { enter: mock(() => Promise.resolve()) },
    };
    const deepLinkService = {
      resolve: mock(() => ({
        type: 'group_context' as const,
        payload: { chat_id: -100123 },
        createdBy: 100,
      })),
    };
    await handleStart(ctx as never, {} as never, deepLinkService as never);
    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Группа подключена');
  });

  test('invalid deep link falls through to normal flow', async () => {
    const { handleStart } = await import('../../../src/bot/commands/start.ts');
    const ctx = {
      args: 's_invalid',
      dbUser: { telegram_id: 100, language: 'en', onboarding_completed: 1 },
      send: mock(() => Promise.resolve()),
      scene: { enter: mock(() => Promise.resolve()) },
    };
    const deepLinkService = { resolve: mock(() => null) };
    await handleStart(ctx as never, {} as never, deepLinkService as never);
    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Welcome back');
  });

  test('no args behaves as before (onboarding completed)', async () => {
    const { handleStart } = await import('../../../src/bot/commands/start.ts');
    const ctx = {
      args: null,
      dbUser: { telegram_id: 100, language: 'en', onboarding_completed: 1 },
      send: mock(() => Promise.resolve()),
      scene: { enter: mock(() => Promise.resolve()) },
    };
    await handleStart(ctx as never, {} as never);
    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Welcome back');
  });

  test('no args enters onboarding when not completed', async () => {
    const { handleStart } = await import('../../../src/bot/commands/start.ts');
    const onboardingScene = { name: 'onboarding' };
    const ctx = {
      args: null,
      dbUser: { telegram_id: 100, language: 'en', onboarding_completed: 0 },
      send: mock(() => Promise.resolve()),
      scene: { enter: mock(() => Promise.resolve()) },
    };
    await handleStart(ctx as never, onboardingScene as never);
    expect(ctx.scene.enter).toHaveBeenCalledWith(onboardingScene);
    expect(ctx.send).not.toHaveBeenCalled();
  });

  test('event not found falls through to normal flow', async () => {
    const { handleStart } = await import('../../../src/bot/commands/start.ts');
    const ctx = {
      args: 's_abc123',
      dbUser: { telegram_id: 100, language: 'en', onboarding_completed: 1 },
      send: mock(() => Promise.resolve()),
      scene: { enter: mock(() => Promise.resolve()) },
    };
    const deepLinkService = {
      resolve: mock(() => ({
        type: 'shared_event' as const,
        payload: { event_id: 999 },
        createdBy: 200,
      })),
    };
    const eventService = {
      getEvent: mock(() => null),
    };
    await handleStart(ctx as never, {} as never, deepLinkService as never, eventService as never);
    expect(ctx.send).toHaveBeenCalled();
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).toContain('Welcome back');
  });

  test('escapes HTML in event title', async () => {
    const { handleStart } = await import('../../../src/bot/commands/start.ts');
    const ctx = {
      args: 's_abc123',
      dbUser: { telegram_id: 100, language: 'en', onboarding_completed: 1 },
      send: mock(() => Promise.resolve()),
      scene: { enter: mock(() => Promise.resolve()) },
    };
    const deepLinkService = {
      resolve: mock(() => ({
        type: 'shared_event' as const,
        payload: { event_id: 42 },
        createdBy: 200,
      })),
    };
    const eventService = {
      getEvent: mock(() => ({
        title: '<script>alert("xss")</script>',
        start_at: '2026-03-15T18:00:00Z',
        end_at: null,
        timezone: 'UTC',
        location: null,
        description: null,
        all_day: 0,
        category: null,
        recurrence_rule: null,
      })),
    };
    await handleStart(ctx as never, {} as never, deepLinkService as never, eventService as never);
    const msg = (ctx.send.mock.calls[0] as unknown[])[0] as string;
    expect(msg).not.toContain('<script>');
    expect(msg).toContain('&lt;script&gt;');
  });
});
