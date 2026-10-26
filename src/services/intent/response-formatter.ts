// The text a rule sends: the last tool's result rendered for the user (answer-renderers.ts), a rule's own sentence, or
// the legacy JSON `format`s of learned rules. Tool text is written for the AI agent, so it is never forwarded when
// the structured result can be rendered.
import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { z } from 'zod';
import { jsonCodec } from '../../utils/json-codec.ts';
import { cmdLogger } from '../../utils/logger.ts';
import {
  plainAnswer,
  type RenderContext,
  type RenderedAnswer,
  renderAgenda,
  renderSettingsOutput,
  renderToolAnswer,
  type ToolAnswer,
} from './answer-renderers.ts';
import { wordingFor } from './answer-wording.ts';
import { type HumanTimeContext, humanDay, humanDayHeading, humanDayParts } from './human-time.ts';
import type { EventSummary } from './variable-resolver.ts';

const EventsListCodec = jsonCodec(
  z.array(z.object({ title: z.string(), start_at: z.string(), end_at: z.string().optional() })),
);
const FreeSlotsCodec = jsonCodec(z.array(z.object({ start: z.string(), end: z.string() })));
const SearchResultsCodec = jsonCodec(z.array(z.object({ title: z.string(), start_at: z.string() })));
const HolidaysCodec = jsonCodec(z.array(z.object({ name: z.string(), date: z.string() })));

/**
 * Render events the user can read: `HH:MM  Title`. When every event falls on today
 * (in the user's timezone) the date is left out; otherwise every line carries its
 * date, today's too. A single result from `get_upcoming` or `search_events` can land
 * weeks away, so a lone future event needs its date, and an undated line inside a
 * dated list reads as belonging to the day above it. All-day events carry no time.
 *
 * This is the compact form the reply-time guard quotes as verified evidence; a rule's own
 * answer is the headed agenda of renderAnswer.
 */
export function formatEventSummaries(events: EventSummary[], timezone: string): string {
  const todayKey = format(new TZDate(new Date(), timezone), 'yyyy-MM-dd');
  const dated = events.some((event) => event.date !== todayKey);
  return events
    .map((event) => {
      const when = [dated ? event.date : '', event.all_day ? '' : (event.time ?? '')].filter(Boolean).join(' ');
      return `${when}  ${event.title}`.trim();
    })
    .join('\n');
}

/**
 * The answer for a rule whose last step was a tool call, or the plain text of a rule's own sentence.
 * @param legacyFormat - the rule's stored `format`; only learned rules use anything but 'text'
 * @param response - what the workflow returned as its text (a tool's output or a `respond` sentence)
 * @param answer - the last tool's structured result; absent when the workflow ended in a `respond` sentence
 */
export function renderAnswer(
  legacyFormat: string,
  response: string,
  answer: ToolAnswer | undefined,
  context: RenderContext,
): RenderedAnswer {
  try {
    if (answer) return renderToolAnswer(answer, context);
    // A sentence the rule itself wrote is not a read result; whether it ends the conversation is the executor's call.
    return { text: renderLegacy(legacyFormat, response, context), complete: false };
  } catch (error) {
    cmdLogger.warn({ err: error, tool: answer?.tool }, 'Intent answer could not be rendered, showing the tool text');
    return { text: plainAnswer(answer?.output ?? response, context.language).text, complete: false };
  }
}

/** One day of a several-day answer: the day that was read and what the read returned for it. */
export interface DayAnswer {
  /** YYYY-MM-DD in the user's timezone. */
  day: string;
  response?: string;
  answer?: ToolAnswer;
}

/**
 * Answer for several days, each under a heading with the day relative to today, its weekday and
 * date ("Сегодня, пн 14 сентября:"), then that day's events or the tool's own text about it. Weekday and
 * date come from the calendar day itself, never from generated text.
 */
export function formatDayAnswers(answers: DayAnswer[], context: HumanTimeContext): RenderedAnswer {
  const bodies = answers.map(({ day, response, answer }) => {
    // The heading names the day, so the day's own lines carry no heading of their own.
    const body = answer
      ? renderToolAnswer(answer, { ...context, headings: false })
      : { text: plainAnswer(response ?? '', context.language).text, complete: false };
    return { text: `${humanDayHeading(day, context)}:\n${body.text}`, complete: body.complete };
  });
  return { text: bodies.map((body) => body.text).join('\n\n'), complete: bodies.every((body) => body.complete) };
}

function renderLegacy(legacyFormat: string, response: string, context: RenderContext): string {
  const words = wordingFor(context.language);
  const plain = (): string => plainAnswer(response, context.language).text;
  switch (legacyFormat) {
    case 'events_list': {
      const events = EventsListCodec.safeParse(response);
      if (!events.success) return plain();
      if (events.data.length === 0) return words.emptyList;
      return renderAgenda(
        events.data.map((event, index) => legacyEvent(index, event, context.timezone)),
        context,
        'personal',
      );
    }
    case 'free_slots': {
      const slots = FreeSlotsCodec.safeParse(response);
      if (!slots.success) return plain();
      return slots.data.length === 0
        ? `${capitalize(words.noFreeWindowsInline)}.`
        : legacyFreeWindows(slots.data, context);
    }
    case 'search_results': {
      const events = SearchResultsCodec.safeParse(response);
      if (!events.success) return plain();
      if (events.data.length === 0) return words.emptyList;
      return events.data
        .map((event, index) => {
          const { date, time } = localStart(event.start_at, context.timezone);
          return `${index + 1}. ${humanDay(date, context)}, ${time}  ${event.title}`;
        })
        .join('\n');
    }
    case 'holidays': {
      const holidays = HolidaysCodec.safeParse(response);
      if (!holidays.success) return plain();
      if (holidays.data.length === 0) return words.nothingFound;
      return holidays.data.map((holiday) => `${humanDay(holiday.date, context)} — ${holiday.name}`).join('\n');
    }
    case 'settings':
      return renderSettingsOutput(response, undefined, context) ?? plain();
    default:
      return plain();
  }
}

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

function localStart(instant: string, timezone: string): { date: string; time: string } {
  const local = new TZDate(Date.parse(instant), timezone);
  return { date: format(local, 'yyyy-MM-dd'), time: format(local, 'HH:mm') };
}

function legacyEvent(
  index: number,
  event: { title: string; start_at: string; end_at?: string | undefined },
  timezone: string,
): EventSummary {
  const { date, time } = localStart(event.start_at, timezone);
  return {
    id: index + 1,
    title: event.title,
    date,
    time,
    all_day: false,
    ...(event.end_at ? { end_at: event.end_at } : {}),
  };
}

/** Free windows of a learned rule, one sentence per local day they fall on. */
function legacyFreeWindows(slots: Array<{ start: string; end: string }>, context: RenderContext): string {
  const words = wordingFor(context.language);
  const days: Array<{ day: string; windows: string[] }> = [];
  for (const slot of slots) {
    const { date, time } = localStart(slot.start, context.timezone);
    const window = `${time}–${localStart(slot.end, context.timezone).time}`;
    const last = days.at(-1);
    if (last && last.day === date) last.windows.push(window);
    else days.push({ day: date, windows: [window] });
  }
  return days
    .map(({ day, windows }) => {
      const parts = humanDayParts(day, context);
      return parts ? words.freeWindows(parts, windows.join(', ')) : windows.join(', ');
    })
    .join('\n');
}
