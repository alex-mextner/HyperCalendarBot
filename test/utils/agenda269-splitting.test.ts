// Long synthetic agenda text must survive the existing transport splitter as valid HTML.
import { expect, test } from 'bun:test';
import {
  formatDayAgenda,
  formatEventDetail,
  formatEventListItem,
  formatWeekAgenda,
} from '../../src/services/event/formatters.ts';
import { splitMessage, stripHtml } from '../../src/utils/telegram.ts';
import { agendaEvent } from '../fixtures/agenda269.ts';

const event = agendaEvent({
  title: 'Long <meeting>',
  description: 'Notes <safe> & "quoted" 😀 '.repeat(600),
  location: 'Room <East> & West',
  displayMetadata: { invitationStatus: 'Pending & accepted' },
});
const occurrences = [{ event, occurrence_start: event.start_at, occurrence_end: event.end_at, is_exception: false }];
for (const [name, text] of Object.entries({
  day: formatDayAgenda(occurrences, '2026-03-11', 'UTC', 'en'),
  week: formatWeekAgenda(occurrences, '2026-03-09', '2026-03-15', 'UTC', 'en'),
  detail: formatEventDetail(event, 'UTC', 'en'),
  search: formatEventListItem(event, 'UTC', 0),
})) {
  test(`${name} splits safely without losing description or breaking entities`, () => {
    const chunks = splitMessage(text, 4000, 'HTML');
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4000);
      expect(chunk).not.toMatch(/&(?!amp;|lt;|gt;|quot;)/);
      expect(chunk.match(/<b>/g)?.length ?? 0).toBe(chunk.match(/<\/b>/g)?.length ?? 0);
      expect(chunk.match(/<a /g)?.length ?? 0).toBe(chunk.match(/<\/a>/g)?.length ?? 0);
    }
    expect(chunks.map(stripHtml).join('')).toBe(stripHtml(text));
  });
}
test('splits inside a long linked label, closing and reopening its anchor', () => {
  const text = `<b>Title</b>\n<a href="https://example.test/">${'Room &amp; 😀 '.repeat(900)}</a>`;
  const chunks = splitMessage(text, 4000, 'HTML');
  expect(chunks.map(stripHtml).join('')).toBe(stripHtml(text));
  for (const chunk of chunks) {
    expect(chunk.length).toBeLessThanOrEqual(4000);
    expect(chunk.match(/<a /g)?.length ?? 0).toBe(chunk.match(/<\/a>/g)?.length ?? 0);
    expect(chunk).not.toMatch(/&(?!amp;)/);
  }
});

for (const location of ['Ж'.repeat(700), '<&"Ж>'.repeat(700)]) {
  test(`oversized generated maps link preserves ${location.length} location characters`, () => {
    const located = agendaEvent({ location, google_maps_url: null, resolved_address: null });
    const text = formatDayAgenda(
      [{ event: located, occurrence_start: located.start_at, occurrence_end: located.end_at, is_exception: false }],
      '2026-03-11',
      'UTC',
      'en',
    );
    const chunks = splitMessage(text, 4000, 'HTML');
    expect(chunks.map(stripHtml).join('')).toContain(location);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4000);
      expect(chunk.match(/<a /g)?.length ?? 0).toBe(chunk.match(/<\/a>/g)?.length ?? 0);
      for (const match of chunk.matchAll(/href="([^"]+)"/g)) {
        expect(() => new URL(match[1]!.replaceAll('&amp;', '&'))).not.toThrow();
      }
    }
  });
}
