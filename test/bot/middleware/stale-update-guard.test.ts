import { describe, expect, test } from 'bun:test';
import { createStaleUpdateGuard, type StaleUpdateContext } from '../../../src/bot/middleware/stale-update-guard.ts';
import { t } from '../../../src/config/constants.ts';

const NOW_MS = Date.parse('2026-09-27T17:14:00Z');
const MAX_AGE_MS = 10 * 60_000;

function messageUpdate(chatId: number, sentAt: string, type = 'private') {
  return {
    update: { message: { date: Date.parse(sentAt) / 1000, chat: { id: chatId, type } } },
    dbUser: { language: 'ru' },
  };
}

function makeGuard() {
  const notes: { chatId: number; text: string }[] = [];
  const guard = createStaleUpdateGuard({
    maxAgeMs: MAX_AGE_MS,
    now: () => NOW_MS,
    sendNote: async (chatId, text) => {
      notes.push({ chatId, text });
    },
  });
  return { guard, notes };
}

async function passes(
  guard: (context: StaleUpdateContext, next: () => Promise<void>) => Promise<unknown>,
  context: StaleUpdateContext,
) {
  let reached = false;
  await guard(context, async () => {
    reached = true;
  });
  return reached;
}

describe('stale update guard', () => {
  test('a message delivered after the restart window is still answered normally', async () => {
    const { guard, notes } = makeGuard();
    // Sent while the old container was stopping, redelivered 90 s later.
    expect(await passes(guard, messageUpdate(501, '2026-09-27T17:12:30Z'))).toBe(true);
    expect(notes).toEqual([]);
  });

  test('a message older than the window gets no AI turn and one honest note per chat', async () => {
    const { guard, notes } = makeGuard();
    expect(await passes(guard, messageUpdate(501, '2026-09-27T14:00:00Z'))).toBe(false);
    expect(await passes(guard, messageUpdate(501, '2026-09-27T14:05:00Z'))).toBe(false);
    expect(notes).toEqual([{ chatId: 501, text: t('ru').stale_update_skipped }]);
  });

  test('a stale group message is skipped without a note', async () => {
    const { guard, notes } = makeGuard();
    expect(await passes(guard, messageUpdate(-100_501, '2026-09-27T14:00:00Z', 'supergroup'))).toBe(false);
    expect(notes).toEqual([]);
  });

  test('updates without a message date (button presses, membership changes) pass through', async () => {
    const { guard, notes } = makeGuard();
    expect(await passes(guard, { update: {}, dbUser: { language: 'ru' } })).toBe(true);
    expect(notes).toEqual([]);
  });
});
