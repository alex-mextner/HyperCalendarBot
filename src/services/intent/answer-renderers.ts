// What a rule's last tool returned, rendered for the person who asked: a headed agenda, free windows, a clock, a short
// settings list, contacts. Tool text is written for the AI agent (ids, UTC instants, English field names), so a rule
// answer never forwards it when the structured data or a known JSON shape can be rendered instead.
//
// Invariants:
// - Only a successful tool result reaches this module; a failed read is an error elsewhere, never an empty answer.
// - Events become an agenda only for READ tools. A write (create/update/delete) is confirmed in a sentence that names
//   the exact event, never by listing it as if it were a result of a read.
// - An unknown JSON shape is said to be unknown in the user's language; JSON is never shown.
import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { z } from 'zod';
import { jsonCodec } from '../../utils/json-codec.ts';
import { extractEventSummaries } from '../ai/event-summaries.ts';
import type { ContactMatch, FreeSlotsData, ToolResult, ToolResultData } from '../ai/types.ts';
import {
  type AnswerWording,
  type CalendarKind,
  type ConfirmedWrite,
  type SettingsCategory,
  wordingFor,
} from './answer-wording.ts';
import { type HumanTimeContext, humanDay, humanDayHeading, humanDayParts, nextDay } from './human-time.ts';
import type { EventSummary } from './variable-resolver.ts';

/** What the last tool of a rule returned, as the executor saw it. */
export interface ToolAnswer {
  tool: string;
  /** The resolved input the tool ran with. */
  input: { [key: string]: unknown };
  output: string;
  data?: ToolResultData;
  effect?: ToolResult['effect'];
}

export interface RenderContext extends HumanTimeContext {
  /** A day-by-day answer prints the day itself, so the day's own lines carry no heading. */
  headings?: boolean;
}

export interface RenderedAnswer {
  text: string;
}

const rendered = (text: string): RenderedAnswer => ({ text });

/** Tools whose result is a list of calendar events to show as an agenda. */
const EVENT_READS: { [tool: string]: true } = {
  get_events: true,
  get_upcoming: true,
  search_events: true,
  get_event: true,
};

const JSON_LIKE = /^\s*[[{]/;

function calendarKind(input: ToolAnswer['input']): CalendarKind {
  if (input.owner_id !== undefined && input.owner_id !== null) return 'selected';
  return input.scope === 'group' ? 'group' : 'personal';
}

// ---- events ----

function eventTimeLabel(event: EventSummary, context: RenderContext, words: AnswerWording): string {
  if (event.all_day) return words.allDay;
  const start = event.time ?? '';
  if (!event.end_at || Number.isNaN(Date.parse(event.end_at))) return start;
  const end = new TZDate(Date.parse(event.end_at), context.timezone);
  const endDay = format(end, 'yyyy-MM-dd');
  const endClock = format(end, 'HH:mm');
  if (endDay === event.date) return endClock === start ? start : `${start}–${endClock}`;
  // An event that ends at midnight belongs to its own day; anything later names the day it runs into.
  if (endDay === nextDay(event.date) && endClock === '00:00') return `${start}–${endClock}`;
  const until = humanDayParts(endDay, context)?.calendar ?? endDay;
  return `${start}–${endClock} ${words.endsOn(until)}`;
}

function eventLine(event: EventSummary, context: RenderContext, words: AnswerWording): string {
  const place = event.location ? ` — ${event.location}` : '';
  return `${eventTimeLabel(event, context, words)}  ${event.title}${place}`.trim();
}

/** Events grouped by the day they start on, in the order the read returned them. */
function groupByDay(events: EventSummary[]): Array<{ day: string; events: EventSummary[] }> {
  const groups: Array<{ day: string; events: EventSummary[] }> = [];
  for (const event of events) {
    const last = groups.at(-1);
    if (last && last.day === event.date) last.events.push(event);
    else groups.push({ day: event.date, events: [event] });
  }
  return groups;
}

export function renderAgenda(events: EventSummary[], context: RenderContext, kind: CalendarKind): string {
  const words = wordingFor(context.language);
  const headings = context.headings !== false;
  const body = groupByDay(events).map(({ day, events: dayEvents }) => {
    const lines = dayEvents.map((event) => eventLine(event, context, words));
    return headings ? [`${humanDayHeading(day, context)}:`, ...lines].join('\n') : lines.join('\n');
  });
  const lead = headings ? words.calendarLead(kind) : null;
  return [...(lead ? [lead] : []), body.join('\n\n')].join('\n');
}

function recurrenceLabel(rule: string, words: AnswerWording): string {
  const freq = /FREQ=(\w+)/.exec(rule)?.[1];
  const interval = /INTERVAL=(\d+)/.exec(rule)?.[1];
  const every = freq && (interval === undefined || interval === '1') ? words.eventCard.repeatsEvery[freq] : undefined;
  return every ?? words.eventCard.repeatsOften;
}

function renderEventCard(event: EventSummary, context: RenderContext, kind: CalendarKind): string {
  const words = wordingFor(context.language);
  const card = [event.title, `${humanDayHeading(event.date, context)}, ${eventTimeLabel(event, context, words)}`];
  if (event.location) card.push(`${words.eventCard.place}: ${event.location}`);
  if (event.description) card.push(`${words.eventCard.description}: ${event.description}`);
  if (event.recurrence_rule) card.push(`${words.eventCard.repeats}: ${recurrenceLabel(event.recurrence_rule, words)}`);
  const lead = words.calendarLead(kind);
  return [...(lead ? [lead] : []), ...card].join('\n');
}

function renderEvents(answer: ToolAnswer, context: RenderContext): RenderedAnswer | null {
  const events = extractEventSummaries(answer.data);
  const kind = calendarKind(answer.input);
  if (events === undefined) {
    // An empty read keeps the tool's own sentence: it names the checked day or window and the calendar.
    return Array.isArray(answer.data) && answer.data.length === 0 && !JSON_LIKE.test(answer.output)
      ? rendered(answer.output)
      : null;
  }
  if (answer.tool === 'get_event' && events.length === 1) return rendered(renderEventCard(events[0]!, context, kind));
  return rendered(renderAgenda(events, context, kind));
}

/** The exact target of a confirmed write, in words: «Ревью дизайна» — послезавтра, пт 9 октября, 14:00–15:00. */
function renderConfirmation(answer: ToolAnswer, context: RenderContext): RenderedAnswer | null {
  const event = extractEventSummaries(answer.data)?.[0];
  if (!event) return null;
  const words = wordingFor(context.language);
  const write: ConfirmedWrite =
    answer.tool === 'create_event' ? 'created' : answer.tool === 'update_event' ? 'updated' : 'deleted';
  const when = `${humanDay(event.date, context)}, ${eventTimeLabel(event, context, words)}`;
  return rendered(words.confirmed(write, event.title, when));
}

/** One line per event for a sentence that asks the user to choose: the id is what they can type back. */
function renderChoices(events: EventSummary[], context: RenderContext): string {
  const words = wordingFor(context.language);
  return events
    .map((event) => {
      const when = `${humanDay(event.date, context)}, ${eventTimeLabel(event, context, words)}`;
      return `#${event.id}  ${event.title} — ${when}`;
    })
    .join('\n');
}

// ---- free windows ----

function clock(instant: string, timezone: string): string {
  return format(new TZDate(Date.parse(instant), timezone), 'HH:mm');
}

function hasFreeSlots(data: ToolResultData | undefined): data is FreeSlotsData {
  return data !== undefined && !Array.isArray(data) && 'slots' in data;
}

function freeWindowsText(slots: FreeSlotsData['slots'], context: RenderContext, words: AnswerWording): string {
  if (slots.length === 0) return words.noFreeWindowsInline;
  const spans = slots.map((slot) => ({
    from: clock(slot.start, context.timezone),
    to: clock(slot.end, context.timezone),
  }));
  // A day with nothing in it comes back as one 00:00–23:59 window; "all day" says that without two clocks.
  if (spans.length === 1 && spans[0]!.from === '00:00' && (spans[0]!.to === '23:59' || spans[0]!.to === '00:00'))
    return words.freeAllDay;
  return spans.map((span) => `${span.from}–${span.to}`).join(', ');
}

/** The day a free-slots read was asked about: a bare date is that day, any other value an instant read in the user's zone. */
function requestedDay(value: unknown, timezone: string): string | null {
  if (typeof value !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : format(new TZDate(ms, timezone), 'yyyy-MM-dd');
}

function renderFreeSlots(answer: ToolAnswer, context: RenderContext): RenderedAnswer | null {
  if (!hasFreeSlots(answer.data)) return null;
  const words = wordingFor(context.language);
  const day = requestedDay(answer.input.date, context.timezone);
  const parts = day === null ? null : humanDayParts(day, context);
  if (parts === null) return null;
  const { slots } = answer.data;
  if (slots.length === 0) return rendered(words.freeNowhere(parts, words.inCalendar(calendarKind(answer.input))));
  return rendered(words.freeWindows(parts, freeWindowsText(slots, context, words)));
}

// ---- time ----

const ZoneSchema = z.object({ timezone: z.string(), utc_offset: z.string(), local_time: z.string() });
const ZoneCodec = jsonCodec(ZoneSchema);
const ZonesCodec = jsonCodec(z.object({ timezones: z.array(ZoneSchema), difference_hours: z.number().optional() }));
const ConvertedCodec = jsonCodec(
  z.object({ timezone: z.string(), local_datetime: z.string(), utc_offset: z.string() }),
);

/** "+09:00" → "UTC+9", "+05:30" → "UTC+5:30", "+00:00" → "UTC". */
function offsetLabel(offset: string): string {
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(offset);
  if (!match) return offset;
  const hours = Number(match[2]);
  const minutes = match[3] === '00' ? '' : `:${match[3]}`;
  return hours === 0 && minutes === '' ? 'UTC' : `UTC${match[1]}${hours}${minutes}`;
}

function capitalizeWords(text: string): string {
  return text.replace(/(^|[\s-])(\p{L})/gu, (_, lead: string, letter: string) => `${lead}${letter.toUpperCase()}`);
}

/** Where the asked clock is: null for the user's own zone, a city as the user wrote it, or the zone id. */
function zonePlace(requested: unknown, ownZone: string, words: AnswerWording): string | null {
  if (typeof requested !== 'string' || requested.trim() === '' || requested === ownZone) return null;
  return requested.includes('/') || requested === 'UTC'
    ? words.timeInZone(requested)
    : capitalizeWords(requested.trim());
}

function zoneSentence(
  zone: { timezone: string; offset: string; localTime: string },
  input: { place: string | null; atInstant: boolean },
  context: RenderContext,
): string | null {
  const stamp = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(zone.localTime);
  if (!stamp) return null;
  const words = wordingFor(context.language);
  const date = humanDayParts(stamp[1]!, context)?.calendar ?? stamp[1]!;
  const zoneName = input.place === null ? zone.timezone : null;
  const compose = input.atInstant ? words.timeAt : words.timeNow;
  return compose(input.place, stamp[2]!, date, offsetLabel(zone.offset), zoneName);
}

function renderTimezoneInfo(answer: ToolAnswer, context: RenderContext): RenderedAnswer | null {
  const words = wordingFor(context.language);
  const atInstant = typeof answer.input.at === 'string';
  const single = ZoneCodec.safeParse(answer.output);
  if (single.success) {
    const place = zonePlace(answer.input.timezone, context.timezone, words);
    const text = zoneSentence(
      { timezone: single.data.timezone, offset: single.data.utc_offset, localTime: single.data.local_time },
      { place, atInstant },
      context,
    );
    return text === null ? null : rendered(text);
  }
  const many = ZonesCodec.safeParse(answer.output);
  if (!many.success) return null;
  const lines: string[] = [];
  for (const zone of many.data.timezones) {
    const line = zoneSentence(
      { timezone: zone.timezone, offset: zone.utc_offset, localTime: zone.local_time },
      { place: words.timeInZone(zone.timezone), atInstant },
      context,
    );
    if (line === null) return null;
    lines.push(line);
  }
  const gap = many.data.timezones.length === 2 && many.data.difference_hours !== undefined;
  return rendered([...lines, ...(gap ? [words.timeDifference(many.data.difference_hours!)] : [])].join('\n'));
}

function renderConverted(answer: ToolAnswer, context: RenderContext): RenderedAnswer | null {
  const converted = ConvertedCodec.safeParse(answer.output);
  if (!converted.success) return null;
  const text = zoneSentence(
    { timezone: converted.data.timezone, offset: converted.data.utc_offset, localTime: converted.data.local_datetime },
    { place: wordingFor(context.language).timeInZone(converted.data.timezone), atInstant: true },
    context,
  );
  return text === null ? null : rendered(text);
}

// ---- settings ----

const SettingsValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
type SettingsValueType = z.infer<typeof SettingsValue>;
const SettingsRecordCodec = jsonCodec(z.looseObject({}));
const FlatSettings = z.record(z.string(), SettingsValue);
const SETTINGS_CATEGORIES: readonly SettingsCategory[] = ['general', 'notifications', 'calls', 'privacy', 'voice'];

/** The keys of each category in the order a person reads them; anything else the tool returns is internal. */
const SETTINGS_KEYS: { [category in SettingsCategory]: readonly string[] } = {
  // Name and username are the Telegram profile, not a setting; they only add noise to a settings list.
  general: ['timezone', 'language', 'country_code', 'default_event_duration_minutes'],
  notifications: [
    'morning_agenda_enabled',
    'evening_review_enabled',
    'quiet_hours_enabled',
    'default_reminder_intervals',
  ],
  calls: ['enabled', 'max_daily_calls', 'important_only'],
  privacy: ['default_visibility', 'inline_mode_enabled', 'allow_invitations', 'share_location', 'share_description'],
  voice: ['voice_response_enabled'],
};

const isSettingsCategory = (value: unknown): value is SettingsCategory =>
  SETTINGS_CATEGORIES.some((category) => category === value);

const hhmm = (value: SettingsValueType | undefined): string | null =>
  typeof value === 'string' && /^\d{2}:\d{2}/.test(value) ? value.slice(0, 5) : null;

function reminderList(value: SettingsValueType, words: AnswerWording): string | null {
  if (typeof value !== 'string') return null;
  const parsed = z.array(z.number()).safeParse(safeJson(value));
  if (!parsed.success) return null;
  return parsed.data.map((minutes) => words.settings.before(words.settings.durationShort(minutes))).join(', ');
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function settingText(key: string, values: { [key: string]: SettingsValueType }, words: AnswerWording): string | null {
  const labels = words.settings;
  const value = values[key];
  if (value === undefined) return null;
  const flag = (on: SettingsValueType): string => (on === 1 || on === true ? labels.yes : labels.no);
  switch (key) {
    case 'timezone':
      return typeof value === 'string' ? value : null;
    case 'country_code':
      return typeof value === 'string' && value !== 'not set' ? value : null;
    case 'language':
      return typeof value === 'string' ? (labels.language[value] ?? value) : null;
    case 'default_event_duration_minutes':
      return typeof value === 'number' ? labels.durationShort(value) : null;
    case 'morning_agenda_enabled':
    case 'evening_review_enabled': {
      const time = hhmm(values[key === 'morning_agenda_enabled' ? 'morning_agenda_time' : 'evening_review_time']);
      return (value === 1 || value === true) && time !== null ? labels.at(time) : flag(value);
    }
    case 'quiet_hours_enabled': {
      const from = hhmm(values.quiet_hours_start);
      const to = hhmm(values.quiet_hours_end);
      return (value === 1 || value === true) && from !== null && to !== null
        ? labels.quietRange(from, to)
        : flag(value);
    }
    case 'default_reminder_intervals':
      return reminderList(value, words);
    case 'max_daily_calls':
      return typeof value === 'number' ? String(value) : null;
    case 'default_visibility':
      return typeof value === 'string' ? (labels.visibility[value] ?? value) : null;
    case 'voice_response_enabled':
      return value === null ? labels.unset : flag(value);
    default:
      return flag(value);
  }
}

function settingsLines(category: SettingsCategory, raw: unknown, words: AnswerWording): string[] {
  const values = FlatSettings.safeParse(raw);
  if (!values.success) return [];
  const lines: string[] = [];
  for (const key of SETTINGS_KEYS[category]) {
    const text = settingText(key, values.data, words);
    const label = words.settings.labels[key];
    if (text !== null && label !== undefined) lines.push(`• ${label}: ${text}`);
  }
  return lines;
}

/** Short labelled list of the settings the tool returned; null when the JSON is not a settings shape. */
export function renderSettingsOutput(output: string, category: unknown, context: RenderContext): string | null {
  const parsed = SettingsRecordCodec.safeParse(output);
  if (!parsed.success) return null;
  const words = wordingFor(context.language);
  if (isSettingsCategory(category)) {
    const lines = settingsLines(category, parsed.data, words);
    return lines.length === 0
      ? null
      : [words.settings.headingFor(words.settings.categories[category].toLowerCase()), ...lines].join('\n');
  }
  const sections: string[] = [];
  for (const each of SETTINGS_CATEGORIES) {
    const lines = settingsLines(each, parsed.data[each], words);
    if (lines.length > 0) sections.push([`${words.settings.categories[each]}:`, ...lines].join('\n'));
  }
  return sections.length === 0 ? null : [words.settings.heading, ...sections].join('\n\n');
}

function renderSettings(answer: ToolAnswer, context: RenderContext): RenderedAnswer | null {
  if (answer.input.action !== 'get') return null;
  const text = renderSettingsOutput(answer.output, answer.input.category, context);
  return text === null ? null : rendered(text);
}

// ---- contacts, holidays, bot info, access ----

/** A contact line of get_contacts: "Анна — contact_id:2 — created_at_utc:… — @anna_smith — telegram_id:9876". */
function contactLine(line: string): string | null {
  const parts = line.split(' — ');
  if (!parts.some((part) => part.startsWith('contact_id:'))) return null;
  const name = parts[0]!;
  const display = parts.find((part) => part.startsWith('display:'))?.slice('display:'.length);
  const username = parts.find((part) => part.startsWith('@'));
  const label = display && display !== name ? `${name} (${display})` : name;
  return username ? `${label} — ${username}` : label;
}

function renderContactList(answer: ToolAnswer, context: RenderContext): RenderedAnswer | null {
  const lines = answer.output.split('\n').flatMap((line) => contactLine(line) ?? []);
  if (lines.length === 0) return null;
  return rendered([wordingFor(context.language).contactsHeading(lines.length), ...lines].join('\n'));
}

function matchLabel(match: ContactMatch): string {
  const name = match.preferred_name ?? match.name;
  const shown = match.preferred_name && match.preferred_name !== match.name ? `${name} (${match.name})` : name;
  return match.username ? `${shown} — @${match.username}` : shown;
}

function renderContactMatches(answer: ToolAnswer, context: RenderContext): RenderedAnswer | null {
  if (answer.data === undefined || Array.isArray(answer.data) || !('matches' in answer.data)) return null;
  const { matches } = answer.data;
  const words = wordingFor(context.language);
  const only = matches.length === 1 ? matches[0] : undefined;
  if (only) {
    const lead = only.confidence >= 1 ? words.contactFound : words.contactApproximate;
    return rendered(`${lead} ${matchLabel(only)}`);
  }
  return matches.length === 0 ? null : rendered([words.contactsFound, ...matches.map(matchLabel)].join('\n'));
}

/** A holiday line of get_holidays: "2026-11-04: День народного единства (Россия)". */
function renderHolidays(answer: ToolAnswer, context: RenderContext): RenderedAnswer | null {
  let converted = 0;
  const lines = answer.output.split('\n').map((line) => {
    const match = /^(\d{4}-\d{2}-\d{2}): (.+)$/.exec(line);
    if (!match) return line;
    converted++;
    return `${humanDay(match[1]!, context)} — ${match[2]}`;
  });
  return converted === 0 ? null : rendered(lines.join('\n'));
}

function renderBotInfo(answer: ToolAnswer, context: RenderContext): RenderedAnswer {
  const developer = /^\W*Developer:\s*(@\w+)/im.exec(answer.output)?.[1] ?? null;
  return rendered(wordingFor(context.language).botInfo(developer));
}

const AccessPerson = z.object({
  permission: z.enum(['read', 'write']),
  status: z.string(),
  username: z.string().nullish(),
  display_name: z.string(),
});
const AccessCodec = jsonCodec(
  z.object({ my_secretaries: z.array(AccessPerson), secretary_for: z.array(AccessPerson) }),
);
const SecretaryStatusCodec = jsonCodec(z.object({ status: z.string() }));
const OkCodec = jsonCodec(z.object({ ok: z.literal(true) }));

function renderAccessList(answer: ToolAnswer, context: RenderContext): RenderedAnswer | null {
  const parsed = AccessCodec.safeParse(answer.output);
  if (!parsed.success) return null;
  const { secretary } = wordingFor(context.language);
  const line = (person: z.infer<typeof AccessPerson>): string => {
    const name = person.username ? `${person.display_name} (@${person.username})` : person.display_name;
    const status = secretary.status[person.status];
    return `• ${name} — ${secretary.permission[person.permission]}${status ? `, ${status}` : ''}`;
  };
  const sections = [
    ...(parsed.data.my_secretaries.length > 0 ? [[secretary.mine, ...parsed.data.my_secretaries.map(line)]] : []),
    ...(parsed.data.secretary_for.length > 0 ? [[secretary.forOthers, ...parsed.data.secretary_for.map(line)]] : []),
  ];
  if (sections.length === 0) return rendered(secretary.none);
  return rendered(sections.map((section) => section.join('\n')).join('\n\n'));
}

function renderSecretaryAction(answer: ToolAnswer, context: RenderContext): RenderedAnswer | null {
  const { secretary } = wordingFor(context.language);
  const status = SecretaryStatusCodec.safeParse(answer.output);
  if (status.success) {
    if (status.data.status === 'awaiting_confirmation') return rendered(secretary.invited);
    if (status.data.status === 'delivery_failed') return rendered(secretary.deliveryFailed);
    return null;
  }
  return OkCodec.safeParse(answer.output).success ? rendered(secretary.done) : null;
}

// ---- generic text ----

const TextMapCodec = jsonCodec(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])));

/**
 * A tool's own text. Most tools write for the user directly; a JSON object carrying a text field gives that field,
 * and any other JSON is an unknown shape that is named as such instead of being dumped.
 */
export function plainAnswer(output: string, language: string): { text: string } {
  const trimmed = output.trim();
  if (!JSON_LIKE.test(trimmed) || trimmed.length < 3) return { text: output };
  const parsed = TextMapCodec.safeParse(trimmed);
  if (parsed.success) {
    for (const key of ['output', 'message', 'text', 'result']) {
      const value = parsed.data[key];
      if (typeof value === 'string') return { text: value };
    }
    if (parsed.data.ok === true && Object.keys(parsed.data).length === 1) return { text: wordingFor(language).done };
  }
  return { text: wordingFor(language).unknownShape };
}

function renderKnown(answer: ToolAnswer, context: RenderContext): RenderedAnswer | null {
  switch (answer.tool) {
    case 'get_events':
    case 'get_upcoming':
    case 'search_events':
    case 'get_event':
      return renderEvents(answer, context);
    case 'create_event':
    case 'update_event':
    case 'delete_event':
      return renderConfirmation(answer, context);
    case 'get_free_slots':
      return renderFreeSlots(answer, context);
    case 'get_timezone_info':
      return renderTimezoneInfo(answer, context);
    case 'convert_to_timezone':
      return renderConverted(answer, context);
    case 'manage_settings':
      return renderSettings(answer, context);
    case 'get_contacts':
      return renderContactList(answer, context);
    case 'find_contact':
      return renderContactMatches(answer, context);
    case 'get_holidays':
      return renderHolidays(answer, context);
    case 'get_bot_info':
      return renderBotInfo(answer, context);
    case 'list_calendar_access':
      return renderAccessList(answer, context);
    case 'manage_secretaries':
      return renderSecretaryAction(answer, context);
    default:
      return null;
  }
}

/**
 * The answer a rule gives when its last step was this tool. A tool without a renderer, or whose shape is not the one
 * the renderer knows, shows its own text; JSON that cannot be rendered is never shown.
 */
export function renderToolAnswer(answer: ToolAnswer, context: RenderContext): RenderedAnswer {
  const known = renderKnown(answer, context);
  if (known) return known;
  const plain = plainAnswer(answer.output, context.language);
  return { text: plain.text };
}

/**
 * The text a later step may quote from this tool (`{{tool_outputs.<as>_text}}`). Events come with their ids because
 * the person has to pick one ("повтори команду с номером #12"); free windows come as bare intervals the sentence
 * around them introduces.
 */
export function quotableText(answer: ToolAnswer, context: RenderContext): string {
  const events = EVENT_READS[answer.tool] === true ? extractEventSummaries(answer.data) : undefined;
  if (events !== undefined) return renderChoices(events, context);
  if (answer.tool === 'get_free_slots' && hasFreeSlots(answer.data))
    return freeWindowsText(answer.data.slots, context, wordingFor(context.language));
  return renderToolAnswer(answer, context).text;
}
