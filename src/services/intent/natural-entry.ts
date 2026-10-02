/**
 * Finite recognizers for terse natural calendar messages ("Завтра 13:15 стрижка",
 * "5 октября, ремонт в 16.00", "Бассейн отмени"). Each reads one line of bounded length
 * with a fixed token budget, classifies tokens against closed vocabularies and never
 * guesses: a message that is not exactly one clear request abstains with a named reason.
 * The output is structural text only; calendar resolution happens in the typed binding.
 */

export type ClockSuffix = 'am' | 'pm' | 'утра' | 'дня' | 'вечера' | 'ночи';
export interface ClockText {
  hour: number;
  /** null when the user wrote a bare hour such as "в 3". */
  minute: number | null;
  suffix: ClockSuffix | null;
}
export type DayText =
  | { kind: 'offset'; days: number }
  | { kind: 'weekday'; index: number }
  | { kind: 'absolute'; y: number | null; m: number; d: number };
export interface EventEntryParts {
  title: string;
  day: DayText;
  start: ClockText;
  end: ClockText | null;
  /** IANA zone named explicitly in the message ("по Москве"), otherwise null. */
  zone: string | null;
}
export type EntryAbstainReason =
  | 'too_long'
  | 'multiline'
  | 'question'
  | 'negation'
  | 'other_verb'
  | 'compound'
  | 'bulk'
  | 'recurring'
  | 'relative'
  | 'vague_date'
  | 'word_time'
  | 'unsupported_zone'
  | 'ambiguous_time'
  | 'ambiguous_date'
  | 'no_date'
  | 'no_time'
  | 'no_title'
  | 'two_dates'
  | 'two_times'
  | 'two_zones'
  | 'split_title'
  | 'multi_sentence';
export type EventEntryScan =
  | { kind: 'entry'; parts: EventEntryParts }
  | { kind: 'abstain'; reason: EntryAbstainReason };
export type CancelAbstainReason = EntryAbstainReason | 'no_verb' | 'shape' | 'reference' | 'dated';
export type CancelScan = { kind: 'target'; query: string } | { kind: 'abstain'; reason: CancelAbstainReason };

const MAX_ENTRY_CHARS = 800;
const MAX_CANCEL_CHARS = 200;
const MAX_TOKENS = 64;
const MAX_TITLE_CHARS = 200;

interface Token {
  lower: string;
  start: number;
  end: number;
}

const EDGE_CHARS = ',.;:!()«»"“”\'…—–';
const isEdge = (character: string) => EDGE_CHARS.includes(character);

/** Whitespace tokens with edge punctuation removed; spans index the original text. */
function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    if (tokens.length >= MAX_TOKENS) return null;
    let start = match.index;
    let end = start + match[0].length;
    while (start < end && isEdge(text[start]!)) start++;
    while (end > start && isEdge(text[end - 1]!)) end--;
    if (start === end) continue;
    tokens.push({ lower: text.slice(start, end).toLowerCase().replaceAll('ё', 'е'), start, end });
  }
  return tokens;
}

const lookup = <T>(table: { [key: string]: T }, key: string | undefined): T | undefined =>
  key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;

// ─── closed vocabularies ────────────────────────────────────────────────────

const DAY_OFFSETS: { [word: string]: number } = {
  сегодня: 0,
  today: 0,
  завтра: 1,
  tomorrow: 1,
  послезавтра: 2,
  вчера: -1,
  yesterday: -1,
};
const WEEKDAYS: { [word: string]: number } = {
  понедельник: 0,
  пн: 0,
  monday: 0,
  вторник: 1,
  вт: 1,
  tuesday: 1,
  среда: 2,
  среду: 2,
  ср: 2,
  wednesday: 2,
  четверг: 3,
  чт: 3,
  thursday: 3,
  пятница: 4,
  пятницу: 4,
  пт: 4,
  friday: 4,
  суббота: 5,
  субботу: 5,
  сб: 5,
  saturday: 5,
  воскресенье: 6,
  вс: 6,
  sunday: 6,
};
const MONTH_STEMS: [string, number][] = [
  ['январ', 1],
  ['феврал', 2],
  ['март', 3],
  ['апрел', 4],
  ['ма', 5],
  ['июн', 6],
  ['июл', 7],
  ['август', 8],
  ['сентябр', 9],
  ['октябр', 10],
  ['ноябр', 11],
  ['декабр', 12],
];
const MONTHS_EN: { [word: string]: number } = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};
const SUFFIXES: { [word: string]: ClockSuffix } = {
  утра: 'утра',
  дня: 'дня',
  вечера: 'вечера',
  ночи: 'ночи',
  am: 'am',
  pm: 'pm',
  'a.m': 'am',
  'p.m': 'pm',
};
const HOUR_WORDS = new Set(['час', 'часа', 'часов', 'ч', 'h']);
const WORD_CLOCKS: { [word: string]: ClockText } = {
  полдень: { hour: 12, minute: 0, suffix: null },
  noon: { hour: 12, minute: 0, suffix: null },
  полночь: { hour: 0, minute: 0, suffix: null },
  midnight: { hour: 0, minute: 0, suffix: null },
};
const ZONES: { [phrase: string]: string } = {
  мск: 'Europe/Moscow',
  msk: 'Europe/Moscow',
  'по мск': 'Europe/Moscow',
  'по москве': 'Europe/Moscow',
  'по белграду': 'Europe/Belgrade',
};
const PREPOSITIONS = new Set(['в', 'во', 'на', 'at', 'on', 'к']);
const CREATE_VERBS = new Set([
  'создай',
  'добавь',
  'поставь',
  'запланируй',
  'запиши',
  'внеси',
  'create',
  'add',
  'schedule',
]);
const LEAD_FILLERS = new Set(['мне', 'событие', 'новое', 'new', 'event', 'a', 'an']);
const CANCEL_VERBS = new Set(['удали', 'отмени', 'убери', 'cancel', 'delete', 'remove']);

const BLOCKED: [EntryAbstainReason, string[]][] = [
  ['negation', ['не', 'нельзя', 'никогда', 'no', 'not', "don't", 'dont', 'never']],
  ['question', ['ли', 'когда', 'что', 'сколько', 'кто', 'какой', 'какая', 'какие', 'почему', 'зачем', 'где', 'куда']],
  ['question', ['what', 'when', 'who', 'how', 'why', 'where', 'which']],
  [
    'other_verb',
    [
      ...CANCEL_VERBS,
      'удалить',
      'отменить',
      'перенеси',
      'перенести',
      'передвинь',
      'сдвинь',
      'отложи',
      'пригласи',
      'пригласить',
      'позови',
      'позовись',
      'уведоми',
      'предупреди',
      'напомни',
      'напоминай',
      'покажи',
      'найди',
      'переименуй',
      'скрой',
      'спрячь',
      'отправь',
      'пришли',
      'сделай',
      'измени',
      'поменяй',
      'move',
      'reschedule',
      'invite',
      'remind',
      'show',
      'find',
      'rename',
      'hide',
      'send',
      'notify',
    ],
  ],
  [
    'bulk',
    ['все', 'всех', 'весь', 'всю', 'вся', 'каждый', 'каждую', 'каждое', 'каждого', 'каждые', 'every', 'all', 'daily'],
  ],
  ['recurring', ['ежедневно', 'еженедельно', 'weekly', 'регулярно', 'регулярный', 'регулярным', 'регулярное']],
  ['relative', ['через', 'после', 'before', 'after']],
  [
    'vague_date',
    ['следующий', 'следующую', 'следующей', 'следующее', 'следующая', 'этот', 'эту', 'этой', 'прошлый', 'прошлую'],
  ],
  ['vague_date', ['next', 'this', 'last', 'coming']],
  ['word_time', ['утром', 'вечером', 'днем', 'ночью', 'morning', 'evening', 'afternoon', 'tonight']],
  ['unsupported_zone', ['gmt', 'utc', 'cet', 'cest', 'eet', 'eest', 'est', 'edt', 'pst', 'pdt', 'bst']],
];
const BLOCKED_WORDS = new Map<string, EntryAbstainReason>(
  BLOCKED.flatMap(([reason, words]) => words.map((word) => [word, reason] as const)),
);
const WORD_NUMBERS = new Set([
  'час',
  'один',
  'два',
  'три',
  'четыре',
  'пять',
  'шесть',
  'семь',
  'восемь',
  'девять',
  'десять',
  'одиннадцать',
  'двенадцать',
]);

function monthOf(word: string | undefined): number | null {
  if (word === undefined) return null;
  const en = lookup(MONTHS_EN, word);
  if (en !== undefined) return en;
  for (const [stem, month] of MONTH_STEMS) {
    if (!word.startsWith(stem)) continue;
    const ending = word.slice(stem.length);
    // "май/мая/мае" only: a bare "ма" or "маю" is not a month.
    if (stem === 'ма' ? /^[яйе]$/.test(ending) : /^[ьяаейю]?$/.test(ending)) return month;
  }
  return null;
}

/** Monday = 0; null when the word is not a weekday name. */
export function weekdayIndex(word: string): number | null {
  return lookup(WEEKDAYS, word.toLowerCase().replaceAll('ё', 'е')) ?? null;
}

const RECURRING_WORD = /^(?:регулярн|повторя)|^(?:понедельник|вторник|сред|четверг|пятниц|суббот|воскресень)ам$/;

/** One reason for any token that makes a single clear request impossible. */
function blockedReason(tokens: Token[], leadVerb: boolean): EntryAbstainReason | null {
  for (const [index, token] of tokens.entries()) {
    const word = token.lower;
    if (word.includes('http') || word.startsWith('www.') || word.includes('@')) return 'compound';
    if (CREATE_VERBS.has(word) && !(index === 0 && leadVerb)) return 'compound';
    if (RECURRING_WORD.test(word)) return 'recurring';
    if (/^(?:gmt|utc)[+-]\d{1,2}$/.test(word)) return 'unsupported_zone';
    const reason = BLOCKED_WORDS.get(word);
    if (reason) return reason;
    if (PREPOSITIONS.has(word) && WORD_NUMBERS.has(tokens[index + 1]?.lower ?? '')) return 'word_time';
  }
  return null;
}

// ─── date and clock readers ─────────────────────────────────────────────────

interface Read<T> {
  value: T;
  length: number;
}

function readDay(tokens: Token[], i: number): Read<DayText> | null {
  const word = tokens[i]!.lower;
  const offset = lookup(DAY_OFFSETS, word);
  if (offset !== undefined) return { value: { kind: 'offset', days: offset }, length: 1 };
  const weekday = lookup(WEEKDAYS, word);
  if (weekday !== undefined) return { value: { kind: 'weekday', index: weekday }, length: 1 };
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(word);
  if (iso) return absolute(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const full = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(word);
  if (full) return absolute(Number(full[3]), Number(full[2]), Number(full[1]));
  const slash = /^(\d{1,2})\/(\d{1,2})$/.exec(word);
  if (slash) return absolute(null, Number(slash[2]), Number(slash[1]));
  return readNamedMonth(tokens, i);
}

function absolute(y: number | null, m: number, d: number): Read<DayText> {
  return { value: { kind: 'absolute', y, m, d }, length: 1 };
}

/** "19 июня [2026 [года]]" or "june 19[th] [2026]". */
function readNamedMonth(tokens: Token[], i: number): Read<DayText> | null {
  const first = tokens[i]!.lower;
  const dayFirst = /^\d{1,2}$/.test(first) ? monthOf(tokens[i + 1]?.lower) : null;
  const monthFirst = dayFirst === null ? lookup(MONTHS_EN, first) : undefined;
  const dayText = dayFirst !== null ? first : monthFirst !== undefined ? tokens[i + 1]?.lower : undefined;
  const day = dayText === undefined ? null : /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(dayText);
  const month = dayFirst ?? monthFirst;
  if (!day || month === undefined) return null;
  let length = 2;
  let year: number | null = null;
  if (/^\d{4}$/.test(tokens[i + 2]?.lower ?? '')) {
    year = Number(tokens[i + 2]!.lower);
    length = /^(?:года|г)$/.test(tokens[i + 3]?.lower ?? '') ? 4 : 3;
  }
  return { value: { kind: 'absolute', y: year, m: month, d: Number(day[1]) }, length };
}

/** A clock written with minutes ("13:15", "18.00", "13-30"); "dot" marks d.mm that may be a date. */
function clockWord(word: string, inRange: boolean): ClockText | 'dot' | 'ambiguous' | null {
  const suffixed = /^(\d{1,2})(?::(\d{2}))?(am|pm)$/.exec(word);
  if (suffixed) {
    const minute = suffixed[2] === undefined ? null : Number(suffixed[2]);
    return { hour: Number(suffixed[1]), minute, suffix: suffixed[3] === 'am' ? 'am' : 'pm' };
  }
  const parts = /^(\d{1,2})([:.-])(\d{2})$/.exec(word);
  if (!parts) return null;
  const hour = Number(parts[1]);
  const minute = Number(parts[3]);
  if (hour > 23 || minute > 59) return parts[2] === '.' ? null : 'ambiguous';
  if (parts[2] === '.' && !inRange && minute >= 1 && minute <= 12) return 'dot';
  if (parts[2] === '-' && minute !== 0 && minute < 24) return 'ambiguous';
  return { hour, minute, suffix: null };
}

/** Optional "часов" and a day-part suffix after a clock. */
function readSuffix(tokens: Token[], i: number): Read<ClockSuffix | null> {
  let length = HOUR_WORDS.has(tokens[i]?.lower ?? '') ? 1 : 0;
  const suffix = lookup(SUFFIXES, tokens[i + length]?.lower);
  if (suffix !== undefined) length++;
  return { value: suffix ?? null, length };
}

/** A bare hour counts as a clock only next to a preposition, a date, an hour word or a suffix. */
function readClock(tokens: Token[], i: number, afterDate: boolean): Read<ClockText> | 'dot' | 'ambiguous' | null {
  const word = tokens[i]!.lower;
  const named = lookup(WORD_CLOCKS, word);
  if (named) return { value: named, length: 1 };
  const written = clockWord(word, false);
  if (written === 'dot' || written === 'ambiguous') return written;
  if (written) {
    const tail = readSuffix(tokens, i + 1);
    return { value: { ...written, suffix: written.suffix ?? tail.value }, length: 1 + tail.length };
  }
  if (!/^\d{1,2}$/.test(word) || Number(word) > 23) return null;
  const tail = readSuffix(tokens, i + 1);
  const previous = tokens[i - 1]?.lower ?? '';
  if (tail.length === 0 && !PREPOSITIONS.has(previous) && !afterDate) return null;
  return { value: { hour: Number(word), minute: null, suffix: tail.value }, length: 1 + tail.length };
}

function rangeEdge(word: string | undefined): ClockText | null {
  if (word === undefined) return null;
  if (/^\d{1,2}$/.test(word) && Number(word) <= 23) return { hour: Number(word), minute: null, suffix: null };
  const clock = clockWord(word, true);
  return clock && typeof clock === 'object' ? clock : null;
}

/** "16:00-23:00" in one token, or "с 13 до 15 [вечера]". */
function readRange(tokens: Token[], i: number): Read<{ start: ClockText; end: ClockText }> | null {
  const joined = /^(\d{1,2}[:.]\d{2})[-–](\d{1,2}[:.]\d{2})$/.exec(tokens[i]!.lower);
  if (joined) {
    const start = rangeEdge(joined[1]);
    const end = rangeEdge(joined[2]);
    return start && end ? { value: { start, end }, length: 1 } : null;
  }
  if (!['с', 'from'].includes(tokens[i]!.lower) || !['до', 'to', 'till', 'until'].includes(tokens[i + 2]?.lower ?? ''))
    return null;
  const start = rangeEdge(tokens[i + 1]?.lower);
  const end = rangeEdge(tokens[i + 3]?.lower);
  if (!start || !end) return null;
  const tail = readSuffix(tokens, i + 4);
  return { value: { start, end: { ...end, suffix: end.suffix ?? tail.value } }, length: 4 + tail.length };
}

function readZone(tokens: Token[], i: number): Read<string> | null {
  const two = lookup(ZONES, `${tokens[i]!.lower} ${tokens[i + 1]?.lower ?? ''}`);
  if (two) return { value: two, length: 2 };
  const one = lookup(ZONES, tokens[i]!.lower);
  return one ? { value: one, length: 1 } : null;
}

// ─── event entry ────────────────────────────────────────────────────────────

type Role = 'lead' | 'day' | 'clock' | 'zone' | 'prep';

interface Collected {
  roles: (Role | undefined)[];
  days: DayText[];
  clocks: { start: ClockText; end: ClockText | null }[];
  zones: string[];
  dots: number[];
  ambiguous: boolean;
}

function mark(state: Collected, from: number, length: number, role: Role): void {
  for (let k = from; k < from + length; k++) state.roles[k] = role;
}

function consumeLead(tokens: Token[], state: Collected): number {
  if (!CREATE_VERBS.has(tokens[0]?.lower ?? '')) return 0;
  let i = 1;
  while (i < tokens.length) {
    if (LEAD_FILLERS.has(tokens[i]!.lower)) i++;
    else if (tokens[i]!.lower === 'в' && tokens[i + 1]?.lower === 'календарь') i += 2;
    else break;
  }
  mark(state, 0, i, 'lead');
  return i;
}

/** One left-to-right pass; each reader claims whole tokens, the rest stay title candidates. */
function collect(tokens: Token[]): Collected {
  const state: Collected = { roles: [], days: [], clocks: [], zones: [], dots: [], ambiguous: false };
  let i = consumeLead(tokens, state);
  while (i < tokens.length) {
    const zone = readZone(tokens, i);
    if (zone) {
      state.zones.push(zone.value);
      mark(state, i, zone.length, 'zone');
      i += zone.length;
      continue;
    }
    const day = readDay(tokens, i);
    if (day) {
      state.days.push(day.value);
      mark(state, i, day.length, 'day');
      i += day.length;
      continue;
    }
    const range = readRange(tokens, i);
    if (range) {
      state.clocks.push(range.value);
      mark(state, i, range.length, 'clock');
      i += range.length;
      continue;
    }
    const clock = readClock(tokens, i, state.roles[i - 1] === 'day');
    if (clock === 'dot') state.dots.push(i);
    else if (clock === 'ambiguous') state.ambiguous = true;
    else if (clock) {
      state.clocks.push({ start: clock.value, end: null });
      mark(state, i, clock.length, 'clock');
      i += clock.length;
      continue;
    }
    i++;
  }
  return state;
}

/** "15.07" is a date when another token gives the time, a time when another gives the date. */
function resolveDots(tokens: Token[], state: Collected): EntryAbstainReason | null {
  if (state.dots.length > 1) return 'ambiguous_date';
  const index = state.dots[0];
  if (index === undefined) return null;
  const parts = /^(\d{1,2})\.(\d{2})$/.exec(tokens[index]!.lower);
  if (!parts) return 'ambiguous_date';
  const a = Number(parts[1]);
  const b = Number(parts[2]);
  if (state.clocks.length && !state.days.length) {
    state.days.push({ kind: 'absolute', y: null, m: b, d: a });
    state.roles[index] = 'day';
  } else if (state.days.length && !state.clocks.length) {
    state.clocks.push({ start: { hour: a, minute: b, suffix: null }, end: null });
    state.roles[index] = 'clock';
  } else return 'ambiguous_date';
  return null;
}

function markPrepositions(tokens: Token[], state: Collected): void {
  for (const [index, token] of tokens.entries()) {
    if (state.roles[index] || !PREPOSITIONS.has(token.lower)) continue;
    const next = state.roles[index + 1];
    if (next === 'day' || next === 'clock') state.roles[index] = 'prep';
  }
}

const trimEdges = (text: string) => text.replace(/^[\s,.;:—–-]+|[\s,.;:—–-]+$/g, '');

/** The unclaimed tokens, which must form one contiguous span, sliced from the original text. */
function titleOf(
  text: string,
  tokens: Token[],
  roles: (Role | undefined)[],
): { title: string } | { reason: EntryAbstainReason } {
  const free = tokens.flatMap((_, index) => (roles[index] ? [] : [index]));
  if (!free.length) return { reason: 'no_title' };
  if (free.some((index, k) => k > 0 && index !== free[k - 1]! + 1)) return { reason: 'split_title' };
  const title = trimEdges(text.slice(tokens[free[0]!]!.start, tokens[free[free.length - 1]!]!.end));
  if (!/\p{L}/u.test(title) || free.every((index) => PREPOSITIONS.has(tokens[index]!.lower)))
    return { reason: 'no_title' };
  if (/[.!;]\s/.test(title)) return { reason: 'multi_sentence' };
  return title.length > MAX_TITLE_CHARS ? { reason: 'too_long' } : { title };
}

function shapeReason(state: Collected): EntryAbstainReason | null {
  if (state.ambiguous) return 'ambiguous_time';
  if (!state.days.length) return 'no_date';
  if (state.days.length > 1) return 'two_dates';
  if (!state.clocks.length) return 'no_time';
  if (state.clocks.length > 1) return 'two_times';
  return state.zones.length > 1 ? 'two_zones' : null;
}

/** Split a trailing question mark off; it is only tolerated after an explicit create verb. */
function prepare(input: string, max: number): { text: string; asked: boolean } | EntryAbstainReason {
  if (input.length > max) return 'too_long';
  if (['\n', '\r', ' ', ' '].some((separator) => input.includes(separator))) return 'multiline';
  const trimmed = input.trim();
  const text = trimmed.replace(/[?!]+$/, '').trimEnd();
  if (text.includes('?')) return 'question';
  return { text, asked: /\?$/.test(trimmed) };
}

/** Recognize exactly one event entry with a title, a day and a start time, in any order. */
export function recognizeEventEntry(input: string): EventEntryScan {
  const abstain = (reason: EntryAbstainReason): EventEntryScan => ({ kind: 'abstain', reason });
  const prepared = prepare(input, MAX_ENTRY_CHARS);
  if (typeof prepared === 'string') return abstain(prepared);
  const tokens = tokenize(prepared.text);
  if (!tokens) return abstain('too_long');
  const leadVerb = CREATE_VERBS.has(tokens[0]?.lower ?? '');
  if (prepared.asked && !leadVerb) return abstain('question');
  const blocked = blockedReason(tokens, leadVerb);
  if (blocked) return abstain(blocked);
  const state = collect(tokens);
  const dots = resolveDots(tokens, state);
  if (dots) return abstain(dots);
  const shape = shapeReason(state);
  if (shape) return abstain(shape);
  markPrepositions(tokens, state);
  const titled = titleOf(prepared.text, tokens, state.roles);
  if ('reason' in titled) return abstain(titled.reason);
  const { start, end } = state.clocks[0]!;
  const zone = state.zones[0] ?? null;
  return { kind: 'entry', parts: { title: titled.title, day: state.days[0]!, start, end, zone } };
}

// ─── cancellation by title ──────────────────────────────────────────────────

const REFERENCE_WORDS = new Set([
  'его',
  'ее',
  'это',
  'эту',
  'этот',
  'эти',
  'него',
  'нее',
  'их',
  'тот',
  'ту',
  'то',
  'it',
  'this',
  'that',
  'them',
  'событие',
  'события',
  'встречу',
  'встречи',
  'контакт',
  'напоминание',
  'напоминания',
  'event',
  'events',
  'meeting',
  'contact',
  'reminder',
  'reminders',
  'и',
  'and',
]);

function isDated(token: Token): boolean {
  const word = token.lower;
  return (
    /\d/.test(word) ||
    lookup(DAY_OFFSETS, word) !== undefined ||
    lookup(WEEKDAYS, word) !== undefined ||
    lookup(WORD_CLOCKS, word) !== undefined ||
    /^(?:сегодняшн|завтрашн|вчерашн|утренн|вечерн)/.test(word)
  );
}

function cancelTargetReason(tokens: Token[]): CancelAbstainReason | null {
  for (const token of tokens) {
    if (token.lower.includes('@') || token.lower.includes('http')) return 'compound';
    if (CANCEL_VERBS.has(token.lower) || CREATE_VERBS.has(token.lower)) return 'shape';
    if (REFERENCE_WORDS.has(token.lower)) return 'reference';
    if (isDated(token) || monthOf(token.lower) !== null) return 'dated';
    const blocked = BLOCKED_WORDS.get(token.lower);
    if (blocked) return blocked;
  }
  return null;
}

/** "Отмени пробежку" / "Бассейн убери": one cancel verb first or last and a short undated title. */
export function recognizeCancelTarget(input: string): CancelScan {
  const abstain = (reason: CancelAbstainReason): CancelScan => ({ kind: 'abstain', reason });
  const prepared = prepare(input, MAX_CANCEL_CHARS);
  if (typeof prepared === 'string') return abstain(prepared);
  const tokens = tokenize(prepared.text);
  if (!tokens || tokens.length < 2 || tokens.length > 8) return abstain('shape');
  const verbFirst = CANCEL_VERBS.has(tokens[0]!.lower);
  const verbLast = CANCEL_VERBS.has(tokens[tokens.length - 1]!.lower);
  if (verbFirst === verbLast) return abstain(verbFirst ? 'shape' : 'no_verb');
  if (prepared.asked && !verbFirst) return abstain('question');
  const rest = verbFirst ? tokens.slice(1) : tokens.slice(0, -1);
  const reason = cancelTargetReason(rest);
  if (reason) return abstain(reason);
  const query = trimEdges(prepared.text.slice(rest[0]!.start, rest[rest.length - 1]!.end));
  if (!/\p{L}/u.test(query) || /[.!;]\s/.test(query)) return abstain('shape');
  return { kind: 'target', query };
}
