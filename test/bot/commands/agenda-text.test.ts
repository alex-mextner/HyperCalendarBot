// Synthetic transport proof: no bot API calls, and picker controls stay on the final message.
import { expect, test } from 'bun:test';
import { sendAgendaText } from '../../../src/bot/commands/agenda-text.ts';
import { formatDayAgenda, formatEventListItem, formatWeekAgenda } from '../../../src/services/event/formatters.ts';
import { splitMessage } from '../../../src/utils/telegram.ts';
import { agendaOccurrences } from '../../fixtures/agenda269.ts';

for (const name of ['day', 'week', 'search']) {
  test(`${name} text sends every escaped chunk through the agenda transport`, async () => {
    const occurrences = agendaOccurrences().map((occ) => ({
      ...occ,
      event: { ...occ.event, description: '<notes> & 😀 '.repeat(900) },
    }));
    const text =
      name === 'day'
        ? formatDayAgenda(occurrences, '2026-03-11', 'UTC', 'en')
        : name === 'week'
          ? formatWeekAgenda(occurrences, '2026-03-09', '2026-03-15', 'UTC', 'en')
          : occurrences.map((occ, i) => formatEventListItem(occ.event, 'UTC', i)).join('\n');
    const sent: { text: string; options: Parameters<Parameters<typeof sendAgendaText>[0]['send']>[1] }[] = [];
    const keyboard = { inline_keyboard: [[{ text: 'Open', callback_data: 'synthetic:1' }]] };
    await sendAgendaText(
      {
        send: async (text, options) => {
          sent.push({ text, options });
        },
      },
      text,
      { reply_markup: keyboard },
    );
    expect(sent.map((message) => message.text)).toEqual(splitMessage(text, 4000, 'HTML'));
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.every((message) => message.options?.parse_mode === 'HTML')).toBe(true);
    expect(sent.slice(0, -1).every((message) => !message.options?.reply_markup)).toBe(true);
    expect(sent.at(-1)?.options?.reply_markup).toEqual(keyboard);
  });
}
