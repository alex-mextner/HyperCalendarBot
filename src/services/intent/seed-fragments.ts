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

// ─── references ─────────────────────────────────────────────────────────────

/** An event named by number, or by exact title in quotes; safe next to other free text. */
export const QUOTED_OR_ID_RX = String.raw`((?:#|№)\d{1,9}|«[^»\n]{1,120}»|"[^"\n]{1,120}"|“[^”\n]{1,120}”)`;
export const EVENT_NOUN_RX = alt(['событие', 'встречу', 'event', 'meeting']);
export const BULK_WORDS = ['все', 'всё', 'всех', 'all', 'every', 'everything', 'любое', 'любую'];
export const USERNAME_RX = '[A-Za-z][A-Za-z0-9_]{4,31}';

// ─── shared strings and steps ───────────────────────────────────────────────

export const COMMON_STRINGS: LanguageStrings = {
  ru: {
    private_only: 'Это личные данные — работаю с ними только в личке с ботом.',
    not_found: 'Не нашёл такое событие. Назови точное название или номер, например #12.',
    ambiguous: 'Нашёл несколько событий. Повтори команду с номером (#id):\n{{tool_outputs.found_text}}',
    cancelled: 'Отменено, ничего не изменилось.',
    ok: 'Да',
    cancel: 'Отмена',
    target:
      '«{{tool_outputs.target.title}}» (#{{tool_outputs.target.id}}, {{tool_outputs.target.date}} {{tool_outputs.target.time|default("")}})',
  },
  en: {
    private_only: 'This is private data — I only handle it in a private chat with the bot.',
    not_found: "I couldn't find that event. Give the exact title or its number, like #12.",
    ambiguous: 'Several events match. Repeat the command with the number (#id):\n{{tool_outputs.found_text}}',
    cancelled: 'Cancelled, nothing was changed.',
    ok: 'Yes',
    cancel: 'Cancel',
    target:
      '“{{tool_outputs.target.title}}” (#{{tool_outputs.target.id}}, {{tool_outputs.target.date}} {{tool_outputs.target.time|default("")}})',
  },
};

/** Refuse before any read: private tools never run in a group, whatever the phrasing. */
export const guardPrivate = (): SeedStep => ({ when: 'group.is_group == true', respond: '{{t.private_only}}' });

/**
 * Resolve `bind.ref` to exactly one event in `tool_outputs.target`. A number is looked up
 * directly; a title must match exactly one event or the workflow stops and asks for the number.
 */
export function resolveEvent(): SeedStep[] {
  return [
    {
      when: "bind.ref.kind == 'id'",
      call: 'get_event',
      input: { event_id: '{{bind.ref.id}}', scope: SCOPE },
      as: 'target',
    },
    {
      when: "bind.ref.kind == 'name'",
      call: 'search_events',
      input: { query: '{{bind.ref.query}}', scope: SCOPE, event_type: 'regular' },
      as: 'found',
    },
    { when: 'count(found) == 0 && bind.ref.kind == "name"', respond: '{{t.not_found}}' },
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
