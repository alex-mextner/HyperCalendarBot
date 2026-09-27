import { TZDate } from '@date-fns/tz';

/**
 * Deterministic reading of the day words in a user's message: weekday names and
 * relative days ("во вторник", "в среду", "завтра", "next Friday") resolved to local
 * calendar dates. The agent's models do this arithmetic badly — on 2026-09-25 (a
 * Friday) "понедельник" became the 27th (a Sunday) and "среда" the 29th (a Tuesday),
 * and on 2026-09-27 "среда" became the 28th (a Monday) — so tool calls are checked
 * against this reading instead of being trusted.
 *
 * The reading fails open: a message whose day words cannot be pinned to specific dates
 * (a recurrence, "через две недели", "после среды", a month without a day, an ordinal
 * weekday, a weekend) imposes no constraint at all. Only a clear weekday or relative
 * day constrains, and every alternative reading it could have (today or in a week when
 * the day is today, the week after with "следующий", the one before with "прошлый",
 * both calendar days just after midnight) is allowed.
 */

export interface DayReference {
  /** The word as the user wrote it, lower-cased: 'среду', 'завтра'. */
  phrase: string;
  /** English name of what it means: 'Wednesday', 'tomorrow'. */
  label: string;
  /** Local calendar dates (YYYY-MM-DD) the word can mean, nearest first. */
  dates: string[];
}

export interface DayReferenceSet {
  references: DayReference[];
  /** Every reference's dates plus explicit dates written in the same message. */
  allowedDates: ReadonlySet<string>;
}

/**
 * What a message says about days: nothing at all, something this module does not pin
 * down (no constraint), or named days.
 */
export type DayContent = { kind: 'none' } | { kind: 'open' } | { kind: 'named'; set: DayReferenceSet };

export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

interface WeekdayForm {
  weekday: number;
  plural: boolean;
}

const RU_WEEKDAY_FORMS: [singular: string[], plural: string[]][] = [
  [
    ['понедельник', 'понедельника', 'понедельнику', 'понедельником', 'понедельнике', 'пн'],
    ['понедельники', 'понедельникам', 'понедельниками', 'понедельниках', 'понедельников'],
  ],
  [
    ['вторник', 'вторника', 'вторнику', 'вторником', 'вторнике', 'вт'],
    ['вторники', 'вторникам', 'вторниками', 'вторниках', 'вторников'],
  ],
  [
    ['среда', 'среду', 'среды', 'среде', 'средой', 'средою', 'ср'],
    ['средам', 'средами', 'средах', 'сред'],
  ],
  [
    ['четверг', 'четверга', 'четвергу', 'четвергом', 'четверге', 'чт'],
    ['четверги', 'четвергам', 'четвергами', 'четвергах', 'четвергов'],
  ],
  [
    ['пятница', 'пятницу', 'пятницы', 'пятнице', 'пятницей', 'пятницею', 'пт'],
    ['пятницам', 'пятницами', 'пятницах', 'пятниц'],
  ],
  [
    ['суббота', 'субботу', 'субботы', 'субботе', 'субботой', 'сб'],
    ['субботам', 'субботами', 'субботах', 'суббот'],
  ],
  [
    ['воскресенье', 'воскресенья', 'воскресенью', 'воскресеньем', 'воскресение', 'воскресения', 'вс'],
    ['воскресеньям', 'воскресеньями', 'воскресеньях', 'воскресений'],
  ],
];

const WEEKDAY_FORMS: ReadonlyMap<string, WeekdayForm> = new Map([
  ...RU_WEEKDAY_FORMS.flatMap(([singular, plural], weekday) => [
    ...singular.map((word): [string, WeekdayForm] => [word, { weekday, plural: false }]),
    ...plural.map((word): [string, WeekdayForm] => [word, { weekday, plural: true }]),
  ]),
  ...WEEKDAY_NAMES.flatMap((name, weekday): [string, WeekdayForm][] => [
    [name.toLowerCase(), { weekday, plural: false }],
    [`${name.toLowerCase()}s`, { weekday, plural: true }],
  ]),
]);

/** Relative day words and their offset from today. */
const RELATIVE_WORDS: ReadonlyMap<string, { offset: number; label: string }> = new Map([
  ['сегодня', { offset: 0, label: 'today' }],
  ['today', { offset: 0, label: 'today' }],
  ['tonight', { offset: 0, label: 'today' }],
  ['завтра', { offset: 1, label: 'tomorrow' }],
  ['tomorrow', { offset: 1, label: 'tomorrow' }],
  ['послезавтра', { offset: 2, label: 'the day after tomorrow' }],
  ['вчера', { offset: -1, label: 'yesterday' }],
  ['yesterday', { offset: -1, label: 'yesterday' }],
  ['позавчера', { offset: -2, label: 'the day before yesterday' }],
]);
const RELATIVE_STEMS: [prefix: string, word: string][] = [
  ['сегодняшн', 'сегодня'],
  ['завтрашн', 'завтра'],
  ['послезавтрашн', 'послезавтра'],
  ['вчерашн', 'вчера'],
];

const NEXT_MARKER = /^(?:следующ|будущ)|^next$/;
const PAST_MARKER = /^(?:прошл|прошедш)|^(?:был|была|было|были|last|past|previous|was|were)$/;
const THIS_MARKER = /^(?:этот|эту|этой|this)$/;
/** Words that make the day unpinnable: recurrence, offsets, "after", ordinals handled separately. */
const OPEN_WORD = /^(?:кажд|ежедневн|еженедел|позапрошл)|^(?:через|после|every|each|daily|weekly|after)$/;
const ORDINAL_WORD =
  /^(?:перв|втор(?:ой|ую|ое)$|трет|четв[её]рт|пят(?:ый|ую|ое)$|последн)|^(?:first|second|third|fourth|fifth)$/;
/** Words that talk about days without naming one; they open the message only when nothing is named. */
const PERIOD_WORD = /^(?:недел|выходн|будн|месяц|week|weekend|weekday|month|year)/;
const UNTIL_WORDS = new Set(['до', 'к', 'ко', 'by', 'until', 'till', 'before']);
const FROM_WORDS = new Set(['с', 'со', 'from']);
const TO_WORDS = new Set(['по', 'to', 'through']);
/** "по Москве", "по Токио": a place-named time, written with a capital as city names are. */
const FOREIGN_ZONE = /(?:^|[^\p{L}])[Пп]о\s+[А-ЯЁA-Z]/u;
const ZONE_ABBREVIATION = /^(?:мск|msk|utc|gmt)$/;

/** Month words as whole lower-case tokens, January first. */
const MONTH_TOKENS: readonly RegExp[] = [
  /^(?:январ(?:ь|я|е|ю|ем)|янв|january|jan)$/,
  /^(?:феврал(?:ь|я|е|ю|ем)|фев|february|feb)$/,
  /^(?:март(?:а|е|у|ом)?|мар|march|mar)$/,
  /^(?:апрел(?:ь|я|е|ю|ем)|апр|april|apr)$/,
  /^(?:ма(?:й|я|е|ю|ем)|may)$/,
  /^(?:июн(?:ь|я|е|ю|ем)|june|jun)$/,
  /^(?:июл(?:ь|я|е|ю|ем)|july|jul)$/,
  /^(?:август(?:а|е|у|ом)?|авг|august|aug)$/,
  /^(?:сентябр(?:ь|я|е|ю|ем)|сен|сент|september|sep|sept)$/,
  /^(?:октябр(?:ь|я|е|ю|ем)|окт|october|oct)$/,
  /^(?:ноябр(?:ь|я|е|ю|ем)|ноя|нояб|november|nov)$/,
  /^(?:декабр(?:ь|я|е|ю|ем)|дек|december|dec)$/,
];

function monthIndex(word: string): number {
  return MONTH_TOKENS.findIndex((pattern) => pattern.test(word));
}

// ─── calendar arithmetic on YYYY-MM-DD keys (timezone-free) ─────────────────────────────

function dayKey(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function shiftDay(key: string, delta: number): string {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d! + delta));
  return dayKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayOf(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return (new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay() + 6) % 7;
}

function validDayKey(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? dayKey(y, m, d) : null;
}

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let key = from; key <= to && out.length < 400; key = shiftDay(key, 1)) out.push(key);
  return out;
}

/** The user's local calendar day and hour at `now`. */
export function localToday(now: Date, timezone: string): { today: string; hour: number } {
  const local = new TZDate(now.getTime(), timezone);
  return { today: dayKey(local.getFullYear(), local.getMonth() + 1, local.getDate()), hour: local.getHours() };
}

/** Local calendar date (YYYY-MM-DD) of an instant in a zone. */
export function localDayOf(instant: string | number, timezone: string): string | null {
  const ms = typeof instant === 'number' ? instant : Date.parse(instant);
  if (!Number.isFinite(ms)) return null;
  const local = new TZDate(ms, timezone);
  return dayKey(local.getFullYear(), local.getMonth() + 1, local.getDate());
}

// ─── explicit dates ──────────────────────────────────────────────────────────────────────

interface ExplicitDates {
  dates: string[];
  /** Text with the matched dates blanked so their month words are not read again. */
  rest: string;
}

/** A day number next to a month word, in either order, with an optional year. */
const DAY_MONTH = /(?<![\p{L}\d])(\d{1,2})(?:-?го|-?е|st|nd|rd|th)?\s+(?:of\s+)?(\p{L}+)\.?(?:,?\s+(\d{4}))?/gu;
const MONTH_DAY = /(?<![\p{L}\d])(\p{L}+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?(?![\p{L}\d])/gu;

function explicitDates(text: string, today: string): ExplicitDates {
  const year = Number(today.slice(0, 4));
  const dates: string[] = [];
  /** Adds the date(s); false when the parts are no calendar date, so the text stays unread. */
  const addDay = (y: number | null, m: number, d: number): boolean => {
    const keys = (y === null ? [year, year + 1] : [y]).map((candidate) => validDayKey(candidate, m, d));
    for (const key of keys) if (key) dates.push(key);
    return keys.some(Boolean);
  };
  const patterns: [RegExp, (match: RegExpMatchArray) => boolean][] = [
    [/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => addDay(Number(m[1]), Number(m[2]), Number(m[3]))],
    [DAY_MONTH, (m) => addDay(m[3] ? Number(m[3]) : null, monthIndex(m[2]!) + 1, Number(m[1]))],
    [MONTH_DAY, (m) => addDay(m[3] ? Number(m[3]) : null, monthIndex(m[1]!) + 1, Number(m[2]))],
    [
      /(?<![\d.:])(\d{1,2})\.(\d{1,2})(?:\.(\d{4}|\d{2}))?(?![\d:])/g,
      (m) => addDay(m[3] === undefined ? null : Number(m[3].padStart(4, '20')), Number(m[2]), Number(m[1])),
    ],
    [
      /(?<![\p{L}\d])(\d{1,2})(?:-?го|\s+числа)(?![\p{L}])/gu,
      (m) => {
        const [y, mo] = today.split('-').map(Number);
        const next = new Date(Date.UTC(y!, mo!, 1));
        const thisMonth = addDay(y!, mo!, Number(m[1]));
        return addDay(next.getUTCFullYear(), next.getUTCMonth() + 1, Number(m[1])) || thisMonth;
      },
    ],
  ];
  let rest = text;
  for (const [pattern, add] of patterns) {
    for (const match of rest.matchAll(pattern)) {
      if (!add(match)) continue;
      const start = match.index ?? 0;
      rest = rest.slice(0, start) + ' '.repeat(match[0].length) + rest.slice(start + match[0].length);
    }
  }
  return { dates, rest };
}

// ─── the reading ─────────────────────────────────────────────────────────────────────────

interface Token {
  word: string;
  index: number;
}

function tokens(text: string): Token[] {
  return [...text.matchAll(/[\p{L}]+/gu)].map((match, index) => ({ word: match[0], index }));
}

/** Read the day words of one message relative to `now` in `timezone`. */
export function readDayContent(text: string, now: Date, timezone: string): DayContent {
  // "the day after tomorrow" names one day; read as a whole so "after" does not open it.
  const normalized = text
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/\b(?:the\s+)?day\s+after\s+tomorrow\b/g, 'послезавтра');
  const { today, hour } = localToday(now, timezone);
  const explicit = explicitDates(normalized, today);
  const words = tokens(explicit.rest);
  const has = (pattern: RegExp) => words.some((token) => pattern.test(token.word));

  const nextMarked = has(NEXT_MARKER);
  const pastMarked = has(PAST_MARKER) || has(THIS_MARKER);
  // Just after midnight "завтра" often still means the day that has just begun.
  const night = hour < 5;

  // A month without a day ("в октябре") cannot be pinned; "may" is left out as the English verb.
  let open = has(OPEN_WORD) || words.some((token) => token.word !== 'may' && monthIndex(token.word) >= 0);
  const references: (DayReference & { base: string; before: string | undefined })[] = [];
  for (const token of words) {
    const before = words[token.index - 1]?.word;
    const relative =
      RELATIVE_WORDS.get(token.word) ??
      RELATIVE_WORDS.get(RELATIVE_STEMS.find(([prefix]) => token.word.startsWith(prefix))?.[1] ?? '');
    if (relative) {
      const base = shiftDay(today, relative.offset);
      references.push({
        phrase: token.word,
        label: relative.label,
        dates: night ? [base, shiftDay(base, -1)] : [base],
        base,
        before,
      });
      continue;
    }
    const form = WEEKDAY_FORMS.get(token.word);
    if (!form) continue;
    if (form.plural || (before !== undefined && ORDINAL_WORD.test(before))) {
      open = true;
      continue;
    }
    const base = shiftDay(today, (form.weekday - weekdayOf(today) + 7) % 7);
    const dates = [base];
    if (base === today || nextMarked) dates.push(shiftDay(base, 7));
    if (pastMarked) dates.push(shiftDay(base, -7));
    references.push({ phrase: token.word, label: WEEKDAY_NAMES[form.weekday]!, dates, base, before });
  }

  if (open) return { kind: 'open' };
  if (references.length === 0) {
    return explicit.dates.length > 0 || has(PERIOD_WORD) ? { kind: 'open' } : { kind: 'none' };
  }
  // "сегодня отмени, перенеси на следующую неделю": the period names a day of its own. With a
  // weekday ("в среду на следующей неделе") the period only qualifies that weekday.
  const weekdayNamed = references.some((reference) => WEEKDAY_NAMES.some((name) => name === reference.label));
  if (!weekdayNamed && has(PERIOD_WORD)) return { kind: 'open' };

  const allowed = new Set<string>(explicit.dates);
  // "завтра в 3 по Токио" is a day earlier in Belgrade: a day named in another zone may
  // land on the neighbouring day of the user's own calendar.
  const otherZone = FOREIGN_ZONE.test(text) || has(ZONE_ABBREVIATION);
  let rangeStart: string | undefined;
  for (const reference of references) {
    for (const date of reference.dates) {
      allowed.add(date);
      if (otherZone) for (const neighbour of [shiftDay(date, -1), shiftDay(date, 1)]) allowed.add(neighbour);
    }
    if (reference.before !== undefined && UNTIL_WORDS.has(reference.before)) {
      for (const date of daysBetween(today, reference.base)) allowed.add(date);
    }
    if (reference.before !== undefined && FROM_WORDS.has(reference.before)) rangeStart = reference.base;
    if (reference.before !== undefined && TO_WORDS.has(reference.before) && rangeStart !== undefined) {
      const end = reference.base >= rangeStart ? reference.base : shiftDay(reference.base, 7);
      for (const date of daysBetween(rangeStart, end)) allowed.add(date);
    }
  }
  return {
    kind: 'named',
    set: {
      references: references.map(({ phrase, label, dates }) => ({ phrase, label, dates })),
      allowedDates: allowed,
    },
  };
}

/** The named days of a message, or null when it names none or names them too loosely to check. */
export function resolveDayReferences(text: string, now: Date, timezone: string): DayReferenceSet | null {
  const content = readDayContent(text, now, timezone);
  return content.kind === 'named' ? content.set : null;
}

/** 'Wednesday 2026-09-30' — how a date is named in corrective errors. */
export function describeDay(key: string): string {
  return `${WEEKDAY_NAMES[weekdayOf(key)]} ${key}`;
}

/** '«среду» = Wednesday 2026-09-30' lines for every reference, in the order written. */
export function describeReferences(set: DayReferenceSet): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const reference of set.references) {
    const line = `«${reference.phrase}» = ${reference.dates.map(describeDay).join(' or ')}`;
    if (seen.has(line)) continue;
    seen.add(line);
    parts.push(line);
  }
  return parts.join('; ');
}
