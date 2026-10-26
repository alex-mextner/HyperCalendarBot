import { normalize } from './normalizer.ts';
import type { Bindings } from './workflow-bindings.ts';
import type { WorkflowInputValue } from './workflow-input.ts';

/** Shared building blocks for the canonical seed: finite regex fragments, phrase tables and step builders. */

export type FamilyCategory =
  | 'calendar'
  | 'slots'
  | 'events'
  | 'reminders'
  | 'contacts'
  | 'invitations'
  | 'settings'
  | 'history'
  | 'memory'
  | 'utility'
  | 'google'
  | 'secretary'
  | 'bot';

/** read: reads the caller's own scope; private_read: reads personal data; write: changes data; sensitive_write: changes access or identity. */
export type FamilyRisk = 'read' | 'private_read' | 'write' | 'sensitive_write';

export interface SeedStep {
  call?: string;
  input?: { [key: string]: WorkflowInputValue };
  as?: string;
  when?: string;
  respond?: string;
  /** Hand the message to the AI agent: the rule recognised the command but cannot safely act on this wording. */
  abstain?: boolean;
}

export interface LanguageStrings {
  ru: { [key: string]: string };
  en: { [key: string]: string };
}

export interface FamilyDefinition {
  name: string;
  title: string;
  category: FamilyCategory;
  risk: FamilyRisk;
  pattern: string;
  triggers: string[];
  bindings?: Bindings;
  steps: SeedStep[];
  strings: LanguageStrings;
  /** Hand-written phrases; none of them come from the recorded user corpus. */
  examples: string[];
  /** Messages that must not reach this family's workflow (negated, malicious, ambiguous or near-miss phrasing). */
  negatives: string[];
  /** Messages the pattern accepts but a typed binding rejects, so the workflow fails before any tool runs. */
  invalidInputs?: string[];
  notes?: string;
}

const spaced = (phrase: string): string => phrase.trim().split(/\s+/).join(String.raw`\s+`);

/** A non-capturing alternation of literal phrases; spaces become flexible whitespace. */
export function alt(phrases: readonly string[]): string {
  return `(?:${[...phrases]
    .sort((a, b) => b.length - a.length)
    .map(spaced)
    .join('|')})`;
}

/** A table keyed by the normalized form of each phrase, as the binding parsers look it up. */
export function phraseTable<T>(entries: readonly (readonly [readonly string[], T])[]): { [key: string]: T } {
  const table: { [key: string]: T } = {};
  for (const [phrases, value] of entries) for (const phrase of phrases) table[normalize(phrase)] = value;
  return table;
}

export const SCOPE = '{{env.scope}}';

// ─── date, time and period vocabulary ───────────────────────────────────────

const DAY_PHRASES = [
  [['сегодня', 'today'], 'today'],
  [['завтра', 'tomorrow'], 'tomorrow'],
  [['послезавтра', 'day after tomorrow'], 'day_after_tomorrow'],
  [['вчера', 'yesterday'], 'yesterday'],
] as const;
export const DAY_WORDS = phraseTable(DAY_PHRASES);
export const DAY_WORD_RX = alt(DAY_PHRASES.flatMap(([phrases]) => phrases));

const MONTH_RX = '(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)';
const MONTH_EN_RX =
  '(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)';
const SEP = String.raw`[-./\s]`;
export const ABSOLUTE_DATE_RX = [
  String.raw`\d{4}${SEP}\d{1,2}${SEP}\d{1,2}`,
  String.raw`\d{1,2}${SEP}\d{1,2}(?:${SEP}\d{4})?`,
  String.raw`\d{1,2}\s+${MONTH_RX}(?:\s+\d{4})?`,
  String.raw`${MONTH_EN_RX}\s+\d{1,2}(?:st|nd|rd|th)?(?:\s+\d{4})?`,
].join('|');
/** Any day the date binding can parse: a relative word or an absolute date. */
export const ANY_DAY_RX = `(?:${DAY_WORD_RX}|${ABSOLUTE_DATE_RX})`;

const CLOCK_SUFFIX = 'am|pm|a\\s?m|p\\s?m|утра|дня|вечера|ночи';
export const TIME_RX = String.raw`(?:\d{1,2}(?:[:.\s]\d{2})?(?:\s?(?:${CLOCK_SUFFIX}))?|полдень|полночь|noon|midnight)`;

/** Word edges that also work next to Cyrillic, where `\\b` never matches (the rule patterns carry no `u` flag). */
export const WB = '(?<![A-Za-zА-Яа-яЁё0-9_])';
export const WE = '(?![A-Za-zА-Яа-яЁё0-9_])';

/** Lookahead fragments: the message names a clock time / a day somewhere. They gate free-form rules; the binding does the reading. */
// "05.10.2026" is a date, not the clock time "05.10": a dot or slash and a digit after it rule the clock reading out.
const WEEKDAY_WORDS =
  'понедельник|вторник|среду|среда|четверг|пятницу|пятница|субботу|суббота|воскресенье|пн|вт|ср|чт|пт|сб|вс|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tues|thurs|thur';
export const TIME_SIGNAL = String.raw`(?=.*(?:${WB}\d{1,2}:\d{2}|${WB}(?:в|к|at)\s+\d{1,2}(?:[.:]\d{2})?(?:\s?(?:am|pm|утра|дня|вечера|ночи))?${WE}|${WB}(?:полдень|полночь|noon|midnight)${WE}|${WB}\d{1,2}\.\d{2}(?![./]\d)${WE}|${WB}(?:с|from)\s+\d{1,2}\s+(?:до|to|until)\s+\d{1,2}${WE}|${WB}(?:сегодня|завтра|послезавтра|today|tomorrow|${WEEKDAY_WORDS}|\d{1,2}\s+${MONTH_RX}|\d{1,2}[./]\d{1,2})[,.]?\s+(?:1[3-9]|2[0-3])${WE}))`;
export const DATE_SIGNAL = String.raw`(?=.*(?:${WB}(?:сегодня|завтра|послезавтра|вчера|today|tomorrow|yesterday|${WEEKDAY_WORDS})${WE}|${WB}\d{1,2}(?:-?го)?\s+${MONTH_RX}|${WB}${MONTH_EN_RX}\.?\s+\d{1,2}|${WB}\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH_EN_RX}|${WB}\d{1,2}[./]\d{1,2}(?:[./]\d{4})?${WE}|${WB}\d{4}[-./]\d{1,2}[-./]\d{1,2}${WE}|${WB}(?:через|in)\s+(?:\d{1,3}|одну)\s+(?:дн|день|недел|day|week)))`;

type PeriodKey =
  | 'today'
  | 'tomorrow'
  | 'day_after_tomorrow'
  | 'yesterday'
  | 'week'
  | 'next_week'
  | 'month'
  | 'next_month'
  | 'weekend';

const PERIOD_PHRASES: { [key in PeriodKey]: string[] } = {
  today: ['сегодня', 'на сегодня', 'today', 'for today'],
  tomorrow: ['завтра', 'на завтра', 'tomorrow', 'for tomorrow'],
  day_after_tomorrow: ['послезавтра', 'на послезавтра', 'day after tomorrow'],
  yesterday: ['вчера', 'yesterday'],
  week: ['на этой неделе', 'на неделе', 'на эту неделю', 'на неделю', 'this week', 'for this week'],
  next_week: ['на следующей неделе', 'на следующую неделю', 'next week', 'for next week'],
  month: ['в этом месяце', 'на этот месяц', 'на месяц', 'this month', 'for this month'],
  next_month: ['в следующем месяце', 'на следующий месяц', 'next month', 'for next month'],
  weekend: ['на выходных', 'на выходные', 'на эти выходные', 'this weekend', 'for the weekend'],
};

/** Regex alternation and the matching period-binding table for a chosen set of periods. */
export function periodVocabulary(keys: readonly PeriodKey[]): { rx: string; values: { [key: string]: PeriodKey } } {
  return {
    rx: alt(keys.flatMap((key) => PERIOD_PHRASES[key])),
    values: phraseTable(keys.map((key) => [PERIOD_PHRASES[key], key] as const)),
  };
}

const MINUTE_WORDS = ['минуту', 'минуты', 'минут', 'мин', 'minute', 'minutes', 'min', 'mins'];
const HOUR_WORDS = ['час', 'часа', 'часов', 'ч', 'hour', 'hours', 'hr', 'hrs', 'h'];
export const DURATION_UNIT_RX = alt([...MINUTE_WORDS, ...HOUR_WORDS]);
export const DURATION_UNITS = phraseTable([
  [MINUTE_WORDS, 1],
  [HOUR_WORDS, 60],
]);

/**
 * A span of time as people say it, for "на 30 минут", "за час до", "через полчаса": an amount with a unit, or a unit that
 * stands for one by itself. `table` maps either to minutes; days are left out where a span that long makes no sense.
 */
export function spanVocabulary(withDays: boolean): { unit: string; bare: string; table: { [key: string]: number } } {
  const units: (readonly [readonly string[], number])[] = [
    [MINUTE_WORDS, 1],
    [HOUR_WORDS, 60],
  ];
  const bare: (readonly [readonly string[], number])[] = [
    [['минуту', 'a minute', 'one minute'], 1],
    [['час', 'an hour', 'one hour'], 60],
    [['полчаса', 'half an hour', 'half hour'], 30],
  ];
  if (withDays) {
    units.push([['день', 'дня', 'дней', 'day', 'days'], 1440]);
    bare.push([['день', 'a day', 'one day'], 1440]);
  }
  return {
    unit: alt(units.flatMap(([words]) => words)),
    bare: alt(bare.flatMap(([words]) => words)),
    table: phraseTable([...units, ...bare]),
  };
}

// ─── references ─────────────────────────────────────────────────────────────

/** An event named by number, or by exact title in quotes; safe next to other free text. */
export const QUOTED_OR_ID_RX = String.raw`((?:#|№)\d{1,9}|«[^»\n]{1,120}»|"[^"\n]{1,120}"|“[^”\n]{1,120}”)`;
export const EVENT_NOUN_RX = alt(['событие', 'встречу', 'event', 'meeting']);
export const BULK_WORDS = [
  'все',
  'всё',
  'всех',
  'all',
  'every',
  'everything',
  'любое',
  'любую',
  'любой',
  'каждое',
  'каждую',
  'каждый',
  'each',
  'both',
  'оба',
  'обе',
];
export const USERNAME_RX = '[A-Za-z][A-Za-z0-9_]{4,31}';
/** "удали, пожалуйста, обед": courtesy between a command verb and its object. */
export const COURTESY = String.raw`(?:\s*,)?(?:\s+(?:пожалуйста|плиз|плз|please|pls))?(?:\s*,)?`;

// ─── shared strings and steps ───────────────────────────────────────────────

export const COMMON_STRINGS: LanguageStrings = {
  ru: {
    private_only: 'Это личные данные — работаю с ними только в личке с ботом.',
    ambiguous: 'Нашёл несколько подходящих событий. Повтори команду с номером (#id):\n{{tool_outputs.found_text}}',
    cancelled: 'Отменено, ничего не изменилось.',
    ok: 'Да',
    cancel: 'Отмена',
    // The event as the user knows it: title, day in words, clock time. Never an id or a raw date.
    target:
      '«{{tool_outputs.target.title}}» ({{tool_outputs.target.date|human_day}}{{tool_outputs.target.time|default("")|ternary(" в ", "")}}{{tool_outputs.target.time|default("")}})',
  },
  en: {
    private_only: 'This is private data — I only handle it in a private chat with the bot.',
    ambiguous: 'Several events match. Repeat the command with the number (#id):\n{{tool_outputs.found_text}}',
    cancelled: 'Cancelled, nothing was changed.',
    ok: 'Yes',
    cancel: 'Cancel',
    target:
      '“{{tool_outputs.target.title}}” ({{tool_outputs.target.date|human_day}}{{tool_outputs.target.time|default("")|ternary(" at ", "")}}{{tool_outputs.target.time|default("")}})',
  },
};

/** Refuse before any read: private tools never run in a group, whatever the phrasing. */
export const guardPrivate = (): SeedStep => ({ when: 'group.is_group == true', respond: '{{t.private_only}}' });

/**
 * Private tools never run in a group, but a refusal sentence there answers a request the AI may be able to serve: the
 * rule steps aside and the AI agent decides what a group chat may do.
 */
export const abstainInGroup = (): SeedStep => ({ when: 'group.is_group == true', abstain: true });

/**
 * Resolve the event reference binding at `ref` (`bind.ref`, or `bind.ev.ref` for a reference read out of a phrase)
 * to exactly one event in `tool_outputs.target`. A number is looked up directly; a title must match exactly one event
 * or the workflow stops: several matches are listed by number, none hands the message to the AI, which knows more.
 */
export function resolveEvent(ref = 'bind.ref'): SeedStep[] {
  return [
    {
      when: `${ref}.kind == 'id'`,
      call: 'get_event',
      input: { event_id: `{{${ref}.id}}`, scope: SCOPE },
      as: 'target',
    },
    ...resolveEventByName(ref),
  ];
}

/**
 * The title half of resolveEvent: search the actor's own calendar and stop unless exactly one
 * event matches, leaving it in `tool_outputs.target`. Does nothing for an id reference.
 */
export function resolveEventByName(ref = 'bind.ref'): SeedStep[] {
  return [
    {
      when: `${ref}.kind == 'name'`,
      call: 'search_events',
      input: { query: `{{${ref}.query}}`, scope: SCOPE, event_type: 'regular' },
      as: 'found',
    },
    { when: `count(found) == 0 && ${ref}.kind == 'name'`, abstain: true },
    { when: 'count(found) > 1', respond: '{{t.ambiguous}}' },
    {
      when: 'count(found) == 1',
      call: 'get_event',
      input: { event_id: '{{tool_outputs.found[0].id}}', scope: SCOPE },
      as: 'target',
    },
  ];
}

/** A yes/cancel question, then an early exit unless the user chose yes. Nothing writes before this. */
export function confirmStep(questionKey: string): SeedStep[] {
  return [
    {
      call: 'ask_user',
      input: { question: `{{t.${questionKey}}}`, options: ['{{t.ok}}', '{{t.cancel}}'] },
      as: 'confirm|lower',
    },
    { when: "ask.confirm != 'да' && ask.confirm != 'yes'", respond: '{{t.cancelled}}' },
  ];
}

/** A phrasing of a request: `slot('ref')` writes the place of the slot's capture group among the words. */
export type SlotForm = (slot: (name: string) => string) => string;

/**
 * One whole-message pattern for several phrasings of the same request ("напомни за 15 минут до стендапа" and "за 15
 * минут до стендапа напомни"). Each phrasing places its slots; every placement becomes a capture group and `read(name)`
 * is the template that yields whichever placement matched, so a binding reads a slot however the words were ordered.
 * Slot patterns must not capture themselves. `prefix` is lookahead text about the whole message that comes first,
 * once, so it is not repeated in every phrasing.
 */
export function slotForms(
  forms: readonly SlotForm[],
  slots: { [name: string]: string },
  prefix = '',
): { pattern: string; read: (name: string) => string } {
  const groups: { [name: string]: number[] } = {};
  let count = 0;
  const slot = (name: string): string => {
    const rx = slots[name];
    if (rx === undefined) throw new Error(`Unknown pattern slot: ${name}`);
    count++;
    groups[name] = [...(groups[name] ?? []), count];
    return `(${rx})`;
  };
  const alternatives = forms.map((form) => form(slot)).join('|');
  return {
    pattern: `^${prefix}(?:${alternatives})$`,
    read: (name) => {
      const indices = groups[name];
      if (!indices) throw new Error(`Pattern slot never placed: ${name}`);
      return indices.map((index) => `{{$${index}|default("")}}`).join('');
    },
  };
}
