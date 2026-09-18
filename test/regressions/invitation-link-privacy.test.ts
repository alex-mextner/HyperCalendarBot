import { expect, mock, test } from 'bun:test';
import { handleStart, type StartDeps } from '../../src/bot/commands/start.ts';
import type { BotCommandContext } from '../../src/bot/types.ts';

function scenario(inviteeId: number, userId: number, eventId = 42) {
  const send = mock(async (text: string, options?: { reply_markup?: unknown }) => ({ text, options }));
  const enter = mock(async () => {});
  const getEvent = mock(() => ({
    title: 'Private synthetic event',
    start_at: new Date(Date.now() + 86400000).toISOString(),
    timezone: 'UTC',
  }));
  const ctx = {
    args: 'i_test_only',
    dbUser: { telegram_id: userId, language: 'en', timezone: 'UTC', onboarding_completed: 0 },
    send,
    scene: { enter },
  } as unknown as BotCommandContext;
  const deps = {
    onboardingScene: { name: 'onboarding' },
    deepLinkService: {
      resolve: () => ({ type: 'invitation', payload: { invitation_id: 1, event_id: eventId }, createdBy: 200 }),
    },
    invitationRepo: {
      findById: () => ({ id: 1, event_id: 42, inviter_id: 200, invitee_id: inviteeId, status: 'pending' }),
    },
    eventService: { getEvent },
  } as unknown as StartDeps;
  return { ctx, deps, send, enter, getEvent };
}

test('forwarded personal link reveals no event or actionable RSVP to a different user', async () => {
  const s = scenario(100, 101);
  await handleStart(s.ctx, s.deps);
  expect(s.getEvent).not.toHaveBeenCalled();
  expect(s.enter).not.toHaveBeenCalled();
  expect(s.send.mock.calls[0]?.[1]?.reply_markup).toBeUndefined();
  expect(s.send.mock.calls[0]?.[0]).not.toContain('Private synthetic event');
});

test('the intended recipient still gets RSVP and onboarding context', async () => {
  const s = scenario(100, 100);
  await handleStart(s.ctx, s.deps);
  expect(s.getEvent).toHaveBeenCalledWith(42, 200);
  expect(s.send.mock.calls[0]?.[1]?.reply_markup).toBeDefined();
  expect(s.enter).toHaveBeenCalled();
});

test('inconsistent invitation and deep-link event IDs fail closed', async () => {
  const s = scenario(100, 100, 99);
  await handleStart(s.ctx, s.deps);
  expect(s.getEvent).not.toHaveBeenCalled();
  expect(s.enter).not.toHaveBeenCalled();
  expect(s.send.mock.calls[0]?.[1]?.reply_markup).toBeUndefined();
});
