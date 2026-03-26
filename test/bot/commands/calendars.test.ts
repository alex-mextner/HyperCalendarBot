// test/bot/commands/calendars.test.ts
import { describe, expect, mock, test } from 'bun:test';
import { InlineKeyboard } from 'gramio';
import { buildCalendarPickerKeyboard, handleCalendarPickerCallback } from '../../../src/bot/commands/calendars.ts';
import { CB } from '../../../src/config/constants.ts';
import type { GoogleCalendar } from '../../../src/database/types.ts';

function makeCalendar(overrides: Partial<GoogleCalendar> = {}): GoogleCalendar {
  return {
    id: 1,
    user_id: 10,
    google_calendar_id: 'cal@google.com',
    calendar_name: 'My Calendar',
    color: null,
    is_primary: 0,
    sync_enabled: 1,
    access_role: 'owner',
    sync_token: null,
    last_synced_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

interface InlineButton {
  text: string;
  callback_data?: string;
}

describe('buildCalendarPickerKeyboard', () => {
  test('enabled calendar shows checkmark', () => {
    const kb = buildCalendarPickerKeyboard([makeCalendar({ sync_enabled: 1 })], 'en');
    expect(kb).toBeInstanceOf(InlineKeyboard);
    const buttons = kb.toJSON().inline_keyboard.flat() as InlineButton[];
    expect(buttons.some((b) => b.text.startsWith('✅'))).toBe(true);
  });

  test('disabled calendar shows empty box', () => {
    const kb = buildCalendarPickerKeyboard([makeCalendar({ sync_enabled: 0 })], 'en');
    const buttons = kb.toJSON().inline_keyboard.flat() as InlineButton[];
    expect(buttons.some((b) => b.text.startsWith('⬜'))).toBe(true);
  });

  test('primary calendar shows star', () => {
    const kb = buildCalendarPickerKeyboard([makeCalendar({ is_primary: 1 })], 'en');
    const buttons = kb.toJSON().inline_keyboard.flat() as InlineButton[];
    expect(buttons.some((b) => b.text.includes('★'))).toBe(true);
  });

  test('reader access_role shows read-only suffix', () => {
    const kb = buildCalendarPickerKeyboard([makeCalendar({ access_role: 'reader' })], 'en');
    const buttons = kb.toJSON().inline_keyboard.flat() as InlineButton[];
    expect(buttons.some((b) => b.text.includes('(read-only)'))).toBe(true);
  });

  test('freeBusyReader access_role shows read-only suffix', () => {
    const kb = buildCalendarPickerKeyboard([makeCalendar({ access_role: 'freeBusyReader' })], 'en');
    const buttons = kb.toJSON().inline_keyboard.flat() as InlineButton[];
    expect(buttons.some((b) => b.text.includes('(read-only)'))).toBe(true);
  });

  test('writer access_role has no read-only suffix', () => {
    const kb = buildCalendarPickerKeyboard([makeCalendar({ access_role: 'writer' })], 'en');
    const buttons = kb.toJSON().inline_keyboard.flat() as InlineButton[];
    expect(buttons.every((b) => !b.text.includes('(read-only)'))).toBe(true);
  });

  test('each calendar row has callback data with calendar id', () => {
    const cal = makeCalendar({ id: 42 });
    const kb = buildCalendarPickerKeyboard([cal], 'en');
    const buttons = kb.toJSON().inline_keyboard.flat() as InlineButton[];
    expect(buttons.some((b) => b.callback_data === `${CB.GCAL}:cal:42`)).toBe(true);
  });

  test('Done button is present with correct callback data', () => {
    const kb = buildCalendarPickerKeyboard([], 'en');
    const buttons = kb.toJSON().inline_keyboard.flat() as InlineButton[];
    expect(buttons.some((b) => b.callback_data === `${CB.GCAL}:cal:done`)).toBe(true);
  });

  test('russian lang shows correct Done button text', () => {
    const kb = buildCalendarPickerKeyboard([], 'ru');
    const buttons = kb.toJSON().inline_keyboard.flat() as InlineButton[];
    expect(buttons.some((b) => b.text === 'Готово ✓')).toBe(true);
  });
});

describe('handleCalendarPickerCallback', () => {
  function makeCtx() {
    return {
      answer: mock(() => Promise.resolve()),
      editText: mock(() => Promise.resolve()),
    };
  }

  function makeCalendarRepo(calendars: GoogleCalendar[] = []) {
    return {
      toggleSync: mock(() => undefined),
      getCalendars: mock(() => calendars),
    };
  }

  test('done payload calls onDone and edits text', async () => {
    const ctx = makeCtx();
    const repo = makeCalendarRepo();
    const onDone = mock(() => Promise.resolve());

    await handleCalendarPickerCallback(ctx as never, repo as never, 10, 'done', 'en', onDone);

    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(ctx.editText).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith(10);
    expect(repo.toggleSync).not.toHaveBeenCalled();
  });

  test('done payload without onDone does not throw', async () => {
    const ctx = makeCtx();
    const repo = makeCalendarRepo();

    await handleCalendarPickerCallback(ctx as never, repo as never, 10, 'done', 'en');

    expect(ctx.editText).toHaveBeenCalledTimes(1);
  });

  test('numeric payload toggles and refreshes keyboard', async () => {
    const ctx = makeCtx();
    const cal = makeCalendar({ id: 7, sync_enabled: 1 });
    const repo = makeCalendarRepo([cal]);

    await handleCalendarPickerCallback(ctx as never, repo as never, 10, '7', 'en');

    expect(repo.toggleSync).toHaveBeenCalledWith(7);
    expect(repo.getCalendars).toHaveBeenCalledWith(10);
    expect(ctx.answer).toHaveBeenCalledTimes(1);
    expect(ctx.editText).toHaveBeenCalledTimes(1);
  });
});
