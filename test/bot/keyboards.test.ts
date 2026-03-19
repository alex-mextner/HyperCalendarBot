import { describe, expect, test } from 'bun:test';
import { InlineKeyboard, Keyboard } from 'gramio';
import {
  countryKeyboard,
  deleteConfirmKeyboard,
  editFieldKeyboard,
  eventActionsKeyboard,
  eventActionsKeyboardOcc,
  eventPickerKeyboard,
  holidayCountryKeyboard,
  holidayManageCountryKeyboard,
  holidayManageListKeyboard,
  holidayRegionKeyboard,
  holidaysMenuKeyboard,
  inviteContactPickerKeyboard,
  languageKeyboard,
  monthNavKeyboard,
  notifyEveningKeyboard,
  notifyHourPickerKeyboard,
  notifyMenuKeyboard,
  notifyMinutePickerKeyboard,
  notifyMorningKeyboard,
  notifyQuietKeyboard,
  notifyReminderIntervalsKeyboard,
  recurrenceEndKeyboard,
  recurrenceKeyboard,
  recurrenceScopeKeyboard,
  removeKeyboard,
  skipKeyboard,
  timezoneConfirmKeyboard,
  timezoneMethodKeyboard,
} from '../../src/bot/keyboards';

function kbData(kb: InlineKeyboard): Array<Array<{ text: string; callback_data?: string }>> {
  return (kb as unknown as { keyboard: Array<Array<{ text: string; callback_data?: string }>> }).keyboard;
}

// ── Onboarding ──

describe('languageKeyboard', () => {
  test('returns keyboard with en and ru buttons', () => {
    const kb = languageKeyboard();
    expect(kb).toBeInstanceOf(InlineKeyboard);
    const rows = kbData(kb);
    const texts = rows.flat().map((b) => b.text);
    expect(texts).toContain('English');
    expect(texts).toContain('Русский');
  });

  test('callback data uses ol prefix', () => {
    const kb = languageKeyboard();
    const buttons = kbData(kb).flat();
    expect(buttons.find((b) => b.text === 'English')?.callback_data).toBe('ol:en');
    expect(buttons.find((b) => b.text === 'Русский')?.callback_data).toBe('ol:ru');
  });
});

describe('timezoneMethodKeyboard', () => {
  test('returns Keyboard instance for en', () => {
    const kb = timezoneMethodKeyboard('en');
    expect(kb).toBeInstanceOf(Keyboard);
  });

  test('returns Keyboard instance for ru', () => {
    const kb = timezoneMethodKeyboard('ru');
    expect(kb).toBeInstanceOf(Keyboard);
  });
});

describe('timezoneConfirmKeyboard', () => {
  test('en version has Yes and No buttons', () => {
    const kb = timezoneConfirmKeyboard('en');
    const buttons = kbData(kb).flat();
    expect(buttons.some((b) => b.text.includes('Yes'))).toBe(true);
    expect(buttons.some((b) => b.text.includes('No'))).toBe(true);
  });

  test('ru version has Да and Нет buttons', () => {
    const kb = timezoneConfirmKeyboard('ru');
    const buttons = kbData(kb).flat();
    expect(buttons.some((b) => b.text.includes('Да'))).toBe(true);
    expect(buttons.some((b) => b.text.includes('Нет'))).toBe(true);
  });
});

describe('countryKeyboard', () => {
  test('with countryCode shows Yes and Skip', () => {
    const kb = countryKeyboard('US', 'en');
    const buttons = kbData(kb).flat();
    expect(buttons.some((b) => b.text.includes('US'))).toBe(true);
    expect(buttons.some((b) => b.text === 'Skip')).toBe(true);
  });

  test('without countryCode shows only Skip', () => {
    const kb = countryKeyboard(null, 'en');
    const buttons = kbData(kb).flat();
    expect(buttons.length).toBe(1);
    expect(buttons[0]?.text).toBe('Skip');
  });

  test('ru version uses Пропустить', () => {
    const kb = countryKeyboard(null, 'ru');
    const buttons = kbData(kb).flat();
    expect(buttons[0]?.text).toBe('Пропустить');
  });
});

// ── Event actions ──

describe('eventActionsKeyboard', () => {
  test('en version has Edit and Delete', () => {
    const kb = eventActionsKeyboard(42, 'en');
    const buttons = kbData(kb).flat();
    expect(buttons.some((b) => b.text.includes('Edit'))).toBe(true);
    expect(buttons.some((b) => b.text.includes('Delete'))).toBe(true);
  });

  test('callback data embeds event id', () => {
    const kb = eventActionsKeyboard(42, 'en');
    const buttons = kbData(kb).flat();
    expect(buttons.find((b) => b.text.includes('Edit'))?.callback_data).toBe('ee:42');
    expect(buttons.find((b) => b.text.includes('Delete'))?.callback_data).toBe('ed:42');
  });

  test('ru version has Редактировать and Удалить', () => {
    const kb = eventActionsKeyboard(42, 'ru');
    const buttons = kbData(kb).flat();
    expect(buttons.some((b) => b.text.includes('Редактировать'))).toBe(true);
    expect(buttons.some((b) => b.text.includes('Удалить'))).toBe(true);
  });
});

describe('deleteConfirmKeyboard', () => {
  test('has confirm and cancel buttons', () => {
    const kb = deleteConfirmKeyboard(42, 'en');
    const buttons = kbData(kb).flat();
    expect(buttons.some((b) => b.callback_data === 'edc:42')).toBe(true);
    expect(buttons.some((b) => b.callback_data === 'ed:cancel')).toBe(true);
  });

  test('ru version', () => {
    const kb = deleteConfirmKeyboard(42, 'ru');
    const buttons = kbData(kb).flat();
    expect(buttons.some((b) => b.text.includes('Да, удалить'))).toBe(true);
    expect(buttons.some((b) => b.text.includes('Отмена'))).toBe(true);
  });
});

describe('eventPickerKeyboard', () => {
  test('lists up to 10 events with cancel', () => {
    const events = Array.from({ length: 3 }, (_, i) => ({
      id: i + 1,
      title: `Event ${i + 1}`,
      start_at: '2026-03-15T10:00:00Z',
      end_at: null,
    }));
    const kb = eventPickerKeyboard(events as never, 'UTC', 'ev');
    const buttons = kbData(kb).flat();
    expect(buttons.length).toBe(4); // 3 events + cancel
    expect(buttons[buttons.length - 1]?.text).toBe('Cancel');
    expect(buttons[0]?.callback_data).toBe('ev:1');
  });

  test('limits to 10 events max', () => {
    const events = Array.from({ length: 15 }, (_, i) => ({
      id: i + 1,
      title: `Event ${i + 1}`,
      start_at: '2026-03-15T10:00:00Z',
      end_at: null,
    }));
    const kb = eventPickerKeyboard(events as never, 'UTC', 'ev');
    const buttons = kbData(kb).flat();
    expect(buttons.length).toBe(11); // 10 events + cancel
  });

  test('empty events list shows only cancel', () => {
    const kb = eventPickerKeyboard([], 'UTC', 'ev');
    const buttons = kbData(kb).flat();
    expect(buttons.length).toBe(1);
    expect(buttons[0]?.text).toBe('Cancel');
  });
});

describe('editFieldKeyboard', () => {
  test('en version has all fields and cancel', () => {
    const kb = editFieldKeyboard(42, 'en');
    const buttons = kbData(kb).flat();
    const texts = buttons.map((b) => b.text);
    expect(texts).toContain('Title');
    expect(texts).toContain('Time');
    expect(texts).toContain('Duration');
    expect(texts).toContain('Description');
    expect(texts).toContain('Location');
    expect(texts).toContain('Cancel');
  });

  test('callback data format is ef:eventId:field', () => {
    const kb = editFieldKeyboard(42, 'en');
    const buttons = kbData(kb).flat();
    expect(buttons.find((b) => b.text === 'Title')?.callback_data).toBe('ef:42:title');
    expect(buttons.find((b) => b.text === 'Cancel')?.callback_data).toBe('ef:cancel');
  });

  test('ru version has Russian labels', () => {
    const kb = editFieldKeyboard(42, 'ru');
    const buttons = kbData(kb).flat();
    expect(buttons.some((b) => b.text === 'Название')).toBe(true);
    expect(buttons.some((b) => b.text === 'Отмена')).toBe(true);
  });
});

describe('recurringEditKeyboard', () => {
  test('has This only and All future buttons', async () => {
    const { recurringEditKeyboard } = await import('../../src/bot/keyboards');
    const kb = recurringEditKeyboard(42, '2026-03-15T10:00:00Z', 'en');
    const buttons = kbData(kb).flat();
    expect(buttons.some((b) => b.text === 'This only')).toBe(true);
    expect(buttons.some((b) => b.text === 'All future')).toBe(true);
    expect(buttons[0]?.callback_data).toBe('er:42:2026-03-15T10:00:00Z:this');
  });
});

describe('eventActionsKeyboardOcc', () => {
  test('embeds occurrence date in callback data', () => {
    const kb = eventActionsKeyboardOcc(42, '2026-03-15T10:00:00Z', 'en');
    const buttons = kbData(kb).flat();
    expect(buttons.find((b) => b.text.includes('Edit'))?.callback_data).toBe('ee:42:2026-03-15T10:00:00Z');
    expect(buttons.find((b) => b.text.includes('Delete'))?.callback_data).toBe('ed:42:2026-03-15T10:00:00Z');
  });
});

describe('recurrenceKeyboard', () => {
  test('en version has all frequency options', () => {
    const kb = recurrenceKeyboard('en');
    const buttons = kbData(kb).flat();
    const texts = buttons.map((b) => b.text);
    expect(texts).toContain("Don't repeat");
    expect(texts).toContain('Daily');
    expect(texts).toContain('Weekly');
    expect(texts).toContain('Monthly');
    expect(texts).toContain('Yearly');
    expect(texts).toContain('Custom...');
  });

  test('callback data uses ar prefix', () => {
    const kb = recurrenceKeyboard('en');
    const buttons = kbData(kb).flat();
    expect(buttons[0]?.callback_data).toBe('ar:none');
  });
});

describe('recurrenceEndKeyboard', () => {
  test('has forever, until, count options', () => {
    const kb = recurrenceEndKeyboard('en');
    const buttons = kbData(kb).flat();
    expect(buttons.some((b) => b.callback_data === 'are:forever')).toBe(true);
    expect(buttons.some((b) => b.callback_data === 'are:until')).toBe(true);
    expect(buttons.some((b) => b.callback_data === 'are:count')).toBe(true);
  });
});

describe('skipKeyboard', () => {
  test('returns Skip button with step index', () => {
    const kb = skipKeyboard('en', 3);
    const buttons = kbData(kb).flat();
    expect(buttons.length).toBe(1);
    expect(buttons[0]?.text).toBe('Skip');
    expect(buttons[0]?.callback_data).toBe('ask:3');
  });

  test('ru version says Пропустить', () => {
    const kb = skipKeyboard('ru', 3);
    const buttons = kbData(kb).flat();
    expect(buttons[0]?.text).toBe('Пропустить');
  });
});

describe('recurrenceScopeKeyboard', () => {
  test('creates this/future buttons with given prefix', () => {
    const kb = recurrenceScopeKeyboard('erd', 42, '2026-03-15T10:00:00Z', 'en');
    const buttons = kbData(kb).flat();
    expect(buttons.some((b) => b.text === 'This only')).toBe(true);
    expect(buttons.some((b) => b.text === 'All future')).toBe(true);
    expect(buttons[0]?.callback_data).toBe('erd:42:2026-03-15T10:00:00Z:this');
  });
});

// ── Holiday keyboards ──

describe('holidaysMenuKeyboard', () => {
  test('en version has Add, Manage, Upcoming', () => {
    const kb = holidaysMenuKeyboard('en');
    const buttons = kbData(kb).flat();
    expect(buttons.some((b) => b.text === '+ Add')).toBe(true);
    expect(buttons.some((b) => b.text === 'Manage')).toBe(true);
    expect(buttons.some((b) => b.text === 'Upcoming')).toBe(true);
  });

  test('callback data uses hl prefix', () => {
    const kb = holidaysMenuKeyboard('en');
    const buttons = kbData(kb).flat();
    expect(buttons.find((b) => b.text === '+ Add')?.callback_data).toBe('hl:add');
    expect(buttons.find((b) => b.text === 'Manage')?.callback_data).toBe('hl:manage');
    expect(buttons.find((b) => b.text === 'Upcoming')?.callback_data).toBe('hl:list');
  });
});

describe('holidayRegionKeyboard', () => {
  test('lists regions with back button', () => {
    const kb = holidayRegionKeyboard(['Europe', 'Asia'], 'en');
    const buttons = kbData(kb).flat();
    expect(buttons.length).toBe(3); // 2 regions + back
    expect(buttons[0]?.callback_data).toBe('hl:add:Europe');
    expect(buttons[buttons.length - 1]?.callback_data).toBe('hl:menu');
  });
});

describe('holidayCountryKeyboard', () => {
  test('lists countries with back button', () => {
    const countries = [
      { code: 'DE', name: 'Germany' },
      { code: 'FR', name: 'France' },
    ];
    const kb = holidayCountryKeyboard(countries, 'Europe', 0, 'en');
    const buttons = kbData(kb).flat();
    expect(buttons.some((b) => b.text === 'Germany')).toBe(true);
    expect(buttons.some((b) => b.callback_data === 'hl:sub:DE')).toBe(true);
    expect(buttons[buttons.length - 1]?.callback_data).toBe('hl:add');
  });

  test('paginates when more than 8 countries', () => {
    const countries = Array.from({ length: 20 }, (_, i) => ({
      code: `C${i}`,
      name: `Country ${i}`,
    }));
    const kb = holidayCountryKeyboard(countries, 'Europe', 0, 'en');
    const buttons = kbData(kb).flat();
    // Should have pagination buttons
    expect(buttons.some((b) => b.text.includes('1/'))).toBe(true);
    expect(buttons.some((b) => b.text === '▶️')).toBe(true);
  });

  test('second page has prev button', () => {
    const countries = Array.from({ length: 20 }, (_, i) => ({
      code: `C${i}`,
      name: `Country ${i}`,
    }));
    const kb = holidayCountryKeyboard(countries, 'Europe', 1, 'en');
    const buttons = kbData(kb).flat();
    expect(buttons.some((b) => b.text === '◀️')).toBe(true);
    expect(buttons.some((b) => b.text.includes('2/'))).toBe(true);
  });
});

describe('holidayManageListKeyboard', () => {
  test('lists subscriptions with primary star', () => {
    const subs = [
      { country_code: 'US', countryName: 'United States', is_primary: 1 },
      { country_code: 'DE', countryName: 'Germany', is_primary: 0 },
    ];
    const kb = holidayManageListKeyboard(subs, 'en');
    const buttons = kbData(kb).flat();
    expect(buttons.some((b) => b.text.includes('⭐'))).toBe(true);
    expect(buttons.some((b) => b.callback_data === 'hl:manage:US')).toBe(true);
    expect(buttons[buttons.length - 1]?.callback_data).toBe('hl:menu');
  });
});

describe('holidayManageCountryKeyboard', () => {
  test('non-primary shows Set Primary button', () => {
    const kb = holidayManageCountryKeyboard('DE', false, true, 'en');
    const buttons = kbData(kb).flat();
    expect(buttons.some((b) => b.text.includes('Set Primary'))).toBe(true);
    expect(buttons.some((b) => b.callback_data === 'hl:primary:DE')).toBe(true);
  });

  test('primary does not show Set Primary button', () => {
    const kb = holidayManageCountryKeyboard('DE', true, true, 'en');
    const buttons = kbData(kb).flat();
    expect(buttons.every((b) => !b.text.includes('Set Primary'))).toBe(true);
  });

  test('notify on shows ON label', () => {
    const kb = holidayManageCountryKeyboard('DE', true, true, 'en');
    const buttons = kbData(kb).flat();
    expect(buttons.some((b) => b.text.includes('ON'))).toBe(true);
  });

  test('notify off shows OFF label', () => {
    const kb = holidayManageCountryKeyboard('DE', true, false, 'en');
    const buttons = kbData(kb).flat();
    expect(buttons.some((b) => b.text.includes('OFF'))).toBe(true);
  });
});

describe('monthNavKeyboard', () => {
  test('prev/next navigation for mid-year', () => {
    const kb = monthNavKeyboard('2026-06');
    const buttons = kbData(kb).flat();
    expect(buttons.length).toBe(2);
    expect(buttons[0]?.callback_data).toBe('mn:2026-05');
    expect(buttons[1]?.callback_data).toBe('mn:2026-07');
  });

  test('wraps year on January prev', () => {
    const kb = monthNavKeyboard('2026-01');
    const buttons = kbData(kb).flat();
    expect(buttons[0]?.callback_data).toBe('mn:2025-12');
  });

  test('wraps year on December next', () => {
    const kb = monthNavKeyboard('2026-12');
    const buttons = kbData(kb).flat();
    expect(buttons[1]?.callback_data).toBe('mn:2027-01');
  });
});

// ── Notification keyboards ──

describe('notifyMenuKeyboard', () => {
  test('has morning, reminders, evening, quiet buttons', () => {
    const kb = notifyMenuKeyboard('en');
    const buttons = kbData(kb).flat();
    expect(buttons.some((b) => b.callback_data === 'nf:morning')).toBe(true);
    expect(buttons.some((b) => b.callback_data === 'nf:reminders')).toBe(true);
    expect(buttons.some((b) => b.callback_data === 'nf:evening')).toBe(true);
    expect(buttons.some((b) => b.callback_data === 'nf:quiet')).toBe(true);
  });
});

describe('notifyMorningKeyboard', () => {
  test('enabled state shows Disable', () => {
    const kb = notifyMorningKeyboard(true);
    const buttons = kbData(kb).flat();
    expect(buttons.some((b) => b.text.includes('Disable'))).toBe(true);
  });

  test('disabled state shows Enable', () => {
    const kb = notifyMorningKeyboard(false);
    const buttons = kbData(kb).flat();
    expect(buttons.some((b) => b.text.includes('Enable'))).toBe(true);
  });

  test('has back button', () => {
    const kb = notifyMorningKeyboard(true);
    const buttons = kbData(kb).flat();
    expect(buttons.some((b) => b.callback_data === 'nf:menu')).toBe(true);
  });
});

describe('notifyHourPickerKeyboard', () => {
  test('has hours 5 through 23 plus back', () => {
    const kb = notifyHourPickerKeyboard('morning');
    const buttons = kbData(kb).flat();
    expect(buttons.some((b) => b.text === '05')).toBe(true);
    expect(buttons.some((b) => b.text === '23')).toBe(true);
    expect(buttons.some((b) => b.callback_data === 'nf:morning')).toBe(true);
  });
});

describe('notifyMinutePickerKeyboard', () => {
  test('has :00, :15, :30, :45 and back', () => {
    const kb = notifyMinutePickerKeyboard('morning', '08');
    const buttons = kbData(kb).flat();
    expect(buttons.some((b) => b.text === ':00')).toBe(true);
    expect(buttons.some((b) => b.text === ':45')).toBe(true);
    expect(buttons.some((b) => b.callback_data === 'nf:morning:minute:08:00')).toBe(true);
    expect(buttons.some((b) => b.callback_data === 'nf:morning:time')).toBe(true);
  });
});

describe('notifyReminderIntervalsKeyboard', () => {
  test('shows active intervals with check marks', () => {
    const kb = notifyReminderIntervalsKeyboard([5, 30]);
    const buttons = kbData(kb).flat();
    const fiveMinBtn = buttons.find((b) => b.callback_data === 'nf:reminders:toggle:5');
    expect(fiveMinBtn?.text).toContain('✅');
    const fifteenMinBtn = buttons.find((b) => b.callback_data === 'nf:reminders:toggle:15');
    expect(fifteenMinBtn?.text).toContain('❌');
  });

  test('has back button', () => {
    const kb = notifyReminderIntervalsKeyboard([]);
    const buttons = kbData(kb).flat();
    expect(buttons.some((b) => b.callback_data === 'nf:menu')).toBe(true);
  });
});

describe('notifyEveningKeyboard', () => {
  test('enabled shows Disable', () => {
    const kb = notifyEveningKeyboard(true);
    const buttons = kbData(kb).flat();
    expect(buttons.some((b) => b.text.includes('Disable'))).toBe(true);
  });

  test('disabled shows Enable', () => {
    const kb = notifyEveningKeyboard(false);
    const buttons = kbData(kb).flat();
    expect(buttons.some((b) => b.text.includes('Enable'))).toBe(true);
  });
});

describe('notifyQuietKeyboard', () => {
  test('enabled shows Disable, Change Start, Change End', () => {
    const kb = notifyQuietKeyboard(true);
    const buttons = kbData(kb).flat();
    expect(buttons.some((b) => b.text.includes('Disable'))).toBe(true);
    expect(buttons.some((b) => b.text.includes('Change Start'))).toBe(true);
    expect(buttons.some((b) => b.text.includes('Change End'))).toBe(true);
  });

  test('disabled shows only Enable', () => {
    const kb = notifyQuietKeyboard(false);
    const buttons = kbData(kb).flat();
    expect(buttons.some((b) => b.text.includes('Enable'))).toBe(true);
    expect(buttons.every((b) => !b.text.includes('Change Start'))).toBe(true);
  });
});

// ── removeKeyboard ──

describe('removeKeyboard', () => {
  test('returns remove_keyboard: true', () => {
    const result = removeKeyboard();
    expect(result).toEqual({ reply_markup: { remove_keyboard: true } });
  });
});

// ── inviteContactPickerKeyboard ──

describe('inviteContactPickerKeyboard', () => {
  const makeContact = (id: number, name: string, telegramId: number | null, username?: string, preferred?: string) => ({
    id,
    user_id: 1,
    name,
    username: username ?? null,
    telegram_id: telegramId,
    preferred_name: preferred ?? null,
    created_at: '2026-01-01T00:00:00Z',
  });

  test('includes only contacts with telegram_id', () => {
    const contacts = [makeContact(1, 'Alice', 100), makeContact(2, 'Bob', null)];
    const kb = inviteContactPickerKeyboard(contacts, 5, 'en');
    const rows = kbData(kb);
    const allButtons = rows.flat();
    const contactButtons = allButtons.filter(
      (b) =>
        b.callback_data?.startsWith('invc:5:') &&
        !['picker', 'chat', 'cancel'].some((s) => b.callback_data?.endsWith(s)),
    );
    expect(contactButtons).toHaveLength(1);
    expect(contactButtons[0]!.callback_data).toBe('invc:5:100');
  });

  test('uses preferred_name when set', () => {
    const contacts = [makeContact(1, 'Alice Smith', 100, undefined, 'Alice')];
    const kb = inviteContactPickerKeyboard(contacts, 5, 'en');
    const rows = kbData(kb);
    const allButtons = rows.flat();
    const btn = allButtons.find((b) => b.callback_data === 'invc:5:100');
    expect(btn?.text).toContain('Alice');
    expect(btn?.text).not.toContain('Smith');
  });

  test('appends @username when present', () => {
    const contacts = [makeContact(1, 'Bob', 200, 'bobov')];
    const kb = inviteContactPickerKeyboard(contacts, 7, 'en');
    const rows = kbData(kb);
    const btn = rows.flat().find((b) => b.callback_data === 'invc:7:200');
    expect(btn?.text).toContain('@bobov');
  });

  test('always includes Other user, Group chat, Cancel buttons', () => {
    const kb = inviteContactPickerKeyboard([], 3, 'en');
    const allData = kbData(kb)
      .flat()
      .map((b) => b.callback_data);
    expect(allData).toContain('invc:3:picker');
    expect(allData).toContain('invc:3:chat');
    expect(allData).toContain('invc:cancel');
  });

  test('ru locale uses Russian labels', () => {
    const kb = inviteContactPickerKeyboard([], 3, 'ru');
    const allText = kbData(kb)
      .flat()
      .map((b) => b.text);
    expect(allText.some((t) => t.includes('Другой'))).toBe(true);
    expect(allText.some((t) => t.includes('Групповой'))).toBe(true);
    expect(allText.some((t) => t.includes('Отмена'))).toBe(true);
  });
});
