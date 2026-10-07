import { describe, expect, test } from 'bun:test';
import {
  createStaleUpdateGuard,
  STALE_UPDATE_MAX_AGE_MS,
  type StaleUpdateContext,
} from '../../../src/bot/middleware/stale-update-guard.ts';
import { t } from '../../../src/config/constants.ts';

const NOW_MS = Date.parse('2026-09-27T17:14:00Z');

function messageUpdate(chatId: number, sentAt: string, type = 'private'): StaleUpdateContext {
  return {
    update: {
      message: { date: Date.parse(sentAt) / 1000, chat: { id: chatId, type }, from: { language_code: 'ru' } },
    },
  };
}

function makeGuard(clock = { now: NOW_MS }) {
  const notes: { chatId: number; text: string }[] = [];
  /** Updates the connect-wizard guard reports as released by their owner. */
  const released = new Set<StaleUpdateContext>();
  const guard = createStaleUpdateGuard({
    maxAgeMs: STALE_UPDATE_MAX_AGE_MS,
    now: () => clock.now,
    sendNote: async (chatId, text) => {
      notes.push({ chatId, text });
    },
    isOwnerReleased: (context: StaleUpdateContext) => released.has(context),
  });
  return { guard, notes, released };
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

  test('the window edge is inclusive: exactly at the limit is answered, a second later is not', async () => {
    const { guard } = makeGuard();
    const atLimit = new Date(NOW_MS - STALE_UPDATE_MAX_AGE_MS).toISOString();
    const pastLimit = new Date(NOW_MS - STALE_UPDATE_MAX_AGE_MS - 1_000).toISOString();
    expect(await passes(guard, messageUpdate(501, atLimit))).toBe(true);
    expect(await passes(guard, messageUpdate(502, pastLimit))).toBe(false);
  });

  test('an edit is aged by when it was edited, not when the message was first sent', async () => {
    const { guard, notes } = makeGuard();
    const original = messageUpdate(501, '2026-09-27T14:00:00Z').update?.message;
    if (!original) throw new Error('fixture has no message');
    const freshEdit = { ...original, edit_date: Date.parse('2026-09-27T17:13:30Z') / 1000 };
    const staleEdit = { ...original, edit_date: Date.parse('2026-09-27T14:05:00Z') / 1000 };
    expect(await passes(guard, { update: { edited_message: freshEdit } })).toBe(true);
    expect(await passes(guard, { update: { edited_message: staleEdit } })).toBe(false);
    expect(notes).toHaveLength(1);
  });

  test('a fresh message from another chat mid-backlog does not repeat the note (webhook order is not kept)', async () => {
    const { guard, notes } = makeGuard();
    await passes(guard, messageUpdate(501, '2026-09-27T14:00:00Z'));
    await passes(guard, messageUpdate(777, '2026-09-27T17:13:00Z'));
    await passes(guard, messageUpdate(501, '2026-09-27T14:05:00Z'));
    expect(notes).toHaveLength(1);
  });

  test('a later outage notifies the chat again', async () => {
    const clock = { now: NOW_MS };
    const { guard, notes } = makeGuard(clock);
    await passes(guard, messageUpdate(501, '2026-09-27T14:00:00Z'));
    clock.now = Date.parse('2026-09-27T20:00:00Z');
    await passes(guard, messageUpdate(501, '2026-09-27T19:00:00Z'));
    expect(notes).toHaveLength(2);
  });

  test('a note that cannot be delivered (bot blocked) still skips quietly', async () => {
    const guard = createStaleUpdateGuard({
      maxAgeMs: STALE_UPDATE_MAX_AGE_MS,
      now: () => NOW_MS,
      sendNote: async () => {
        throw new Error('Forbidden: bot was blocked by the user');
      },
      isOwnerReleased: () => false,
    });
    expect(await passes(guard, messageUpdate(501, '2026-09-27T14:00:00Z'))).toBe(false);
  });

  test('a stale group message is skipped without a note', async () => {
    const { guard, notes } = makeGuard();
    expect(await passes(guard, messageUpdate(-100_501, '2026-09-27T14:00:00Z', 'supergroup'))).toBe(false);
    expect(notes).toEqual([]);
  });

  test('updates without a message date (button presses, membership changes) pass through', async () => {
    const { guard, notes } = makeGuard();
    expect(await passes(guard, { update: {} })).toBe(true);
    expect(notes).toEqual([]);
  });

  test('a held message its owner released runs however long it was held, without a note', async () => {
    const { guard, notes, released } = makeGuard();
    const held = messageUpdate(501, '2026-09-27T17:00:00Z');
    released.add(held);
    expect(await passes(guard, held)).toBe(true);
    expect(notes).toEqual([]);
    // The same old message, not released, is still skipped.
    expect(await passes(guard, messageUpdate(501, '2026-09-27T17:00:00Z'))).toBe(false);
  });
});
