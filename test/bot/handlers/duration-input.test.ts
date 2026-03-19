import { expect, test } from 'bun:test';
import { pendingDurationInput } from '../../../src/bot/commands/settings.ts';
import { tryHandleDurationInput } from '../../../src/bot/handlers/message.handler.ts';

function makeUserRepo(store: Record<number, number>) {
  return {
    update: (id: number, data: { default_event_duration_minutes?: number }) => {
      if (data.default_event_duration_minutes !== undefined) {
        store[id] = data.default_event_duration_minutes;
      }
      return { telegram_id: id, default_event_duration_minutes: store[id] ?? 60 };
    },
    findByTelegramId: (id: number) => ({ telegram_id: id, default_event_duration_minutes: store[id] ?? 60 }),
  };
}

test('intercepts plain number when pending, updates setting', async () => {
  const store: Record<number, number> = {};
  const userRepo = makeUserRepo(store);
  pendingDurationInput.set(100, Date.now());

  const sent: string[] = [];
  const ctx = {
    send: async (text: string) => {
      sent.push(text);
    },
  };

  const handled = await tryHandleDurationInput(ctx as never, 100, '45', userRepo as never);
  expect(handled).toBe(true);
  expect(store[100]).toBe(45);
  expect(sent.length).toBe(1);
  expect(sent[0]).toContain('45');
  expect(pendingDurationInput.has(100)).toBe(false);
});

test('does not intercept when no pending state', async () => {
  const userRepo = makeUserRepo({});
  pendingDurationInput.delete(200);

  const handled = await tryHandleDurationInput({} as never, 200, '45', userRepo as never);
  expect(handled).toBe(false);
});

test('intercepts invalid text when pending, shows error, keeps pending', async () => {
  const userRepo = makeUserRepo({});

  const sent: string[] = [];
  const ctx = {
    send: async (text: string) => {
      sent.push(text);
    },
  };

  for (const bad of ['hello', '-5', '1.5', '99999', '4 5', '0']) {
    sent.length = 0;
    pendingDurationInput.set(300, Date.now());
    const handled = await tryHandleDurationInput(ctx as never, 300, bad, userRepo as never);
    expect(handled).toBe(true); // intercepted
    expect(sent[0]).toContain('1 до 1440'); // error shown
    expect(pendingDurationInput.has(300)).toBe(true); // still waiting
  }

  pendingDurationInput.delete(300);
});

test('confirmation message for 90 min shows "90 мин", not "1.5ч"', async () => {
  const store: Record<number, number> = {};
  const userRepo = makeUserRepo(store);
  pendingDurationInput.set(500, Date.now());

  const sent: string[] = [];
  const ctx = {
    send: async (text: string) => {
      sent.push(text);
    },
  };

  await tryHandleDurationInput(ctx as never, 500, '90', userRepo as never);
  expect(sent[0]).toContain('90 мин');
  expect(sent[0]).not.toContain('1.5ч');
});

test('confirmation message for 120 min shows "2ч"', async () => {
  const store: Record<number, number> = {};
  const userRepo = makeUserRepo(store);
  pendingDurationInput.set(501, Date.now());

  const sent: string[] = [];
  const ctx = {
    send: async (text: string) => {
      sent.push(text);
    },
  };

  await tryHandleDurationInput(ctx as never, 501, '120', userRepo as never);
  expect(sent[0]).toContain('2ч');
});

test('clears expired pending state (> 5 min)', async () => {
  const userRepo = makeUserRepo({});
  pendingDurationInput.set(400, Date.now() - 6 * 60 * 1000); // 6 min ago

  const handled = await tryHandleDurationInput({} as never, 400, '30', userRepo as never);
  expect(handled).toBe(false);
  expect(pendingDurationInput.has(400)).toBe(false);
});
