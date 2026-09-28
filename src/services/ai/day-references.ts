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
// "втор…" and "пят…" need their ordinal endings: the bare stems also start "вторник" and "пятница".
const ORDINAL_WORD =
  /^(?:перв|втор(?:ой|ая|ую|ое|ого|ому|ым|ом|ые|ых)$|трет|четв[её]рт|пят(?:ый|ая|ую|ое|ого|ому|ым|ом|ые|ых)$|последн)|^(?:first|second|third|fourth|fifth)$/;
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

export function shiftDay(key: string, delta: number): string {
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
  const pastMarked = has(PAST_MARKER);
  const thisMarked = has(THIS_MARKER);
  const thisMonday = shiftDay(today, -weekdayOf(today));
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
    // "эту среду" is this calendar week's Wednesday or the coming one — never last week's.
    const previous = shiftDay(base, -7);
    if (pastMarked || (thisMarked && previous >= thisMonday)) dates.push(previous);
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

// ─── weekday names paired with dates in the bot's own text ──────────────────────────────

/**
 * A weekday written right next to a date that falls on another weekday. Users check the
 * weekday name: on 2026-09-25 the bot confirmed "Понедельник 27 сентября" (a Sunday) and
 * the user approved; on 2026-09-27 it answered "в среду, 28 сентября" (a Monday).
 */
export interface WeekdayDateMismatch {
  /** The pair as written, on one line. */
  phrase: string;
  date: string;
  said: string;
  actual: string;
  /** The named weekday closest to `date`, at most three days away. */
  nearest: string;
}

const PAIR_WEEKDAYS: ReadonlyMap<string, number> = new Map([
  ...[...WEEKDAY_FORMS]
    .filter(([, form]) => !form.plural)
    .map(([word, form]): [string, number] => [word, form.weekday]),
  ...(['mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun'] as const).map(
    (abbreviation): [string, number] => [
      abbreviation,
      WEEKDAY_NAMES.findIndex((name) => name.toLowerCase().startsWith(abbreviation.slice(0, 3))),
    ],
  ),
]);
const WD = `(${[...PAIR_WEEKDAYS.keys()].sort((a, b) => b.length - a.length).join('|')})`;
/** What may stand between a weekday and its date on one line: spaces, commas, colons, dashes, markdown. */
const GAP = '[ \\t,:*_()\\-–—.]{1,8}';
const WEEKDAY_WORD = new RegExp(`(?<![\\p{L}])${WD}(?![\\p{L}])`, 'u');
/**
 * A weekday alone on its line ("**Среда**", "### Понедельник:") and the line break (plus
 * one blank line) that follows it: such a heading names the day of the date under it.
 */
const WEEKDAY_HEADING = new RegExp(`(?<=^|\\n)[^\\p{L}\\d\\n]*${WD}[^\\p{L}\\d\\n]*\\n(?:[ \\t]*\\n)?`, 'gu');
/** Clock times written with a colon: the author's dotted numbers are then dates. */
const COLON_CLOCK = /(?<!\d)\d{1,2}:\d{2}(?!\d)/;
/** A dotted day and month that cannot be a clock time: a day past 23, or a year. */
const DOTTED_DATE = /(?<![\d.])(?:(?:2[4-9]|3[01])\.(?:0?[1-9]|1[0-2])|\d{1,2}\.\d{1,2}\.\d{2,4})(?![\d:])/;
/** "9.10-10.00": a dotted number that opens a range is a clock time. */
const RANGE_AFTER = /^[ \t]*[-–—][ \t]*\d{1,2}[.:]\d{2}/;

interface PairParts {
  weekday: string;
  y: string | undefined;
  month: number;
  d: string;
  /** "10.09" without a year could also be 10:09. */
  dotted?: boolean;
}

const PAIR_PATTERNS: [RegExp, (m: RegExpMatchArray) => PairParts][] = [
  // "Понедельник 27 сентября", "в среду, 28 сентября 2026", "Wed 30 Sep"
  [
    new RegExp(
      `(?<![\\p{L}])${WD}${GAP}(\\d{1,2})(?:-?го|-?е|st|nd|rd|th)?[ \\t]+(?:of[ \\t]+)?(\\p{L}+)\\.?(?:,?[ \\t]+(\\d{4}))?`,
      'gu',
    ),
    (m) => ({ weekday: m[1]!, d: m[2]!, month: monthIndex(m[3]!) + 1, y: m[4] }),
  ],
  // "Wednesday, September 28"
  [
    new RegExp(
      `(?<![\\p{L}])${WD}${GAP}(\\p{L}+)\\.?[ \\t]+(\\d{1,2})(?:st|nd|rd|th)?(?:,?[ \\t]+(\\d{4}))?(?![\\p{L}\\d])`,
      'gu',
    ),
    (m) => ({ weekday: m[1]!, month: monthIndex(m[2]!) + 1, d: m[3]!, y: m[4] }),
  ],
  // "ср 01.10"
  [
    new RegExp(`(?<![\\p{L}])${WD}${GAP}(\\d{1,2})\\.(\\d{1,2})(?:\\.(\\d{4}|\\d{2}))?(?![\\d:])`, 'gu'),
    (m) => ({ weekday: m[1]!, d: m[2]!, month: Number(m[3]), y: m[4]?.padStart(4, '20'), dotted: true }),
  ],
  // "28 сентября, среда"
  [
    new RegExp(
      `(?<![\\p{L}\\d])(\\d{1,2})(?:-?го|-?е|st|nd|rd|th)?[ \\t]+(\\p{L}+)\\.?(?:[ \\t]+(\\d{4}))?${GAP}${WD}(?![\\p{L}])`,
      'gu',
    ),
    (m) => ({ d: m[1]!, month: monthIndex(m[2]!) + 1, y: m[3], weekday: m[4]! }),
  ],
  // "Sun 2026-09-28" and "2026-09-28, воскресенье"
  [
    new RegExp(`(?<![\\p{L}])${WD}${GAP}(\\d{4})-(\\d{2})-(\\d{2})`, 'gu'),
    (m) => ({ weekday: m[1]!, y: m[2], month: Number(m[3]), d: m[4]! }),
  ],
  [
    new RegExp(`(\\d{4})-(\\d{2})-(\\d{2})${GAP}${WD}(?![\\p{L}])`, 'gu'),
    (m) => ({ y: m[1], month: Number(m[2]), d: m[3]!, weekday: m[4]! }),
  ],
];

/** The calendar date of a day and month in the year that puts it nearest to today. */
function nearestDate(month: number, day: number, today: string): string | null {
  const year = Number(today.slice(0, 4));
  const todayMs = Date.parse(today);
  const candidates = [year - 1, year, year + 1]
    .map((candidate) => validDayKey(candidate, month, day))
    .filter((key): key is string => key !== null);
  return candidates.sort((a, b) => Math.abs(Date.parse(a) - todayMs) - Math.abs(Date.parse(b) - todayMs))[0] ?? null;
}

/** Whether `text` may name a weekday next to a date; streamed text that does is held until checked. */
export function mentionsWeekday(text: string): boolean {
  return WEEKDAY_WORD.test(text.toLowerCase().replaceAll('ё', 'е'));
}

/** Every weekday name in `text` written next to a date that falls on another weekday. */
export function findWeekdayDateMismatches(text: string, now: Date, timezone: string): WeekdayDateMismatch[] {
  // Lower-casing, "ё" and the heading line breaks turned into spaces keep every offset, so
  // a match in `normalized` slices the same pair out of `text`.
  const normalized = text
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(WEEKDAY_HEADING, (heading) => heading.replaceAll('\n', ' '));
  const datesDotted = COLON_CLOCK.test(normalized) || DOTTED_DATE.test(normalized);
  const { today } = localToday(now, timezone);
  const found = new Map<string, { at: number; mismatch: WeekdayDateMismatch }>();
  for (const [pattern, read] of PAIR_PATTERNS) {
    for (const match of normalized.matchAll(pattern)) {
      const parts = read(match);
      const at = match.index ?? 0;
      const end = at + match[0].length;
      if (
        parts.dotted &&
        parts.y === undefined &&
        Number(parts.d) <= 23 &&
        (!datesDotted || RANGE_AFTER.test(normalized.slice(end)))
      )
        continue;
      const weekday = PAIR_WEEKDAYS.get(parts.weekday);
      const date =
        parts.y === undefined
          ? nearestDate(parts.month, Number(parts.d), today)
          : validDayKey(Number(parts.y), parts.month, Number(parts.d));
      if (weekday === undefined || date === null || weekdayOf(date) === weekday) continue;
      // Step at most three days either way from the date to reach the named weekday.
      const forward = (weekday - weekdayOf(date) + 7) % 7;
      found.set(`${date}|${weekday}`, {
        at,
        mismatch: {
          phrase: text
            .slice(at, end)
            .replace(/\s+/gu, ' ')
            .replace(/[\s,:*_().–—-]+$/u, ''),
          date,
          said: WEEKDAY_NAMES[weekday]!,
          actual: WEEKDAY_NAMES[weekdayOf(date)]!,
          nearest: shiftDay(date, forward <= 3 ? forward : forward - 7),
        },
      });
    }
  }
  return [...found.values()].sort((a, b) => a.at - b.at).map(({ mismatch }) => mismatch);
}

/** Corrective English for the model: what each pair says, what is true, and the nearest named weekday. */
export function describeWeekdayDateMismatches(mismatches: WeekdayDateMismatch[]): string {
  return mismatches
    .map(
      ({ phrase, date, said, actual, nearest }) =>
        `«${phrase}»: ${date} is a ${actual}, not a ${said}; the nearest ${said} is ${nearest}`,
    )
    .join('; ');
}
