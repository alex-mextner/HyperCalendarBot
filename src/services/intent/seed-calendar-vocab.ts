// Shared vocabulary of the read-only calendar families: word separators, day and period phrases, how a question about
// the calendar opens (READ_LEAD) and the trigger lists. The family modules (seed-calendar-read, seed-calendar-free and
// seed-calendar) only combine these pieces into rules.

import { phraseTable } from './seed-fragments.ts';

// ─── building blocks ────────────────────────────────────────────────────────

/** Word separator that also tolerates a comma: "скажи, что у меня завтра". */
export const S = String.raw`[\s,]+`;

/** Literal phrases as one alternation, longest first; a space between words is S. Regex fragments inside a word are kept. */
export function any(phrases: readonly string[]): string {
  return `(?:${[...phrases]
    .sort((a, b) => b.length - a.length)
    .map((phrase) => phrase.trim().split(/\s+/).join(S))
    .join('|')})`;
}

/** Up to `max` of these words after something, in any order ("что у меня там есть"). */
export const fillers = (phrases: readonly string[], max: number): string => `(?:${S}${any(phrases)}){0,${max}}`;

/**
 * `{{$first}} {{$first+1}} …`: all alternative capture groups of one slot, empty ones dropped by default(""). The
 * one very common misspelling of a weekday ("воскресение") is mended here because bindings read the user's own
 * words, not the typo-repaired text.
 */
export function groupsFrom(first: number, last: number, weekdayGroups: readonly number[] = []): string {
  const parts: string[] = [];
  for (let group = first; group <= last; group++)
    parts.push(
      weekdayGroups.includes(group)
        ? `{{$${group}|default("")|lower|replace("воскресение","воскресенье")}}`
        : `{{$${group}|default("")}}`,
    );
  return parts.join(' ');
}

// ─── days ───────────────────────────────────────────────────────────────────

type DayKey = 'today' | 'tomorrow' | 'day_after_tomorrow' | 'yesterday';
const DAY_ENTRIES: readonly (readonly [readonly string[], DayKey])[] = [
  [['сегодня', 'седня', 'сегодняшний день', 'today'], 'today'],
  [['завтра', 'завтрашний день', 'tomorrow'], 'tomorrow'],
  [
    ['послезавтра', 'после завтра', 'послезавтрашний день', 'day after tomorrow', 'the day after tomorrow'],
    'day_after_tomorrow',
  ],
  [['вчера', 'вчерашний день', 'yesterday'], 'yesterday'],
];
export const DAY_WORDS = phraseTable(DAY_ENTRIES);
const DAY_WORD_LIST = DAY_ENTRIES.flatMap(([phrases]) => phrases);

const WEEKDAY_FULL = [
  'понедельник',
  'вторник',
  'среду',
  'среда',
  'четверг',
  'пятницу',
  'пятница',
  'субботу',
  'суббота',
  'воскресенье',
  'воскресение',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];
// Abbreviations are ordinary words ("вс", "ср", "sun") elsewhere, so they count as a day only after a preposition.
export const WEEKDAY_SHORT = [
  'пн',
  'вт',
  'ср',
  'чт',
  'пт',
  'сб',
  'вс',
  'mon',
  'tue',
  'tues',
  'wed',
  'thu',
  'thur',
  'thurs',
  'fri',
  'sat',
  'sun',
];

const MONTH_RU = '(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)';
const MONTH_EN =
  '(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)';
const ORDINAL_SUFFIX = '(?:-?(?:го|е|ое|ого)|st|nd|rd|th)?';
const THROUGH = String.raw`(?:через|in)\s+(?:\d{1,3}\s+(?:дня|дней|день|days?|недел[юиь]|weeks?)|(?:одну\s+)?неделю)`;
// A number-and-dot date. "в 10.30" is a time, so a numeric date never takes "в".
const NUMERIC_DATE = String.raw`\d{4}[./-]\d{1,2}[./-]\d{1,2}|\d{1,2}[./-]\d{1,2}[./-]\d{4}|\d{1,2}[./-]\d{1,2}|${MONTH_EN}\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:\s+\d{4})?`;

/** Number of capture groups in DAY_REF (words, short weekday, numeric date, day number, month, year). */
export const DAY_REF_GROUPS = 6;
export const DAY_REF = String.raw`(?:(?:(?:на|в|во|on|for)\s+(?:(?:эту|этот|ближайшую|ближайший|this)\s+)?)?(${any([...DAY_WORD_LIST, ...WEEKDAY_FULL])}|${THROUGH})|(?:в|во|на|on)\s+(${any(WEEKDAY_SHORT)})|(?:(?:на|on|for)\s+)?(${NUMERIC_DATE})|(?:(?:на|on|for)\s+)?(\d{1,2})${ORDINAL_SUFFIX}\s+(?:of\s+)?(${MONTH_RU}|${MONTH_EN})(?:\s+(\d{4}))?)`;
/** The day-first shapes ("послезавтра что") only name a day by word or weekday. */
export const DAY_REF_LITE_GROUPS = 2;
export const DAY_REF_LITE = String.raw`(?:(?:(?:на|в|во|on|for)\s+(?:(?:эту|этот|ближайшую|ближайший|this)\s+)?)?(${any([...DAY_WORD_LIST, ...WEEKDAY_FULL])}|${THROUGH})|(?:в|во|на|on)\s+(${any(WEEKDAY_SHORT)}))`;

// ─── how a question about the calendar opens and trails off ────────────────

export const SHOW_RU = `${any(['покажи', 'покажите', 'покажешь', 'не покажешь', 'показать', 'скинь', 'скиньте', 'кинь', 'кидай', 'сбрось', 'пришли', 'глянь', 'глянуть', 'гляну', 'посмотри', 'посмотрите', 'посмотришь', 'посмотреть', 'выведи', 'дай', 'открой', 'расскажи', 'расскажите', 'не расскажешь', 'рассказать', 'скажи', 'скажите', 'скажешь', 'не скажешь', 'сказать', 'подскажи', 'подскажите', 'подскажешь', 'не подскажешь', 'не подскажете', 'подсказать', 'напиши', 'отправь', 'напомни', 'проверь', 'проверьте', 'проверить', 'узнай', 'узнать', 'знать', 'уточни', 'зачитай', 'озвучь', 'вспомни', 'увидеть', 'интересно', 'хотел бы узнать', 'хотела бы узнать', 'хотел бы знать', 'хотела бы знать'])}(?:${S}(?:мне|ка|пожалуйста|плиз)){0,2}`;
// "дай завтра" or "пришли завтра" is not a question: only these verbs may stand directly before a day.
export const SHOW_RU_BARE = `${any(['покажи', 'покажите', 'покажешь', 'показать', 'глянь', 'глянуть', 'посмотри', 'посмотреть', 'выведи'])}(?:${S}(?:мне|ка))?`;
const WHAT_RU = `(?:что|че|чо|шо)${fillers(['же', 'там', 'тут', 'вообще', 'еще', 'у меня', 'у нас', 'у меня там', 'по плану', 'по планам', 'по календарю', 'по расписанию', 'по делам', 'по встречам', 'в плане', 'в календаре', 'в расписании', 'на календаре', 'щас', 'сейчас', 'есть', 'будет', 'стоит', 'стоят', 'запланировано', 'намечено', 'планируется', 'записано', 'назначено'], 4)}`;
const DOING_RU = `(?:что${S}я${S}делаю|что${S}мне${S}предстоит|что${S}(?:меня${S})?жд(?:ет|ёт)(?:${S}меня)?|чем${S}(?:я${S})?занят(?:а)?|занят(?:а)?${S}ли${S}я)`;
// "Какие у меня планы / встречи на завтра", "какое у меня расписание".
const WHICH_RU = `(?:какие${S}(?:у${S}меня${S})?(?:планы|встречи|события|дела|мероприятия)${fillers(['есть', 'запланированы', 'намечены', 'назначены', 'будут'], 2)}|(?:какое|каково)${S}(?:у${S}меня${S})?расписание)`;
// "events"/"agenda" are common inside a Russian sentence ("покажи events на завтра").
export const NOUN_RU = `(?:(?:мои|мое|мой)${S})?(?:события|встречи|дела|планы|план|расписание|календарь|задачи|мероприятия|events|agenda|schedule)`;
const SOMETHING_RU = `(?:что-?то|что-?нибудь|(?:какие-?то${S})?(?:планы|встречи|события|дела))`;
const YES_NO_RU = `(?:(?:есть${S}ли|есть)(?:${S}у${S}меня)?${S}${SOMETHING_RU}|у${S}меня${S}есть${S}${SOMETHING_RU}|(?:что-?то|что-?нибудь)${S}(?:есть|запланировано)(?:${S}у${S}меня)?)`;

const SHOW_EN = `${any(['show', 'give', 'send', 'tell', 'display', 'list', 'check', 'open', 'view', 'pull up', 'look at', 'let me see', 'can i see', 'know', 'see', 'find out', 'remind me', 'let me know'])}(?:${S}(?:me|please)){0,2}`;
export const SHOW_EN_BARE = `(?:show|display)(?:${S}me)?`;
const WHICH_EN = `(?:(?:what|which)${S}(?:events|meetings|appointments|plans)${S}(?:do${S}i${S}have|are${S}there|have${S}i${S}got)|am${S}i${S}(?:busy|booked|doing${S}anything)|do${S}i${S}have${S}(?:any${S})?(?:plans|a${S}meeting|meetings))${fillers(['on', 'for', 'planned', 'scheduled'], 2)}`;
const WHAT_EN = `(?:what(?:['’]?s|${S}is|${S}are)|whats)${fillers(['on', 'up', 'happening', 'going on', 'planned', 'scheduled', 'for', 'there', 'my schedule', 'my agenda', 'my calendar', 'my plans', 'in my calendar', 'in my schedule', 'in my agenda', 'on my calendar', 'on my schedule', 'on my agenda', 'on the agenda', 'on my plate', 'on the calendar'], 4)}`;
const HAVE_EN = `what${S}(?:(?:do|will|am)${S})?(?:i|we)${S}(?:have|got|doing)${fillers(['on', 'planned', 'scheduled', 'going on', 'for', 'in my calendar', 'on my calendar', 'on my schedule'], 3)}`;
const ANYTHING_EN = `(?:(?:do${S}i${S}have|have${S}i${S}got|is${S}there|are${S}there|got)${S})?(?:anything|something|any${S}(?:events?|meetings?|plans?|appointments?))${fillers(['on', 'planned', 'scheduled', 'happening', 'going on', 'in my calendar', 'on my calendar', 'on my schedule', 'for'], 3)}`;
const NOUN_EN = `(?:(?:my|the)${S})?(?:schedule|agenda|calendar|events?|plans|meetings|appointments)(?:${S}(?:do${S}i${S}have|i${S}have))?`;

/** The words before the day or period; each alternative is a way of asking "what is on …". */
export const READ_LEAD = `(?:(?:${SHOW_RU}${S})?(?:${WHAT_RU}|${DOING_RU}|${WHICH_RU}|${NOUN_RU}(?:${S}у${S}меня)?)|${SHOW_RU_BARE}|${YES_NO_RU}|(?:${SHOW_EN}${S})?(?:${WHAT_EN}|${HAVE_EN}|${WHICH_EN}|${NOUN_EN})|${SHOW_EN_BARE}|${ANYTHING_EN})`;

/** Words that may follow the day without changing the question: "что завтра у меня в календаре". */
export const READ_TAIL = `${fillers(['у меня', 'в календаре', 'в моем календаре', 'в плане', 'в планах', 'в расписании', 'по календарю', 'по планам', 'по плану', 'по расписанию', 'на календаре', 'есть', 'будет', 'запланировано', 'намечено', 'in my calendar', 'on my calendar', 'in my schedule', 'on my schedule', 'in my agenda', 'for me', 'there'], 3)}(?:[\\s.…]{1,4}(?:напомни|скажи|покажи))?`;

/** "послезавтра что", "tomorrow's schedule": the day first, the question after it. */
export const AFTER_DAY = `(?:(?:у${S}меня${S})?(?:что|че|шо)${fillers(['есть', 'у меня', 'там', 'по плану', 'по планам', 'по календарю', 'будет'], 3)}|${NOUN_RU}|(?:schedule|agenda|events|plans|calendar|meetings)(?:${S}for${S}me)?)`;

// ─── periods ────────────────────────────────────────────────────────────────

type PeriodKey = DayKey | 'week' | 'next_week' | 'month' | 'next_month' | 'weekend';
const PERIOD_PHRASES: { [key in PeriodKey]: readonly string[] } = {
  today: ['сегодня', 'на сегодня', 'седня', 'на седня', 'today', 'for today'],
  tomorrow: ['завтра', 'на завтра', 'tomorrow', 'for tomorrow'],
  day_after_tomorrow: [
    'послезавтра',
    'на послезавтра',
    'после завтра',
    'на после завтра',
    'day after tomorrow',
    'the day after tomorrow',
    'for the day after tomorrow',
  ],
  yesterday: ['вчера', 'yesterday', 'for yesterday'],
  week: [
    'на этой неделе',
    'на неделе',
    'на эту неделю',
    'на текущую неделю',
    'на текущей неделе',
    'this coming week',
    'the coming week',
    'на неделю',
    'на ближайшую неделю',
    'на ближайшие 7 дней',
    'на 7 дней',
    'на ближайшие семь дней',
    'эту неделю',
    'неделю',
    'this week',
    'my week',
    'the week ahead',
    'week ahead',
    'for this week',
    'for the week',
    'the week',
    'next 7 days',
    'the next 7 days',
    'for the next 7 days',
    'over the next 7 days',
  ],
  next_week: [
    'на следующей неделе',
    'на следующую неделю',
    'на след неделе',
    'на след неделю',
    'следующую неделю',
    'next week',
    'for next week',
  ],
  month: [
    'в этом месяце',
    'на этот месяц',
    'на месяц',
    'этот месяц',
    'месяц',
    'this month',
    'my month',
    'for this month',
    'for the month',
  ],
  next_month: [
    'в следующем месяце',
    'на следующий месяц',
    'в след месяце',
    'на след месяц',
    'следующий месяц',
    'next month',
    'for next month',
  ],
  weekend: [
    'на выходных',
    'на выходные',
    'на эти выходные',
    'на этих выходных',
    'в выходные',
    'в эти выходные',
    'выходные',
    'на ближайшие выходные',
    'в ближайшие выходные',
    'this coming weekend',
    'the upcoming weekend',
    'this weekend',
    'for this weekend',
    'for the weekend',
    'on the weekend',
    'over the weekend',
    'the weekend',
    'weekend',
  ],
};

/** "след." is written with and without its dot; the binding table keys carry neither (the normalizer drops dots). */
const dotted = (phrase: string): string => phrase.replace(/(^|\s)след(?=\s|$)/g, String.raw`$1след\.?`);

interface PeriodVocabulary {
  rx: string;
  values: { [key: string]: PeriodKey };
}

function periods(
  keys: readonly PeriodKey[],
  extras: readonly (readonly [readonly string[], PeriodKey])[] = [],
): PeriodVocabulary {
  const entries: (readonly [readonly string[], PeriodKey])[] = [
    ...keys.map((key) => [PERIOD_PHRASES[key], key] as const),
    ...extras,
  ];
  return {
    rx: any(entries.flatMap(([phrases]) => phrases).map(dotted)),
    values: phraseTable(entries),
  };
}

export const RANGE_PERIODS = periods(['week', 'next_week', 'month', 'next_month', 'weekend']);
export const COUNT_PERIODS = periods([
  'today',
  'tomorrow',
  'day_after_tomorrow',
  'yesterday',
  'week',
  'next_week',
  'month',
  'next_month',
  'weekend',
]);
// A picture is drawn per day, calendar week or month; "my month" and "месяц" name the period on their own. A short
// list of its own keeps the pattern, which repeats the vocabulary four times, inside the pattern length limit.
export const IMAGE_PERIODS = periods(
  [],
  [
    [['сегодня', 'на сегодня', 'today', 'for today'], 'today'],
    [['завтра', 'на завтра', 'tomorrow', 'for tomorrow'], 'tomorrow'],
    [['послезавтра', 'на послезавтра', 'day after tomorrow', 'for the day after tomorrow'], 'day_after_tomorrow'],
    [
      [
        'на этой неделе',
        'на неделе',
        'на эту неделю',
        'на неделю',
        'эту неделю',
        'неделю',
        'мою неделю',
        'this week',
        'for this week',
        'my week',
        'week',
      ],
      'week',
    ],
    [['на следующей неделе', 'на следующую неделю', 'следующую неделю', 'next week', 'for next week'], 'next_week'],
    [
      [
        'в этом месяце',
        'на этот месяц',
        'на месяц',
        'этот месяц',
        'месяц',
        'мой месяц',
        'this month',
        'for this month',
        'my month',
        'month',
      ],
      'month',
    ],
    [['в следующем месяце', 'на следующий месяц', 'next month', 'for next month'], 'next_month'],
  ],
);
export const WEEK_PERIODS = periods(['week', 'next_week']);

// A trigger is one token of the message, so multi-word day phrases ("после завтра") are split.
export const TRIGGER_DAYS = [...DAY_WORD_LIST, ...WEEKDAY_FULL].flatMap((phrase) => phrase.split(' '));
export const TRIGGER_READ_LEADS = [
  'что',
  'че',
  'чо',
  'шо',
  'чем',
  'покажи',
  'покажите',
  'скинь',
  'скиньте',
  'пришли',
  'глянь',
  'гляну',
  'посмотри',
  'выведи',
  'дай',
  'открой',
  'расскажи',
  'скажи',
  'подскажи',
  'напиши',
  'отправь',
  'есть',
  'у',
  'события',
  'встречи',
  'дела',
  'планы',
  'план',
  'расписание',
  'календарь',
  'задачи',
  'мероприятия',
  'мои',
  'мое',
  'мой',
  'what',
  'whats',
  'show',
  'give',
  'send',
  'tell',
  'display',
  'list',
  'check',
  'open',
  'pull',
  'let',
  'can',
  'do',
  'have',
  'anything',
  'something',
  'any',
  'is',
  'got',
  'schedule',
  'agenda',
  'calendar',
  'event',
  'events',
  'plans',
  'meetings',
  'appointments',
  'my',
  'the',
  'покажешь',
  'показать',
  'кинь',
  'кидай',
  'сбрось',
  'глянуть',
  'посмотришь',
  'посмотреть',
  'рассказать',
  'скажешь',
  'сказать',
  'подскажешь',
  'подсказать',
  'напомни',
  'проверь',
  'проверить',
  'узнай',
  'узнать',
  'уточни',
  'зачитай',
  'озвучь',
  'вспомни',
  'увидеть',
  'какие',
  'какое',
  'каково',
  'занят',
  'занята',
  'which',
  'am',
  'busy',
  'не',
  'подскажите',
  'скажите',
  'расскажите',
  'посмотрите',
  'проверьте',
  'знать',
  'интересно',
  'хотел',
  'хотела',
  'know',
  'see',
  'find',
  'remind',
  'let',
  'please',
  'пожалуйста',
];
export const TRIGGER_PERIODS = [
  'неделе',
  'неделю',
  'месяц',
  'месяце',
  'выходных',
  'выходные',
  'week',
  'month',
  'weekend',
  'next',
  'this',
];
