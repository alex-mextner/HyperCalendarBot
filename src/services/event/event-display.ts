// src/services/event/event-display.ts
//
// Reached from: the `show_event` AI tool handler (src/services/ai/tool-handlers/events.ts,
// used by both the AI tool-call path and the deterministic intent-matcher path — they share
// the exact same handler via executeTool), the `CB.EVENT_VIEW` callback
// (src/bot/handlers/callback.handler.ts) and the `/event` command (src/bot/commands/event.ts).
// One canonical single-event card (GH-653 / design doc §26): every entrypoint that shows a
// specific existing event to a user renders through `buildCanonicalEventCard`, so the AI answer
// to "show today's meeting" is byte-identical in structure to what /edit or a search-result tap
// produce for the same event.
//
// Invariant: every function here is pure and read-only — no DB or Telegram I/O. Occurrence
// projection (`eventForOccurrence`, `eventAtOccurrenceStart`) is an in-memory reshaping of
// already-fetched data, never a write. Do NOT call `EventService.editOccurrence` from a display
// path: it persists a new exception row (see its docstring) — a pure read must never mutate.
import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { InlineKeyboard } from 'gramio';
import { eventActionsKeyboard, eventActionsKeyboardOcc } from '../../bot/keyboards.ts';
import type { CalendarEvent, EventOccurrence } from '../../database/types.ts';
import { formatDateShort, formatTime } from '../../utils/date.ts';
import { withMapButton } from '../location/event-venue.ts';
import { formatEventDetail } from './formatters.ts';

export type DisplayLang = 'en' | 'ru';

export interface CanonicalEventCard {
  text: string;
  keyboard: InlineKeyboard;
}

/**
 * Project an `EventOccurrence` (from a range read) onto a display-only `CalendarEvent` whose
 * start/end are this specific occurrence's instants, not the recurring series' original
 * `start_at`. Every other field (title, description, location, recurrence_rule, …) is the
 * template's. Pure — returns a new object, never touches the database.
 */
export function eventForOccurrence(occ: EventOccurrence): CalendarEvent {
  return { ...occ.event, start_at: occ.occurrence_start, end_at: occ.occurrence_end };
}

/**
 * Same projection as `eventForOccurrence`, from an already-fetched master event plus a known
 * occurrence start instant (e.g. the `id:occurrenceDate` callback payload convention shared with
 * `CB.EVENT_EDIT`/`CB.EVENT_DELETE`). Preserves the template's duration — the same math
 * `EventService.editOccurrence` uses, but computed in memory instead of persisted as an
 * exception row.
 */
export function eventAtOccurrenceStart(event: CalendarEvent, occurrenceStart: string): CalendarEvent {
  const end_at = event.end_at
    ? new Date(
        new Date(occurrenceStart).getTime() + (new Date(event.end_at).getTime() - new Date(event.start_at).getTime()),
      ).toISOString()
    : event.end_at;
  return { ...event, start_at: occurrenceStart, end_at };
}

/**
 * The canonical single-event card: `formatEventDetail`'s text plus the same view-action
 * keyboard `CB.EVENT_VIEW` already uses (Edit/Delete, then Map when the event has a confirmed
 * place). `occurrenceDate` is the exact occurrence instant this card is showing; for a recurring
 * series the buttons carry the `id:occurrenceDate` payload (occurrence-scoped edit/delete)
 * instead of editing the template. A one-off event gets the plain `id` payload whatever the
 * caller passed, so every surface shows the same buttons for the same event.
 * `event` must already be occurrence-projected by the caller when `occurrenceDate` is set.
 */
export function buildCanonicalEventCard(
  event: CalendarEvent,
  timezone: string,
  lang: DisplayLang,
  occurrenceDate?: string,
): CanonicalEventCard {
  const actions =
    occurrenceDate && event.recurrence_rule
      ? eventActionsKeyboardOcc(event.id, occurrenceDate, lang)
      : eventActionsKeyboard(event.id, lang);
  return {
    text: formatEventDetail(event, timezone, lang),
    keyboard: withMapButton(actions, event, lang),
  };
}

/**
 * A picker over occurrences, one row per match, each carrying `id:occurrenceStart` — the same
 * `CB.EVENT_EDIT`/`CB.EVENT_DELETE` payload convention `CB.EVENT_VIEW` already understands — so
 * a tap re-opens exactly the tapped occurrence's card, not the series' template date, even when
 * two instances of one recurring series both match the same query. When the matches fall on
 * different local days each label also names its day, so "10:00" alone never stands for two dates.
 */
export function buildEventPicker(
  occurrences: EventOccurrence[],
  timezone: string,
  prefix: string,
  lang: DisplayLang,
): InlineKeyboard {
  const shown = occurrences.slice(0, 10);
  const multiDay =
    new Set(shown.map((occ) => format(new TZDate(new Date(occ.occurrence_start), timezone), 'yyyy-MM-dd'))).size > 1;
  const kb = new InlineKeyboard();
  for (let i = 0; i < shown.length; i++) {
    const occ = shown[i]!;
    const time = formatTime(occ.occurrence_start, timezone);
    const when = multiDay ? `${formatDateShort(occ.occurrence_start, timezone, lang)} ${time}` : time;
    const label = `${i + 1}. ${when} ${occ.event.title.slice(0, 20)}`;
    kb.text(label, `${prefix}:${occ.event.id}:${occ.occurrence_start}`).row();
  }
  kb.text(lang === 'ru' ? 'Отмена' : 'Cancel', `${prefix}:cancel`);
  return kb;
}

export type EventDisplayDecision =
  | { kind: 'single'; event: CalendarEvent; occurrenceDate: string }
  | { kind: 'multiple'; occurrences: EventOccurrence[] }
  | { kind: 'empty' };

/**
 * Single match → its card; several matches → a picker (never the first guess); no matches →
 * empty. A failed read is never represented here — the caller must distinguish "the read
 * succeeded and found nothing" from "the read failed" before calling this.
 */
export function decideEventDisplay(occurrences: EventOccurrence[]): EventDisplayDecision {
  if (occurrences.length === 0) return { kind: 'empty' };
  if (occurrences.length === 1) {
    const occ = occurrences[0]!;
    return { kind: 'single', event: eventForOccurrence(occ), occurrenceDate: occ.occurrence_start };
  }
  return { kind: 'multiple', occurrences };
}
