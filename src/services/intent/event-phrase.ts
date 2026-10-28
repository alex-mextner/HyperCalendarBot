// Deterministic reading of a free-form calendar phrase ("созвон с Пашей в пятницу в 18:30 на час") into typed slots.
// Every recognised date, clock time, duration and invitee is cut out of the text; what is left is the title. The
// parser is conservative by construction: two readings of the same slot, a bare hour, a next-weekday, a day part
// ("вечером"), a stray @mention, a command verb inside the title or an empty title all throw, and the caller falls
// back to the AI. Nothing here guesses.
import { nearDistance } from './canonical-input.ts';
import { fail, parseDate, parseTime } from './date-time-words.ts';

export interface EventPhrase {
  title: string;
  /** YYYY-MM-DD in the user's zone, or null when the phrase names no day. */
  date: string | null;
  /** HH:MM, or null when the phrase names no time. */
  time: string | null;
  endTime: string | null;
  durationMinutes: number | null;
  /** Telegram username without "@", or null. */
  invitee: string | null;
}

export interface PhraseOptions {
  now: Date;
  timezone: string;
  /** A name for the event is required (create, rename); false for a reference to an existing event. */
  requireTitle?: boolean;
}

const MONTH_RU = '(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)';
const MONTH_EN =
  '(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)';
const DAY_PART = '(?:утра|дня|вечера|ночи|am|pm|a\\.m\\.|p\\.m\\.)';
const BOUNDARY = String.raw`(?=[\s,;]|[.!?](?:\s|$)|$)`;
const START = String.raw`(?:^|[\s,;])`;

interface Cut<T> {
  rest: string;
  value: T | null;
}

/** Cuts the single match of `pattern` out of `rest`; two matches are an ambiguity, so the parse fails. */
function cutOne(rest: string, pattern: RegExp): Cut<RegExpExecArray> {
  const matches = [...rest.matchAll(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))];
  if (matches.length === 0) return { rest, value: null };
  if (matches.length > 1) return fail();
  const match = matches[0]!;
  const lead = /^[\s,;]/.test(match[0]) ? 1 : 0;
  const start = match.index + lead;
  return { rest: `${rest.slice(0, start)} ${rest.slice(match.index + match[0].length)}`, value: match };
}

const clock = (hours: string, minutes: string | undefined, suffix: string | undefined): string =>
  parseTime(`${hours}${minutes === undefined ? '' : `:${minutes}`}${suffix ? ` ${suffix.replace(/\./g, '')}` : ''}`);

const RANGE = new RegExp(
  String.raw`${START}(?:(?:с|from)\s+)?(\d{1,2})(?:[:.](\d{2}))?(?:\s*(${DAY_PART}))?\s*(?:до|по|to|until|-|–|—)\s*(\d{1,2})(?:[:.](\d{2}))?(?:\s*(${DAY_PART}))?(?!\s+(?:человек|чел|раз|штук|шт|руб|рубл|км|кг|минут|мин|дн|день|дней)(?:\s|$|[.,;!?]))${BOUNDARY}`,
  'iu',
);
// A dot is a time separator only after a time word: "15.10" alone is a date.
const TIME_WITH_MINUTES = new RegExp(
  String.raw`${START}(?:(?:в|к|at|@)\s*(\d{1,2})[:.](\d{2})|(\d{1,2}):(\d{2}))(?:\s*(${DAY_PART}))?${BOUNDARY}`,
  'iu',
);
const WEEKDAY_NAMES =
  'понедельник|вторник|среду|среда|четверг|пятницу|пятница|субботу|суббота|воскресенье|пн|вт|ср|чт|пт|сб|вс|monday|tuesday|wednesday|thursday|friday|saturday|sunday|tues|thurs|thur';
// "завтра 8.15", "Суббота 13.30", "В четверг 9.00": minutes above 12 (or 00) cannot be a month, so such a dotted pair is a clock time.
const TIME_DOTTED = new RegExp(String.raw`${START}([01]?\d|2[0-3])\.((?:00|1[3-9]|[2-5]\d))${BOUNDARY}`, 'iu');
// "Завтра 13 нотариус", "Понедельник 13 самокат": an hour from 13 to 23 straight after the day is unambiguous.
const BARE_HOUR_AFTER_DAY = new RegExp(
  String.raw`(${START}(?:(?:на|в|во|on)\s+)?(?:сегодня|завтра|послезавтра|today|tomorrow|${WEEKDAY_NAMES}|\d{1,2}(?:-?го)?\s+${MONTH_RU}|\d{1,2}[./]\d{1,2}(?:[./]\d{4})?))[,.]?\s+(1[3-9]|2[0-3])(?=\s+[\p{L}«"“])(?!\s+(?:минут|мин|час|ч|чел|человек|раз|штук|шт|руб|рубл|₽|км|кг|дн|день|дней|недел|месяц|год|лет|января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s|$|[.,;!?]))`,
  'iu',
);
const TIME_HOUR = new RegExp(
  String.raw`${START}(?:в|к|at)\s+(\d{1,2})(?:\s*(?:час(?:а|ов)?|ч|h))?(?:\s*(${DAY_PART}))?(?!\s*(?:${MONTH_RU}|${MONTH_EN}|числа))${BOUNDARY}`,
  'iu',
);
const TIME_WORD = new RegExp(String.raw`${START}(?:в\s+|at\s+)?(полдень|полночь|noon|midnight)${BOUNDARY}`, 'iu');
// "9 утра", "на 8 вечера", "4pm": the day-part word fixes the hour, so no "в"/"at" is needed ("в 9" alone stays bare).
const TIME_DAY_PART = new RegExp(
  String.raw`${START}(?:(?:в|к|at|на|by|for)\s+)?(?<!(?:через|in)\s+)(\d{1,2})(?:[:.](\d{2}))?\s*(${DAY_PART})${BOUNDARY}`,
  'iu',
);

const DAY_WORD = new RegExp(
  String.raw`${START}(?:(?:на|в|for|on)\s+)?(сегодня|завтра|послезавтра|вчера|today|tomorrow|day after tomorrow|yesterday)${BOUNDARY}`,
  'iu',
);
const THROUGH = new RegExp(
  String.raw`${START}(через|in)\s+(\d{1,3}|одну)\s+(дн(?:я|ей)|день|недел(?:ю|и|ь)|days?|weeks?)${BOUNDARY}`,
  'iu',
);
const THROUGH_WEEK = new RegExp(String.raw`${START}(?:через|in)\s+(?:неделю|a week|one week)${BOUNDARY}`, 'iu');
const WEEKDAY = new RegExp(
  String.raw`${START}(?:(следующ\S+|будущ\S+|next|эту|эта|this|ближайш\S+)\s+)?(?:(?:в|во|on|на|к)\s+)?(?:(следующ\S+|будущ\S+|next|эту|эта|this|ближайш\S+)\s+)?(${WEEKDAY_NAMES})${BOUNDARY}`,
  'iu',
);
const ISO_DATE = new RegExp(String.raw`${START}(?:(?:на|в|on)\s+)?(\d{4}[-./]\d{1,2}[-./]\d{1,2})${BOUNDARY}`, 'iu');
const NUMERIC_DATE = new RegExp(
  String.raw`${START}(?:(?:на|в|on|до)\s+)?(\d{1,2}[./]\d{1,2}(?:[./]\d{4})?)${BOUNDARY}`,
  'iu',
);
const RU_DATE = new RegExp(
  String.raw`${START}(?:(?:на|в|до)\s+)?(\d{1,2})(?:-?го)?\s+(${MONTH_RU})(?:\s+(\d{4}))?(?:\s+года)?${BOUNDARY}`,
  'iu',
);
const EN_DATE = new RegExp(
  String.raw`${START}(?:(?:on|for|by)\s+)?(${MONTH_EN})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?${BOUNDARY}`,
  'iu',
);
const EN_DATE_DAY_FIRST = new RegExp(
  String.raw`${START}(?:(?:on|for|by)\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(${MONTH_EN})(?:,?\s+(\d{4}))?${BOUNDARY}`,
  'iu',
);

const DURATION = new RegExp(
  String.raw`${START}(?:на|for)\s+(?:(полчаса|half an hour|час|an hour)|(\d{1,3})\s*(часа|часов|час|ч|минут|минуты|минуту|мин|hours?|hrs?|h|minutes?|mins?))${BOUNDARY}`,
  'iu',
);
const INVITE = new RegExp(
  String.raw`${START}(?:(?:и|and)\s+)?(?:пригласи(?:ть)?|позови|invite)\s+(?:(?:туда|его|её|ее|them|him|her)\s+)?@([A-Za-z][A-Za-z0-9_]{4,31})${BOUNDARY}`,
  'iu',
);
// No invite verb: "@anna завтра в 15:00 созвон" (handle first) and "созвон завтра в 15:00 с @anna" name a companion.
const INVITE_IMPLICIT = new RegExp(
  String.raw`(?:^\s*|${START}(?:с|with)\s+)@([A-Za-z][A-Za-z0-9_]{4,31})${BOUNDARY}`,
  'iu',
);

/** Words that mean the message is something other than "an event called X": commands, questions, day parts. */
const NOT_A_TITLE =
  /(?:^|\s)(?:меня|удали\S*|убери\S*|отмени\S*|сними|выкинь|подвинь|подвинуть|переставь|отложи|скрой|спрячь|снеси|назови|измени|поменяй|push|shift|bump|snooze|postpone|hide|отправь|перенеси\S*|передвинь|сдвинь|перекинь|переименуй|покажи\S*|найди|поищи|скажи|напомни\S*|пригласи\S*|позови|создай\S*|добавь\S*|запланируй\S*|поставь|запиши|delete|remove|cancel|move|reschedule|show|find|invite|create|add|schedule|remind|кажд\S+|ежедневно|еженедельно|ежемесячно|ежегодно|по\s+(?:понедельникам|вторникам|средам|четвергам|пятницам|субботам|воскресеньям|будням|выходным)|every|daily|weekly|monthly|yearly|annually|recurring|repeat\S*|повторя\S*|что|как|когда|где|кто|зачем|почему|сколько|какой|какая|какие|what|when|where|who|why|how|which|утром|вечером|днем|днём|ночью|morning|evening|afternoon|tonight|вечер|утро)(?=\s|$)/iu;
const LEADING_FILL =
  /^(?:(?:и|а|в|во|на|к|по|с|о|об|для|про|to|for|at|on|the|a|an|and|that|что|чтобы|мне|me|my)\s+)+/iu;
const TRAILING_FILL =
  /(?:\s+(?:и|а|в|во|на|к|по|с|о|об|для|про|to|for|at|on|the|a|an|and|that|что|чтобы|мне|me|my))+$/iu;
const GENERIC_NOUN =
  /^(?:(?:новое|новую|новый|new)\s+)?(событие|события|задачу|напоминание|мероприятие|event|events|task|reminder)[.:]?\s+(?=\S)/iu;
const ZONE_PLACE = /\s(?:по|in)\s+\p{Lu}\p{L}+/u;
const ZONE_ABBREVIATION = /(?:^|\s)(?:GMT|UTC|msk|мск|cet|cest|est|edt|pst|pdt|bst)(?=[\s+\-\d.,;]|$)/iu;
const DESCRIPTION_CLAUSE = /(?:^|\s)(?:с\s+описанием|описание|description)(?=\s|[:,.]|$)/iu;
const PEOPLE_LIST = /(?:,[^,]*,|\s(?:и|and)\s+(?:мной|мною|me|myself)(?=\s|$|[.,;!?]))/iu;
// "вместе с ним", "на нас двоих", "для обоих": a pronoun names a participant the rule cannot identify.
const PARTICIPANT_PRONOUN =
  /(?:^|\s)(?:(?:вместе\s+)?с\s+(?:ним|ней|ними|нами|тобой|вами|мной)|на\s+(?:нас|них|вас|двоих|троих|обоих|обеих)|для\s+(?:нас|них|вас|обоих|обеих|двоих)|у\s+(?:нас|них|вас)|(?:вдвоем|вдвоём|втроем|втроём|вчетвером)|(?:всем|всеми|все)\s+вместе|together\s+with\s+(?:him|her|them|us))(?=\s|$|[.,;!?])/iu;
// A word that mixes letters and digits ("Зав9тра", "Пет5ю") is a typo, not a name: the title is not trustworthy.
const LETTER_DIGIT_MIX = /(?:\p{L}\d|\d\p{L})/u;
const MAX_TITLE_WORDS = 14;
const MAX_TITLE_CHARS = 200;

/** Command verbs a user opens a create request with; the matching rule gates on the common ones, this list also covers slang. */
const COMMAND_VERBS = [
  'создай',
  'создайте',
  'создать',
  'добавь',
  'добавьте',
  'добавить',
  'запланируй',
  'запланируйте',
  'запланировать',
  'поставь',
  'поставьте',
  'поставить',
  'запиши',
  'запишите',
  'записать',
  'закинь',
  'кинь',
  'внеси',
  'занеси',
  'заведи',
  'забей',
  'организуй',
  'назначь',
  'назначить',
  'оформи',
  'сделай',
  'напомни',
  'напомните',
  'create',
  'add',
  'schedule',
  'book',
  'put',
  'plan',
  'block',
  'make',
  'arrange',
  'organise',
  'organize',
  'remind',
];
const COMMAND_SET = new Set(COMMAND_VERBS);
const FILLER_ANYWHERE =
  /(?:^|\s)(?:пожалуйста|пожалуй|плиз|плз|please|pls|plz|щас|kindly|будь\s+так\s+добр[ао]?|будь\s+добр[ао]?)(?=[\s,;.!]|$)/giu;
const CALENDAR_PHRASE =
  /^(?:(?:в|во|на|to|into|in|on)\s+(?:мой\s+|мое\s+|моё\s+|my\s+)?(?:календарь|календаре|расписание|расписании|calendar|schedule|agenda)\s+)/iu;
const SET_UP = /^set\s+up\s+/iu;

function isCommandWord(word: string): boolean {
  const lower = word.toLowerCase();
  if (COMMAND_SET.has(lower)) return true;
  return (
    lower.length >= 5 &&
    COMMAND_VERBS.some((verb) => verb[0] === lower[0] && verb.length >= 5 && nearDistance(lower, verb) <= 1)
  );
}

/** Drops the leading command (and a one-letter-typo of it), "в календарь", and courtesy words from the remainder. */
function stripCommand(text: string): string {
  let rest = text.replace(FILLER_ANYWHERE, ' ').replace(/\s+/g, ' ').trim();
  for (let round = 0; round < 3; round++) {
    const before = rest;
    rest = rest.replace(SET_UP, '');
    const [first = '', ...others] = rest.split(' ');
    if (others.length > 0 && isCommandWord(first.replace(/[,.;:!]+$/, ''))) rest = others.join(' ');
    rest = rest.replace(/^(?:мне|себе|нам|for me|me)\s+/iu, '').replace(CALENDAR_PHRASE, '');
    if (rest === before) break;
  }
  return rest;
}

/** Feminine accusative of the opening nouns ("встречу" → "встреча"): a title is a name, not the object of a verb. */
function nominative(word: string): string {
  if (word.length < 5 || !/^[а-яё]+$/i.test(word)) return word;
  return word
    .replace(/ку$/i, 'ка')
    .replace(/чу$/i, 'ча')
    .replace(/ию$/i, 'ия')
    .replace(/ую$/i, 'ая')
    .replace(/Ку$/, 'Ка');
}

function cleanTitle(text: string): string {
  let title = stripCommand(text)
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:.\-–—!?"“”«»']+|[\s,;:.\-–—!?"“”«»']+$/g, '')
    .trim();
  for (let round = 0; round < 3; round++) {
    const before = title;
    title = title.replace(LEADING_FILL, '').replace(TRAILING_FILL, '').trim();
    if (title === before) break;
  }
  title = title.replace(GENERIC_NOUN, '');
  title = title
    .split(' ')
    .map((word, index, words) =>
      index === 0 || (index === 1 && /(?:ую|юю)$/iu.test(words[0] ?? '')) ? nominative(word) : word,
    )
    .join(' ');
  title = title.replace(/^[\s,;:.\-–—!?"“”«»']+|[\s,;:.\-–—!?"“”«»']+$/g, '').trim();
  if (/^(?:«[^»]+»|"[^"]+"|“[^”]+”)$/u.test(title)) title = title.slice(1, -1).trim();
  return title;
}

function durationOf(match: RegExpExecArray): number {
  if (match[1]) return /^(?:полчаса|half)/i.test(match[1]) ? 30 : 60;
  const amount = Number(match[2]);
  const hours = /^(?:час|ч$|hour|hr|h$)/i.test(match[3] ?? '');
  const minutes = hours ? amount * 60 : amount;
  return minutes >= 5 && minutes <= 1440 ? minutes : fail();
}

interface PhraseCursor {
  rest: string;
  time: string | null;
  endTime: string | null;
}

function takeInvitee(cursor: PhraseCursor, text: string): string | null {
  const invited = cutOne(cursor.rest, INVITE);
  cursor.rest = invited.rest;
  if (invited.value) return invited.value[1]!;
  // A capitalised word right after a leading handle is a name or a title: which one is not for a rule to guess.
  if (/^\s*@\S+\s+\p{Lu}/u.test(text)) return fail();
  const implicit = cutOne(cursor.rest, INVITE_IMPLICIT);
  cursor.rest = implicit.rest;
  return implicit.value ? implicit.value[1]! : null;
}

function takeRange(cursor: PhraseCursor): void {
  const range = cutOne(cursor.rest, RANGE);
  if (!range.value) return;
  const [, h1, m1, s1, h2, m2, s2] = range.value;
  // A bare "5-7" is more likely days or a score than hours: a dash range needs a clock mark on a side.
  const dash = /[-–—]/.test(range.value[0]);
  if (dash && m1 === undefined && m2 === undefined && !s1 && !s2) fail();
  cursor.rest = range.rest;
  cursor.time = clock(h1!, m1, s1);
  cursor.endTime = clock(h2!, m2, s2);
}

function takeTime(cursor: PhraseCursor, pattern: RegExp, read: (m: RegExpExecArray) => string): void {
  const cut = cutOne(cursor.rest, pattern);
  if (!cut.value) return;
  if (cursor.time !== null) fail();
  cursor.rest = cut.rest;
  cursor.time = read(cut.value);
}

function takeBareHour(cursor: PhraseCursor): void {
  const bare = BARE_HOUR_AFTER_DAY.exec(cursor.rest);
  if (!bare) return;
  cursor.rest = `${cursor.rest.slice(0, bare.index)}${bare[1]} ${cursor.rest.slice(bare.index + bare[0].length)}`;
  cursor.time = clock(bare[2]!, undefined, undefined);
}

function takeTimes(cursor: PhraseCursor): void {
  takeRange(cursor);
  takeTime(cursor, TIME_WITH_MINUTES, (m) => clock(m[1] ?? m[3]!, m[2] ?? m[4], m[5]));
  takeTime(cursor, TIME_DOTTED, (m) => clock(m[1]!, m[2], undefined));
  takeTime(cursor, TIME_HOUR, (m) => clock(m[1]!, undefined, m[2]));
  takeTime(cursor, TIME_DAY_PART, (m) => clock(m[1]!, m[2], m[3]));
  takeTime(cursor, TIME_WORD, (m) => parseTime(m[1]!));
  if (cursor.time === null) takeBareHour(cursor);
  if (cursor.endTime !== null && cursor.time !== null && cursor.endTime <= cursor.time) fail();
}

const isRelativeWeekday = (part: string | undefined): boolean => Boolean(part && /следующ|будущ|next/i.test(part));

function takeDatePart(
  cursor: PhraseCursor,
  dates: string[],
  pattern: RegExp,
  read: (m: RegExpExecArray) => string,
): void {
  const cut = cutOne(cursor.rest, pattern);
  if (!cut.value) return;
  cursor.rest = cut.rest;
  dates.push(read(cut.value));
}

function takeDate(cursor: PhraseCursor, options: PhraseOptions): string | null {
  const dates: string[] = [];
  const reading = (raw: string) => parseDate(raw, { future: true, words: WORDS }, options.now, options.timezone, false);
  const take = (pattern: RegExp, read: (m: RegExpExecArray) => string) => takeDatePart(cursor, dates, pattern, read);
  take(DAY_WORD, (m) => reading(m[1]!.toLowerCase()));
  take(THROUGH, (m) => reading(`${m[1]!.toLowerCase()} ${m[2] === 'одну' ? '1' : m[2]} ${m[3]!.toLowerCase()}`));
  take(THROUGH_WEEK, () => reading('через неделю'));
  take(WEEKDAY, (m) => {
    // "next Friday" and "в следующую пятницу" are ambiguous between this week's and next week's: never guessed.
    if (isRelativeWeekday(m[1]) || isRelativeWeekday(m[2])) return fail();
    return reading(m[3]!.toLowerCase());
  });
  take(ISO_DATE, (m) => reading(m[1]!));
  take(RU_DATE, (m) => reading(`${m[1]} ${m[2]!.toLowerCase()}${m[3] ? ` ${m[3]}` : ''}`));
  take(EN_DATE, (m) => reading(`${m[1]!.toLowerCase()} ${m[2]}${m[3] ? ` ${m[3]}` : ''}`));
  take(EN_DATE_DAY_FIRST, (m) => reading(`${m[1]} ${m[2]!.toLowerCase()}${m[3] ? ` ${m[3]}` : ''}`));
  take(NUMERIC_DATE, (m) => reading(m[1]!));
  // "завтра в четверг": a weekday that only repeats the day word names the same date and is not a second day.
  if (new Set(dates).size > 1) return fail();
  return dates[0] ?? null;
}

/** Refuses a remainder that holds something the rules do not read as part of a plain title. */
function assertPlainRemainder(rest: string): void {
  if (/@|https?:\/\/|www\./i.test(rest)) fail();
  if (NOT_A_TITLE.test(rest)) fail();
  // A time in another place's zone ("по Полюсу", "GMT+4"), a description clause and a list of people are separate
  // requests the rules do not read: the AI takes them.
  if (
    ZONE_PLACE.test(rest) ||
    ZONE_ABBREVIATION.test(rest) ||
    DESCRIPTION_CLAUSE.test(rest) ||
    PEOPLE_LIST.test(rest) ||
    PARTICIPANT_PRONOUN.test(rest) ||
    LETTER_DIGIT_MIX.test(rest)
  )
    fail();
  // Two filled lines are two requests: a title that still has text on both sides of a line break is refused.
  if (rest.split(';').filter((part) => /\p{L}/u.test(part)).length > 1) fail();
}

function validTitle(rest: string, options: PhraseOptions): string {
  const title = cleanTitle(rest);
  if (title.length > MAX_TITLE_CHARS || title.split(' ').length > MAX_TITLE_WORDS) return fail();
  if (options.requireTitle && (title.length === 0 || !/\p{L}/u.test(title))) return fail();
  // A leftover digit group next to a time word is a time the grammar did not read: refuse rather than keep it in the title.
  if (/(?:^|\s)(?:в|к|at)\s+\d{1,2}(?:[:.]\d{2})?(?=\s|$)/iu.test(title)) return fail();
  return title;
}

/** Parses a phrase; throws WorkflowInputError when any slot is ambiguous or the remainder is not a plain title. */
export function parseEventPhrase(text: string, options: PhraseOptions): EventPhrase {
  // A line break separates two lines of a pasted block; it must stay visible so two filled lines are never one title.
  const cursor: PhraseCursor = {
    rest: ` ${text.trim().replace(/\s*[\r\n\u2028\u2029]+\s*/gu, ' ; ')} `,
    time: null,
    endTime: null,
  };
  const invitee = takeInvitee(cursor, text);
  takeTimes(cursor);
  const date = takeDate(cursor, options);

  let duration: number | null = null;
  const lasting = cutOne(cursor.rest, DURATION);
  if (lasting.value) {
    cursor.rest = lasting.rest;
    duration = durationOf(lasting.value);
  }
  if (cursor.endTime !== null && duration !== null) return fail();

  assertPlainRemainder(cursor.rest);
  const title = validTitle(cursor.rest, options);
  return {
    title: capitalize(title),
    date,
    time: cursor.time,
    endTime: cursor.endTime,
    durationMinutes: duration,
    invitee,
  };
}

const WORDS = {
  сегодня: 'today',
  today: 'today',
  завтра: 'tomorrow',
  tomorrow: 'tomorrow',
  послезавтра: 'day_after_tomorrow',
  'day after tomorrow': 'day_after_tomorrow',
  вчера: 'yesterday',
  yesterday: 'yesterday',
} as const;

const capitalize = (title: string): string => (title.length === 0 ? title : title[0]!.toUpperCase() + title.slice(1));
