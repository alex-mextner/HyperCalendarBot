// Read-only calendar families: what is on a day / a period, what is next, when a named event is, how many events,
// a picture of the calendar, free time and holidays. Every one only reads, so the cost of a wrong reading is a wrong
// list, not a wrong write; the gates are still strict (a whole message of known words, one day or period, one
// event mention) and anything the bindings cannot read unambiguously goes to the AI before a tool runs.
//
// Two shared pieces carry most of the phrasing: READ_LEAD (how a person opens a question about the calendar) and
// DAY_REF / PERIOD vocabulary (which day or period they name). Rules put the day or period in numbered capture
// groups; `groupsFrom` turns all those groups into the one string the typed binding reads.
import { normalize } from './normalizer.ts';
import { DATE_SIGNAL, type FamilyDefinition, phraseTable, SCOPE, TIME_SIGNAL } from './seed-fragments.ts';

// ─── building blocks ────────────────────────────────────────────────────────

/** Word separator that also tolerates a comma: "скажи, что у меня завтра". */
const S = String.raw`[\s,]+`;

/** Literal phrases as one alternation, longest first; a space between words is S. Regex fragments inside a word are kept. */
function any(phrases: readonly string[]): string {
  return `(?:${[...phrases]
    .sort((a, b) => b.length - a.length)
    .map((phrase) => phrase.trim().split(/\s+/).join(S))
    .join('|')})`;
}

/** Up to `max` of these words after something, in any order ("что у меня там есть"). */
const fillers = (phrases: readonly string[], max: number): string => `(?:${S}${any(phrases)}){0,${max}}`;

/**
 * `{{$first}} {{$first+1}} …`: all alternative capture groups of one slot, empty ones dropped by default(""). The
 * one very common misspelling of a weekday ("воскресение") is mended here because bindings read the user's own
 * words, not the typo-repaired text.
 */
function groupsFrom(first: number, last: number, weekdayGroups: readonly number[] = []): string {
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
const DAY_WORDS = phraseTable(DAY_ENTRIES);
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
const WEEKDAY_SHORT = [
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
const DAY_REF_GROUPS = 6;
const DAY_REF = String.raw`(?:(?:(?:на|в|во|on|for)\s+(?:(?:эту|этот|ближайшую|ближайший|this)\s+)?)?(${any([...DAY_WORD_LIST, ...WEEKDAY_FULL])}|${THROUGH})|(?:в|во|на|on)\s+(${any(WEEKDAY_SHORT)})|(?:(?:на|on|for)\s+)?(${NUMERIC_DATE})|(?:(?:на|on|for)\s+)?(\d{1,2})${ORDINAL_SUFFIX}\s+(?:of\s+)?(${MONTH_RU}|${MONTH_EN})(?:\s+(\d{4}))?)`;
/** The day-first shapes ("послезавтра что") only name a day by word or weekday. */
const DAY_REF_LITE_GROUPS = 2;
const DAY_REF_LITE = String.raw`(?:(?:(?:на|в|во|on|for)\s+(?:(?:эту|этот|ближайшую|ближайший|this)\s+)?)?(${any([...DAY_WORD_LIST, ...WEEKDAY_FULL])}|${THROUGH})|(?:в|во|на|on)\s+(${any(WEEKDAY_SHORT)}))`;

// ─── how a question about the calendar opens and trails off ────────────────

const SHOW_RU = `${any(['покажи', 'покажите', 'покажешь', 'не покажешь', 'показать', 'скинь', 'скиньте', 'кинь', 'кидай', 'сбрось', 'пришли', 'глянь', 'глянуть', 'гляну', 'посмотри', 'посмотрите', 'посмотришь', 'посмотреть', 'выведи', 'дай', 'открой', 'расскажи', 'расскажите', 'не расскажешь', 'рассказать', 'скажи', 'скажите', 'скажешь', 'не скажешь', 'сказать', 'подскажи', 'подскажите', 'подскажешь', 'не подскажешь', 'не подскажете', 'подсказать', 'напиши', 'отправь', 'напомни', 'проверь', 'проверьте', 'проверить', 'узнай', 'узнать', 'знать', 'уточни', 'зачитай', 'озвучь', 'вспомни', 'увидеть', 'интересно', 'хотел бы узнать', 'хотела бы узнать', 'хотел бы знать', 'хотела бы знать'])}(?:${S}(?:мне|ка|пожалуйста|плиз)){0,2}`;
// "дай завтра" or "пришли завтра" is not a question: only these verbs may stand directly before a day.
const SHOW_RU_BARE = `${any(['покажи', 'покажите', 'покажешь', 'показать', 'глянь', 'глянуть', 'посмотри', 'посмотреть', 'выведи'])}(?:${S}(?:мне|ка))?`;
const WHAT_RU = `(?:что|че|чо|шо)${fillers(['же', 'там', 'тут', 'вообще', 'еще', 'у меня', 'у нас', 'у меня там', 'по плану', 'по планам', 'по календарю', 'по расписанию', 'по делам', 'по встречам', 'в плане', 'в календаре', 'в расписании', 'на календаре', 'щас', 'сейчас', 'есть', 'будет', 'стоит', 'стоят', 'запланировано', 'намечено', 'планируется', 'записано', 'назначено'], 4)}`;
const DOING_RU = `(?:что${S}я${S}делаю|что${S}мне${S}предстоит|что${S}(?:меня${S})?жд(?:ет|ёт)(?:${S}меня)?|чем${S}(?:я${S})?занят(?:а)?|занят(?:а)?${S}ли${S}я)`;
// "Какие у меня планы / встречи на завтра", "какое у меня расписание".
const WHICH_RU = `(?:какие${S}(?:у${S}меня${S})?(?:планы|встречи|события|дела|мероприятия)${fillers(['есть', 'запланированы', 'намечены', 'назначены', 'будут'], 2)}|(?:какое|каково)${S}(?:у${S}меня${S})?расписание)`;
// "events"/"agenda" are common inside a Russian sentence ("покажи events на завтра").
const NOUN_RU = `(?:(?:мои|мое|мой)${S})?(?:события|встречи|дела|планы|план|расписание|календарь|задачи|мероприятия|events|agenda|schedule)`;
const SOMETHING_RU = `(?:что-?то|что-?нибудь|(?:какие-?то${S})?(?:планы|встречи|события|дела))`;
const YES_NO_RU = `(?:(?:есть${S}ли|есть)(?:${S}у${S}меня)?${S}${SOMETHING_RU}|у${S}меня${S}есть${S}${SOMETHING_RU}|(?:что-?то|что-?нибудь)${S}(?:есть|запланировано)(?:${S}у${S}меня)?)`;

const SHOW_EN = `${any(['show', 'give', 'send', 'tell', 'display', 'list', 'check', 'open', 'view', 'pull up', 'look at', 'let me see', 'can i see', 'know', 'see', 'find out', 'remind me', 'let me know'])}(?:${S}(?:me|please)){0,2}`;
const SHOW_EN_BARE = `(?:show|display)(?:${S}me)?`;
const WHICH_EN = `(?:(?:what|which)${S}(?:events|meetings|appointments|plans)${S}(?:do${S}i${S}have|are${S}there|have${S}i${S}got)|am${S}i${S}(?:busy|booked|doing${S}anything)|do${S}i${S}have${S}(?:any${S})?(?:plans|a${S}meeting|meetings))${fillers(['on', 'for', 'planned', 'scheduled'], 2)}`;
const WHAT_EN = `(?:what(?:['’]?s|${S}is|${S}are)|whats)${fillers(['on', 'up', 'happening', 'going on', 'planned', 'scheduled', 'for', 'there', 'my schedule', 'my agenda', 'my calendar', 'my plans', 'in my calendar', 'in my schedule', 'in my agenda', 'on my calendar', 'on my schedule', 'on my agenda', 'on the agenda', 'on my plate', 'on the calendar'], 4)}`;
const HAVE_EN = `what${S}(?:(?:do|will|am)${S})?(?:i|we)${S}(?:have|got|doing)${fillers(['on', 'planned', 'scheduled', 'going on', 'for', 'in my calendar', 'on my calendar', 'on my schedule'], 3)}`;
const ANYTHING_EN = `(?:(?:do${S}i${S}have|have${S}i${S}got|is${S}there|are${S}there|got)${S})?(?:anything|something|any${S}(?:events?|meetings?|plans?|appointments?))${fillers(['on', 'planned', 'scheduled', 'happening', 'going on', 'in my calendar', 'on my calendar', 'on my schedule', 'for'], 3)}`;
const NOUN_EN = `(?:(?:my|the)${S})?(?:schedule|agenda|calendar|events?|plans|meetings|appointments)(?:${S}(?:do${S}i${S}have|i${S}have))?`;

/** The words before the day or period; each alternative is a way of asking "what is on …". */
const READ_LEAD = `(?:(?:${SHOW_RU}${S})?(?:${WHAT_RU}|${DOING_RU}|${WHICH_RU}|${NOUN_RU}(?:${S}у${S}меня)?)|${SHOW_RU_BARE}|${YES_NO_RU}|(?:${SHOW_EN}${S})?(?:${WHAT_EN}|${HAVE_EN}|${WHICH_EN}|${NOUN_EN})|${SHOW_EN_BARE}|${ANYTHING_EN})`;

/** Words that may follow the day without changing the question: "что завтра у меня в календаре". */
const READ_TAIL = `${fillers(['у меня', 'в календаре', 'в моем календаре', 'в плане', 'в планах', 'в расписании', 'по календарю', 'по планам', 'по плану', 'по расписанию', 'на календаре', 'есть', 'будет', 'запланировано', 'намечено', 'in my calendar', 'on my calendar', 'in my schedule', 'on my schedule', 'in my agenda', 'for me', 'there'], 3)}(?:[\\s.…]{1,4}(?:напомни|скажи|покажи))?`;

/** "послезавтра что", "tomorrow's schedule": the day first, the question after it. */
const AFTER_DAY = `(?:(?:у${S}меня${S})?(?:что|че|шо)${fillers(['есть', 'у меня', 'там', 'по плану', 'по планам', 'по календарю', 'будет'], 3)}|${NOUN_RU}|(?:schedule|agenda|events|plans|calendar|meetings)(?:${S}for${S}me)?)`;

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

const RANGE_PERIODS = periods(['week', 'next_week', 'month', 'next_month', 'weekend']);
const COUNT_PERIODS = periods([
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
const IMAGE_PERIODS = periods(
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
const WEEK_PERIODS = periods(['week', 'next_week']);

// A trigger is one token of the message, so multi-word day phrases ("после завтра") are split.
const TRIGGER_DAYS = [...DAY_WORD_LIST, ...WEEKDAY_FULL].flatMap((phrase) => phrase.split(' '));
const TRIGGER_READ_LEADS = [
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
const TRIGGER_PERIODS = [
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

// ─── calendar.day ───────────────────────────────────────────────────────────

const calendarDay: FamilyDefinition = {
  name: 'basis.calendar.day',
  title: 'Events on one day',
  category: 'calendar',
  risk: 'read',
  pattern: `^(?:${READ_LEAD}${S}${DAY_REF}|(?:(?:${SHOW_RU_BARE}|${SHOW_EN_BARE})${S})?${DAY_REF_LITE}(?:['’]s)?${S}${AFTER_DAY}|(?:что|че)${fillers(['у меня', 'там', 'тут'], 2)}${S}было${S}(вчера))${READ_TAIL}$`,
  triggers: [...TRIGGER_READ_LEADS, ...TRIGGER_DAYS, ...WEEKDAY_SHORT],
  bindings: {
    day: {
      type: 'date',
      // Group 9 is the "было" form, which only ever means yesterday: a past tense with a weekday would point backwards.
      from: groupsFrom(1, DAY_REF_GROUPS + DAY_REF_LITE_GROUPS + 1, [1, DAY_REF_GROUPS + 1]),
      words: DAY_WORDS,
      // A date without a year that has already gone by this year is read as next year's.
      future: true,
      after_midnight: 'both',
    },
  },
  steps: [{ call: 'get_events', input: { start_date: '{{bind.day}}', end_date: '{{bind.day}}', scope: SCOPE } }],
  strings: { ru: {}, en: {} },
  examples: [
    'что у меня сегодня',
    'что у нас завтра',
    'покажи послезавтра',
    'что в пятницу',
    'расписание на вторник',
    'чё у меня в субботу',
    'глянь что на завтра в календаре',
    'скажи, что у меня запланировано на завтра',
    'послезавтра что',
    'планы на 5 октября',
    'дела на воскресенье',
    'что меня ждет завтра',
    'какие у меня планы на завтра',
    'напомни что у меня завтра',
    'что в эту пятницу',
    'что было вчера',
    'расписание на завтрашний день',
    'check my calendar for tomorrow',
    'am I busy tomorrow',
    "what's my schedule tomorrow",
    'что у меня через 3 дня',
    "what's tomorrow",
    "what's on friday",
    'what do I have on Thursday',
    'anything tomorrow',
    'show my schedule for Friday',
    'agenda for the day after tomorrow',
    'show events on 2026-10-05',
    'events on 05.10.2026',
    "tomorrow's schedule",
  ],
  negatives: [
    'что делать завтра',
    'что у меня в кошельке',
    'покажи завтра погоду',
    'не показывай что у меня сегодня',
    'что у меня завтра в 15:00',
    'что у меня в следующую пятницу',
    'что у меня завтра и когда я свободен в понедельник',
    'я не хочу смотреть календарь на пятницу',
    'дай завтра',
    'what should I do tomorrow',
    "don't show me tomorrow's events",
    'что значит команда «покажи завтра»',
    'что было в пятницу',
    'напомни завтра позвонить маме',
    "what's the weather tomorrow",
  ],
  invalidInputs: ['что у меня 31 февраля', 'покажи события на 32 октября', 'show events on February 30'],
  notes:
    'The day is a word, a weekday (the next such day, today\'s own weekday is refused as ambiguous), an absolute date or "через N дней". From 00:00 to 04:00 local, today and tomorrow may still count from the day that has just ended, so both days are read and each is answered under its own weekday and date. A message that also names a time, a part of the day or a second request is not matched.',
};

// ─── calendar.period ────────────────────────────────────────────────────────

const calendarPeriod: FamilyDefinition = {
  name: 'basis.calendar.period',
  title: 'Events in a week, month or weekend',
  category: 'calendar',
  risk: 'read',
  pattern: `^(?:${READ_LEAD}${S}(${RANGE_PERIODS.rx})|(?:(?:${SHOW_RU_BARE}|${SHOW_EN_BARE})${S})?(${RANGE_PERIODS.rx})(?:['’]s)?${S}(?:(?:что|че|шо)${fillers(['есть', 'у меня', 'там', 'по плану', 'по планам', 'по календарю', 'будет'], 3)}|${NOUN_RU}|(?:schedule|agenda|events|plans|calendar|meetings))|(this${S}weekend))${READ_TAIL}$`,
  triggers: [
    ...TRIGGER_READ_LEADS,
    ...TRIGGER_PERIODS,
    'на',
    'в',
    'эту',
    'этой',
    'следующей',
    'следующую',
    'следующий',
    'следующем',
  ],
  bindings: {
    p: {
      type: 'period',
      from: '{{$1|default("")}}{{$2|default("")}}{{$3|default("")}}',
      values: { ...RANGE_PERIODS.values, 'this weekend': 'weekend' },
    },
  },
  steps: [{ call: 'get_events', input: { start_date: '{{bind.p.start}}', end_date: '{{bind.p.end}}', scope: SCOPE } }],
  strings: { ru: {}, en: {} },
  examples: [
    'что у меня на этой неделе',
    'расписание на следующую неделю',
    'мои события в этом месяце',
    'что у меня в следующем месяце',
    'что у меня на выходных',
    'покажи неделю',
    'чё на неделе',
    'на следующий месяц что',
    'планы на выходные',
    'show this week',
    'events next month',
    'покажи месяц',
    'show my week',
    'что на ближайшие выходные',
    "what's on this week",
    'next week schedule',
    'this weekend',
  ],
  negatives: [
    'что у меня на прошлой неделе',
    'что у меня на неделе после отпуска',
    'что у меня в этом году',
    'что на неделе и сколько событий в месяце',
    'проанализируй мою загрузку на неделе',
    'оптимизируй мою неделю',
    'расскажи про мои выходные',
    'next week',
  ],
  notes:
    'This week is today and the six days after it, so a Sunday-evening plan is not a list of past days; next week is Monday to Sunday; the weekend is the Saturday and Sunday of the current calendar week.',
};

// ─── calendar.upcoming and calendar.next ────────────────────────────────────

const EVENT_NOUN_PLURAL_RU = 'событи[яй]|встреч[иа]?|дел|мероприяти[яй]|планов|планы';

const calendarUpcoming: FamilyDefinition = {
  name: 'basis.calendar.upcoming',
  title: 'Next upcoming events',
  category: 'calendar',
  risk: 'read',
  pattern: String.raw`^(?:(?:${SHOW_RU}${S})?(?:какие${S}(?:у${S}меня${S})?)?(?:мои${S})?(?:(\d{1,2})${S})?(?:ближайшие|ближайших|следующие|предстоящие)(?:${S}(\d{1,2}))?${S}(?:${EVENT_NOUN_PLURAL_RU})|что(?:${S}(?:у${S}меня|там|тут)){0,2}${S}(?:дальше|ближайшее|следующее|скоро|предстоит|впереди)(?:${S}по${S}(?:календарю|плану|расписанию))?|(?:(?:show|list|give)${S}(?:me${S})?)?(?:my${S})?(?:upcoming|next|nearest|coming)(?:${S}(\d{1,2}))?${S}(?:events|meetings|appointments|plans)|what(?:['’]?s|${S}is)${S}(?:up${S}next|next|coming${S}up|coming|upcoming)(?:${S}(?:on${S}my${S}(?:calendar|schedule|agenda)|for${S}me))?|what${S}do${S}i${S}have${S}(?:next|coming${S}up|upcoming))$`,
  triggers: [
    'дальше',
    'ближайшие',
    'ближайших',
    'следующие',
    'предстоящие',
    'что',
    'upcoming',
    'next',
    'nearest',
    'coming',
    'what',
    'show',
    'list',
    'give',
    'мои',
    'покажи',
    'скажи',
  ],
  bindings: {
    limit: {
      type: 'integer',
      from: '{{$1|default("")}}{{$2|default("")}}{{$3|default("")}}',
      min: 1,
      max: 20,
      optional: true,
      default: 5,
    },
  },
  steps: [{ call: 'get_upcoming', input: { limit: '{{bind.limit}}', scope: SCOPE } }],
  strings: { ru: {}, en: {} },
  examples: [
    'что дальше',
    'что у меня дальше',
    'что там ближайшее по календарю',
    'ближайшие события',
    'мои ближайшие 3 события',
    'покажи 3 ближайших события',
    'ближайшие 2 встречи',
    'upcoming events',
    'next 2 events',
    "what's next",
    'what do I have next',
  ],
  negatives: ['ближайшие 500 событий', 'что дальше делать с проектом', 'расскажи что дальше'],
  invalidInputs: ['ближайшие 0 события'],
};

const calendarNext: FamilyDefinition = {
  name: 'basis.calendar.next',
  title: 'The next single event',
  category: 'calendar',
  risk: 'read',
  pattern: `^(?:(?:${SHOW_RU}${S})?(?:(?:какое|какая|какой)${S}(?:у${S}меня${S})?|когда${S}(?:(?:у${S}меня|моя|мое|мой)${S})?)?(?:мое${S}|моя${S})?(?:следующ(?:ее|ую|ая)|ближайш(?:ее|ую|ая))${S}(?:событие|встреч[ау]|дело|мероприятие)(?:${S}(?:у${S}меня|в${S}календаре|по${S}календарю))?|(?:(?:show|tell|give)${S}(?:me${S})?|what(?:['’]?s|${S}is)${S}|when${S}is${S})?(?:my${S})?(?:next|nearest|upcoming)${S}(?:event|meeting|appointment))$`,
  triggers: [
    'следующее',
    'следующую',
    'следующая',
    'ближайшее',
    'ближайшую',
    'ближайшая',
    'какое',
    'какая',
    'когда',
    'покажи',
    'скажи',
    'next',
    'nearest',
    'upcoming',
    'show',
    'tell',
    'give',
    'what',
    'when',
    'my',
  ],
  steps: [{ call: 'get_upcoming', input: { limit: 1, scope: SCOPE } }],
  strings: { ru: {}, en: {} },
  examples: [
    'какое у меня следующее событие',
    'следующая встреча',
    'когда моя следующая встреча',
    'покажи ближайшее событие',
    'next meeting',
    'when is my next meeting',
    "what's my next event",
  ],
  negatives: ['следующее событие после отпуска', 'какая следующая остановка'],
  notes: 'One event: the singular "следующее событие" is answered with the single nearest one, not a list of five.',
};

// ─── calendar.search ────────────────────────────────────────────────────────

const SEARCH_VERB = any(['найди', 'поищи', 'ищи', 'найти', 'search for', 'search', 'find', 'look for']);
// "найди в календаре йогу" / "find dentist in my calendar": one to three words, searched by their most distinctive one.
const IN_CALENDAR = `(?:в${S}(?:моем${S})?(?:календаре|событиях|расписании)|in${S}my${S}(?:calendar|events|schedule))`;
const SEARCH_WORDS = String.raw`[^\s«»"@#]{2,40}(?:\s+[^\s«»"@#]{1,40}){0,2}`;
// A bare "найди X" is only safe for one word: the title search below finds nothing for "найди кафе" and the message goes to the AI.
const calendarSearch: FamilyDefinition = {
  name: 'basis.calendar.search',
  title: 'Search events by title',
  category: 'calendar',
  risk: 'read',
  pattern: String.raw`^(?:${any(['найди', 'поищи', 'покажи', 'find', 'search for', 'search', 'show'])}${S}(?:(?:мои|все|my|all)${S})?(?:событи[яе]|встреч[иуа]|созвон[а-я]*|events?|meetings?|calls?)${S}(?:про|о|об|по|с|со|about|with|called|named|matching|for)${S}(.{1,120})|${SEARCH_VERB}${S}(?!(?:событ|встреч|мероприят|event|meeting|appointment)[а-яa-z]*$)([^\s«»"@#]{3,40})|${SEARCH_VERB}${S}${IN_CALENDAR}${S}(${SEARCH_WORDS})|${SEARCH_VERB}${S}(${SEARCH_WORDS})${S}${IN_CALENDAR}|(?:search|look)${S}(?:through${S})?(?:my${S})?(?:calendar|schedule|events)${S}for${S}(${SEARCH_WORDS}))$`,
  triggers: ['найди', 'поищи', 'покажи', 'ищи', 'найти', 'find', 'search', 'show', 'look'],
  bindings: {
    q: {
      type: 'eventref',
      from: '{{$1|default("")}}{{$2|default("")}}{{$3|default("")}}{{$4|default("")}}{{$5|default("")}}',
      stem: true,
    },
  },
  steps: [
    { when: "bind.q.kind == 'id'", abstain: true },
    { call: 'search_events', input: { query: '{{bind.q.query}}', scope: SCOPE }, as: 'found' },
    { when: 'count(found) == 0', abstain: true },
  ],
  strings: { ru: {}, en: {} },
  examples: [
    'найди встречи про стендап',
    'поищи события по проекту',
    'найди созвоны с клиентом',
    'найди ревью',
    'поищи тренировку',
    'find events about standup',
    'search for meetings called retro',
    'search standup',
    'покажи события о релизе',
    'найди в календаре йогу',
    'find dentist in my calendar',
    'search my calendar for dentist',
  ],
  negatives: [
    'найди свободное время',
    'не ищи события про стендап',
    'найди события',
    'найди кафе рядом с местом где ужин с родителями',
    'find contact Anna',
    'найди контакт Иван',
  ],
  notes:
    'A title mention is reduced to its most distinctive word (inflection cut), so "найди события про йогу" finds "Йога". When nothing matches, the rule steps aside: the AI knows more than a title search.',
};

// ─── calendar.when ──────────────────────────────────────────────────────────

const WHEN_RU = `(?:(?:скажи|подскажи|не${S}подскажешь)${S})?(?:когда|во${S}сколько|в${S}какое${S}время|на${S}какое${S}время|в${S}котором${S}часу|в${S}какой${S}день|какого${S}числа|какой${S}день)${fillers(['у меня', 'у нас', 'моя', 'мое', 'мой', 'начинается', 'начало', 'будет', 'состоится', 'проходит', 'назначена', 'назначено', 'назначен', 'запланирована', 'запланировано', 'запланирован'], 2)}`;
const WHEN_EN = `(?:(?:tell${S}me|remind${S}me)${S})?(?:when(?:['’]s|${S}is|${S}does|${S}will|${S}do${S}(?:i|we)${S}have)|what${S}(?:time|day)${S}(?:is|does|will))(?:${S}(?:my|the|our))?`;
// Words that open a different question ("когда я свободен", "when is the next holiday", "what time is it"): not an event title.
const NOT_AN_EVENT = String.raw`(?!(?:(?:моя|мое|мой|my|our|the)\s+)?(?:я|мы|вы|ты|лучше|можно|удобно|нужно|надо|стоит|пора|все|всё|следующ[а-я]*|ближайш[а-я]*|свободн[а-я]*|окн[а-я]*|i|we|you|it|now|there|next|upcoming|nearest|should|can|do|am|time|free)(?:\s|,|$))`;
// A day or a clock time in the mention makes it a different question ("когда стендап завтра"): the AI answers it.
// "у Пушкина", "для отпуска": a title search cannot tell whose or what for, so such a mention goes to the AI.
const NO_DAY_OR_TIME = `(?!${DATE_SIGNAL})(?!${TIME_SIGNAL})(?!.*(?:^|[\\s,])(?:у|для|от|из|без)(?:[\\s,]|$))`;

const calendarWhen: FamilyDefinition = {
  name: 'basis.calendar.when',
  title: 'When or at what time a named event is',
  category: 'calendar',
  risk: 'read',
  pattern: `^(?:${WHEN_RU}|${WHEN_EN})${S}${NOT_AN_EVENT}${NO_DAY_OR_TIME}(.{2,100}?)(?:${S}(?:start|starts|begin|begins|happening|scheduled))?$`,
  triggers: ['когда', 'во', 'в', 'на', 'скажи', 'подскажи', 'when', 'what', 'tell', 'remind'],
  bindings: { ref: { type: 'eventref', from: '{{$1}}', stem: true } },
  steps: [
    { when: "bind.ref.kind == 'id'", abstain: true },
    { call: 'search_events', input: { query: '{{bind.ref.query}}', scope: SCOPE }, as: 'found' },
    // The title found nothing: the AI may know the event under another name, so no "nothing found" from here.
    { when: 'count(found) == 0', abstain: true },
    {
      when: 'count(found) == 1 && found[0].all_day == false',
      respond: '{{t.one}}',
    },
    { when: 'count(found) == 1 && found[0].all_day == true', respond: '{{t.one_all_day}}' },
  ],
  strings: {
    ru: {
      one: '«{{tool_outputs.found[0].title}}» — {{tool_outputs.found[0].date|human_day}} в {{tool_outputs.found[0].time}}.',
      one_all_day: '«{{tool_outputs.found[0].title}}» — {{tool_outputs.found[0].date|human_day}}, на весь день.',
    },
    en: {
      one: '“{{tool_outputs.found[0].title}}” — {{tool_outputs.found[0].date|human_day}} at {{tool_outputs.found[0].time}}.',
      one_all_day: '“{{tool_outputs.found[0].title}}” — {{tool_outputs.found[0].date|human_day}}, all day.',
    },
  },
  examples: [
    'когда стендап',
    'во сколько стоматолог',
    'когда у меня йога',
    'когда у меня встреча с Иваном',
    'во сколько созвон с клиентом',
    'когда день рождения Ани',
    'when is my dentist appointment',
    'when is sprint planning',
    'what time is the client call',
  ],
  negatives: [
    'когда я свободен',
    'когда лучше поставить спортзал на этой неделе',
    'когда стендап завтра',
    'когда следующий праздник',
    'what time is it',
    'when is the next holiday',
    'when am I free on Friday',
    'скажи когда лучше созвониться',
  ],
  notes:
    'The mention is reduced to its most distinctive word and searched among the user\'s events. One match is answered in words with its day and time; several matches are listed; none hands the message to the AI, because "nothing found" would be a claim this title search cannot back.',
};

// ─── calendar.count ─────────────────────────────────────────────────────────

const COUNT_NOUN_RU = '(?:встреч|событий|дел|планов|мероприятий|задач)';
const COUNT_LEAD_RU = `(?:(?:сколько|количество|число)(?:${S}всего)?(?:${S}(?:у${S}меня|у${S}нас))?)`;

const calendarCount: FamilyDefinition = {
  name: 'basis.calendar.count',
  title: 'How many events in a period',
  category: 'calendar',
  risk: 'read',
  pattern: `^(?:(?:${COUNT_LEAD_RU}${S}${COUNT_NOUN_RU}${fillers(['у меня', 'запланировано', 'намечено', 'будет', 'есть'], 2)}|(?:how${S}many|(?:number|count)${S}of)${S}(?:meetings|events|appointments|plans)(?:${S}do${S}i${S}have)?(?:${S}(?:on|for|in))?)${S}(${COUNT_PERIODS.rx})|${COUNT_LEAD_RU}${S}(${COUNT_PERIODS.rx})${S}${COUNT_NOUN_RU}${fillers(['у меня', 'запланировано', 'будет'], 2)})${fillers(['у меня', 'в календаре', 'запланировано', 'in my calendar'], 2)}$`,
  triggers: ['сколько', 'количество', 'число', 'how', 'many', 'number', 'count'],
  bindings: { p: { type: 'period', from: '{{$1|default("")}}{{$2|default("")}}', values: COUNT_PERIODS.values } },
  steps: [
    {
      call: 'get_events',
      input: { start_date: '{{bind.p.start}}', end_date: '{{bind.p.end}}', scope: SCOPE },
      as: 'evs',
    },
    { when: "evs.length == 0 && bind.p.kind == 'day'", respond: '{{t.none_day}}' },
    { when: 'evs.length == 0', respond: '{{t.none_range}}' },
    { when: "bind.p.kind == 'day'", respond: '{{t.count_day}}' },
    { respond: '{{t.count_range}}' },
  ],
  strings: {
    ru: {
      count_day:
        'В {{env.scope|eq("group","календаре группы","твоём календаре")}} на {{bind.p.start|human_day}} событий: {{tool_outputs.evs.length}}.',
      count_range:
        'В {{env.scope|eq("group","календаре группы","твоём календаре")}} за период {{bind.p.start|human_day}} — {{bind.p.end|human_day}} событий: {{tool_outputs.evs.length}}.',
      none_day:
        'В {{env.scope|eq("group","календаре группы","твоём календаре")}} на {{bind.p.start|human_day}} событий: 0 — в этот день ничего не начинается.',
      none_range:
        'В {{env.scope|eq("group","календаре группы","твоём календаре")}} за период {{bind.p.start|human_day}} — {{bind.p.end|human_day}} событий: 0 — в эти дни ничего не начинается.',
    },
    en: {
      count_day:
        'In {{env.scope|eq("group","the group calendar","your calendar")}} for {{bind.p.start|human_day}}: {{tool_outputs.evs.length}} events.',
      count_range:
        'In {{env.scope|eq("group","the group calendar","your calendar")}} from {{bind.p.start|human_day}} to {{bind.p.end|human_day}}: {{tool_outputs.evs.length}} events.',
      none_day:
        'In {{env.scope|eq("group","the group calendar","your calendar")}} for {{bind.p.start|human_day}}: 0 events — nothing starts that day.',
      none_range:
        'In {{env.scope|eq("group","the group calendar","your calendar")}} from {{bind.p.start|human_day}} to {{bind.p.end|human_day}}: 0 events — nothing starts on those days.',
    },
  },
  examples: [
    'сколько у меня встреч сегодня',
    'сколько сегодня встреч',
    'количество событий на неделе',
    'how many events do I have tomorrow',
    'сколько событий на неделе',
    'сколько дел завтра',
    'сколько встреч на выходных',
    'how many meetings do i have this week',
    'how many events this month',
    'how many events next week',
  ],
  negatives: ['сколько стоит встреча', 'сколько встреч было вчера', 'сколько встреч у меня в пятницу'],
  notes:
    'The count is the number of events whose start falls in the period. Zero is answered with the checked day or range and the calendar, never with a bare "nothing".',
};

// ─── calendar.image ─────────────────────────────────────────────────────────

const IMAGE_VERB_RU = `(?:${any(['покажи', 'пришли', 'отправь', 'скинь', 'сделай', 'дай', 'выведи'])}(?:${S}мне)?)`;
const IMAGE_NOUN_RU = `(?:(?:мой|мое|мою|мои)${S})?(?:календарь|расписание|план|планы|события|дела)`;
const IMAGE_WORD_RU = any([
  'картинкой',
  'изображением',
  'в фото',
  'скриншотом',
  'в виде картинки',
  'в виде изображения',
  'в виде фото',
]);
const IMAGE_NOUN_PIC_RU = `(?:картинку|картинка|изображение|скриншот)(?:${S}(?:календаря|расписания|плана|моего${S}календаря))?`;
const IMAGE_VERB_EN = `(?:${any(['show', 'send', 'give', 'draw', 'render', 'make', 'generate'])}(?:${S}me)?)`;
const IMAGE_NOUN_EN = `(?:(?:my|the)${S})?(?:calendar|schedule|agenda|plans|events)`;
const IMAGE_WORD_EN = `(?:(?:as|in)${S}an?${S}(?:image|picture|photo|png)|(?:image|picture|photo|png)(?:${S}of)?)`;

const calendarImage: FamilyDefinition = {
  name: 'basis.calendar.image',
  title: 'Calendar as an image',
  category: 'calendar',
  risk: 'read',
  pattern: `^(?:(?:(?:${IMAGE_VERB_RU}${S})?${IMAGE_NOUN_RU}${S}${IMAGE_WORD_RU}|нарисуй(?:${S}мне)?${S}${IMAGE_NOUN_RU}|(?:${IMAGE_VERB_RU}${S})?${IMAGE_NOUN_PIC_RU}|(?:${IMAGE_VERB_EN}${S})?${IMAGE_NOUN_EN}${S}${IMAGE_WORD_EN})${S}(${IMAGE_PERIODS.rx})|(?:(?:${IMAGE_VERB_RU}${S})?(?:${IMAGE_NOUN_RU}${S})?(${IMAGE_PERIODS.rx})${S}${IMAGE_WORD_RU}|(?:${IMAGE_VERB_EN}${S})?(?:(?:my|the)${S})?(?:${IMAGE_NOUN_EN}${S})?(${IMAGE_PERIODS.rx})${S}${IMAGE_WORD_EN}|${IMAGE_VERB_EN}${S}${IMAGE_NOUN_EN}${S}(${IMAGE_PERIODS.rx})${S}${IMAGE_WORD_EN}))$`,
  triggers: [
    'покажи',
    'пришли',
    'отправь',
    'скинь',
    'сделай',
    'дай',
    'выведи',
    'нарисуй',
    'картинку',
    'картинка',
    'изображение',
    'фото',
    'скриншот',
    'картинкой',
    'изображением',
    'скриншотом',
    'виде',
    'картинки',
    'календарь',
    'расписание',
    'план',
    'планы',
    'события',
    'дела',
    'мой',
    'на',
    'неделю',
    'месяц',
    'сегодня',
    'завтра',
    'послезавтра',
    'calendar',
    'schedule',
    'agenda',
    'plans',
    'events',
    'image',
    'picture',
    'photo',
    'png',
    'my',
    'week',
    'month',
    'today',
    'tomorrow',
    'next',
    'this',
    'for',
    'show',
    'send',
    'give',
    'draw',
    'render',
    'make',
    'generate',
  ],
  bindings: {
    p: {
      type: 'period',
      from: '{{$1|default("")}}{{$2|default("")}}{{$3|default("")}}{{$4|default("")}}',
      values: IMAGE_PERIODS.values,
    },
  },
  steps: [
    { when: "bind.p.kind == 'day'", call: 'render_day_image', input: { date: '{{bind.p.start}}', scope: SCOPE } },
    {
      when: "bind.p.kind == 'week'",
      call: 'render_week_image',
      input: { week_start: '{{bind.p.calendar_week_start}}', scope: SCOPE },
    },
    { when: "bind.p.kind == 'month'", call: 'render_month_image', input: { month: '{{bind.p.month}}', scope: SCOPE } },
  ],
  strings: { ru: {}, en: {} },
  examples: [
    'покажи календарь картинкой на неделю',
    'пришли план на следующий месяц картинкой',
    'пришли расписание картинкой на завтра',
    'отправь календарь изображением на месяц',
    'нарисуй расписание на завтра',
    'картинка на сегодня',
    'покажи месяц картинкой',
    'show calendar as an image for this month',
    'send me schedule as a picture next week',
    'show my month as an image',
    'календарь картинкой на неделю',
    'на неделю картинкой',
    'draw my schedule for tomorrow as an image',
  ],
  negatives: ['покажи календарь картинкой', 'покажи календарь на неделю', 'нарисуй кота'],
  notes:
    'A week picture is always a Monday-to-Sunday calendar week; asked on a Saturday or Sunday, this week means the coming one. The reply names the dates shown.',
};

// ─── slots ──────────────────────────────────────────────────────────────────

// "Свободен ли я завтра" / "am I free on Friday" ask for the free windows of that day, so they share the day rule.
const FREE_LEAD_RU = `(?:(?:${SHOW_RU}|найди|поищи|есть${S}ли|есть)${S})?(?:(?:мои|мое|у${S}меня)${S})?${any([
  'когда я свободен',
  'когда я свободна',
  'когда свободен',
  'когда свободна',
  'когда у меня свободно',
  'когда у меня окно',
  'когда у меня окна',
  'когда у меня есть окно',
  'когда у меня есть свободное время',
  'когда у меня свободное время',
  'когда есть окно',
  'когда есть окна',
  'когда есть свободное время',
  'свободные окна',
  'свободные слоты',
  'свободное время',
  'свободные часы',
  'свободен ли я',
  'свободна ли я',
  'какие окна',
  'какие у меня окна',
  'какие свободные окна',
  'какие у меня свободные окна',
  'какое свободное время',
  'какое у меня свободное время',
  'мои окна',
  'свободное окно',
  'свободный слот',
  'окошко',
  'окно',
])}`;
const FREE_LEAD_EN = any([
  'when am i free',
  'when am i available',
  'when am i not busy',
  'when do i have free time',
  'when do i have time',
  'show my free slots',
  'show my free time',
  'show free slots',
  'show free time',
  'my free slots',
  'my free time',
  'my free windows',
  'free slots',
  'free windows',
  'free time',
  'do i have any free time',
  'do i have free time',
  'do i have free slots',
  'is there any free time',
  'any free time',
  'any free slots',
  'am i available',
  'am i free',
  'what are my free slots',
  'what free slots do i have',
  'what is my availability',
  'whats my availability',
  'my availability',
  'availability',
  'free slot',
  'when do i have a free slot',
  'when is a free slot',
]);
const FREE_TAIL = fillers(['у меня', 'в календаре', 'in my calendar', 'for me'], 2);
const FREE_TRIGGERS = [
  'когда',
  'свободен',
  'свободна',
  'свободные',
  'свободное',
  'окно',
  'окна',
  'какие',
  'какое',
  'free',
  'when',
  'what',
  'am',
  'my',
  'show',
  'any',
  'do',
  'is',
  'availability',
  'мои',
  'покажи',
  'скажи',
  'подскажи',
  'найди',
  'есть',
  'у',
  'я',
];

const slotsDay: FamilyDefinition = {
  name: 'basis.slots.day',
  title: 'Free time on one day',
  category: 'slots',
  risk: 'read',
  pattern: `^(?:${FREE_LEAD_RU}|${FREE_LEAD_EN})${S}${DAY_REF}${FREE_TAIL}$`,
  triggers: FREE_TRIGGERS,
  bindings: {
    day: { type: 'date', from: groupsFrom(1, DAY_REF_GROUPS, [1]), words: DAY_WORDS, future: true },
  },
  steps: [{ call: 'get_free_slots', input: { date: '{{bind.day}}', scope: SCOPE } }],
  strings: { ru: {}, en: {} },
  examples: [
    'когда я свободен завтра',
    'когда свободен сегодня',
    'свободные окна на послезавтра',
    'свободные окна в четверг',
    'когда у меня окно послезавтра',
    'подскажи, когда я свободен 5 октября',
    'свободен ли я на пятницу',
    'when am i free today',
    'when am I free on Friday',
    'free slots tomorrow',
    'am i free on friday',
    'какие у меня окна завтра',
    'есть ли свободные окна в пятницу',
    'найди окно в пятницу',
    'availability on friday',
    'free slots on 05.10.2026',
  ],
  negatives: [
    'когда я свободен',
    'когда я свободен на неделе после отпуска',
    'не показывай когда я свободен',
    'покажи завтра и ещё когда я свободен в пятницу',
    'я свободен в 15:00',
    'я свободен завтра',
    'когда лучше поставить спортзал на этой неделе',
  ],
  invalidInputs: ['когда я свободен 31 февраля'],
  notes: 'The day is required: a bare "когда я свободен" is a question with a missing slot and goes to the AI.',
};

function weekSection(index: number): string {
  return `{{bind.p.days[${index}]|human_day}}:\n{{tool_outputs.d${index}_text}}`;
}

const slotsWeek: FamilyDefinition = {
  name: 'basis.slots.week',
  title: 'Free time on every day of a week',
  category: 'slots',
  risk: 'read',
  pattern: `^(?:${FREE_LEAD_RU}|${FREE_LEAD_EN})${S}(${WEEK_PERIODS.rx})${FREE_TAIL}$`,
  triggers: FREE_TRIGGERS,
  bindings: { p: { type: 'period', from: '{{$1}}', values: WEEK_PERIODS.values } },
  steps: [
    ...[0, 1, 2, 3, 4, 5, 6].map((index) => ({
      call: 'get_free_slots',
      input: { date: `{{bind.p.days[${index}]}}`, scope: SCOPE },
      as: `d${index}`,
    })),
    { respond: '{{t.week}}' },
  ],
  strings: {
    ru: { week: [0, 1, 2, 3, 4, 5, 6].map(weekSection).join('\n\n') },
    en: { week: [0, 1, 2, 3, 4, 5, 6].map(weekSection).join('\n\n') },
  },
  examples: [
    'когда я свободен на этой неделе',
    'свободные окна на следующую неделю',
    'свободное время на неделе',
    'какие у меня окна на неделе',
    'when am i free this week',
    'free slots next week',
  ],
  negatives: ['свободные окна на неделе после отпуска'],
  notes:
    'Seven explicit day queries, so every day is answered: this week is today and the six days after it, next week is Monday to Sunday.',
};

const FREE_CHECK_RU = any([
  'свободен ли я',
  'свободна ли я',
  'я свободен',
  'я свободна',
  'свободен',
  'свободна',
  'есть окно',
  'есть окошко',
  'есть свободное окно',
  'есть ли окно',
  'есть ли свободное время',
  'будет окно',
  'свободно ли',
  'свободно',
]);
const FREE_CHECK_EN = any([
  'am i free',
  'am i available',
  'is there a free slot',
  'is there a slot',
  'is there a window',
  'is there a free window',
  'do i have a free slot',
  'are there any free slots',
]);
// A clock time: hours and minutes, with or without an am/pm or day-part word. A bare 1-12 hour is still captured and refused by the binding.
const CLOCK = String.raw`(\d{1,2}(?:[:.]\d{2})?(?:\s?(?:am|pm|утра|дня|вечера|ночи|час(?:а|ов)?))?|полдень|полночь|noon|midnight)`;
const AT_CLOCK = String.raw`(?:в|на|к|at|around)\s+${CLOCK}`;

const slotsCheckTime: FamilyDefinition = {
  name: 'basis.slots.check_time',
  title: 'Am I free at a given time',
  category: 'slots',
  risk: 'read',
  pattern: `^(?:${FREE_CHECK_RU}|${FREE_CHECK_EN})${S}(?:${DAY_REF}${S}${AT_CLOCK}|${AT_CLOCK}${S}${DAY_REF})${FREE_TAIL}$`,
  triggers: ['свободен', 'свободна', 'свободно', 'есть', 'будет', 'я', 'am', 'is', 'are', 'do'],
  bindings: {
    d: {
      type: 'date',
      from: `${groupsFrom(1, DAY_REF_GROUPS, [1])} ${groupsFrom(DAY_REF_GROUPS + 3, DAY_REF_GROUPS * 2 + 2, [DAY_REF_GROUPS + 3])}`,
      words: DAY_WORDS,
      future: true,
    },
    at: { type: 'time', from: `{{$${DAY_REF_GROUPS + 1}|default("")}}{{$${DAY_REF_GROUPS + 2}|default("")}}` },
    start: { type: 'datetime', date: 'd', time: 'at' },
    until: { type: 'datetime', date: 'd', time: 'at', plus_minutes: 60 },
  },
  steps: [
    { call: 'get_free_slots', input: { date: '{{bind.d}}', scope: SCOPE }, as: 'free' },
    { when: 'fits(free, bind.start, bind.until)', respond: '{{t.free}}' },
    { respond: '{{t.busy}}' },
  ],
  strings: {
    ru: {
      free: 'Да, {{bind.start|human_when}} свободно: в {{env.scope|eq("group","календаре группы","твоём календаре")}} на этот час ничего не запланировано.',
      busy: 'Нет, {{bind.start|human_when}} занято: в этот час уже что-то начинается или идёт. Свободные окна на этот день:\n{{tool_outputs.free_text}}',
    },
    en: {
      free: 'Yes, {{bind.start|human_when}} is free: nothing is scheduled in {{env.scope|eq("group","the group calendar","your calendar")}} for that hour.',
      busy: 'No, {{bind.start|human_when}} is taken: something already starts or runs in that hour. Free windows that day:\n{{tool_outputs.free_text}}',
    },
  },
  examples: [
    'свободен ли я завтра в 15:00',
    'я свободен 2026-10-05 в 10:30',
    'свободен ли я сегодня в 7 вечера',
    'есть окно в четверг в 20:00',
    'свободно ли завтра в 15:00',
    'свободен в пятницу в 14:30',
    'свободен ли я в 15:00 завтра',
    'am i free tomorrow at 3pm',
    'am I free on Saturday at 3pm',
  ],
  negatives: ['свободен ли я завтра', 'я свободен в 15:00', 'не свободен ли я завтра в 15:00'],
  invalidInputs: ['свободен ли я завтра в 3', 'am i free tomorrow at 25:00'],
  notes:
    'The checked hour is [start, start + 60 minutes). A bare hour from 1 to 12 without am/pm or a day-part word is ambiguous and is never guessed. The day is required.',
};

// ─── holidays ───────────────────────────────────────────────────────────────

const MANY_HOLIDAYS = [
  'ближайшие праздники',
  'предстоящие праздники',
  'какие скоро праздники',
  'какие ближайшие праздники',
  'какие праздники скоро',
  'какие праздники впереди',
  'какие предстоящие праздники',
  'покажи ближайшие праздники',
  'покажи праздники',
  'upcoming holidays',
  'next holidays',
  'upcoming public holidays',
  'show upcoming holidays',
  'show holidays',
  'what holidays are coming up',
  'what holidays are upcoming',
  'what are the upcoming holidays',
  'когда ближайшие праздники',
  'какие праздники в ближайшее время',
  'какие скоро будут праздники',
  'покажи предстоящие праздники',
  'скажи ближайшие праздники',
  'show me upcoming holidays',
  'any upcoming holidays',
  'any holidays coming up',
  'what holidays are coming',
  'upcoming holiday',
];
const ONE_HOLIDAY = [
  'следующий праздник',
  'ближайший праздник',
  'когда следующий праздник',
  'когда ближайший праздник',
  'какой следующий праздник',
  'какой ближайший праздник',
  'next holiday',
  'the next holiday',
  'when is the next holiday',
  'when is next holiday',
  "what['’]?s the next holiday",
  'what is the next holiday',
  'когда ближайший праздничный день',
  'какой скоро праздник',
  'next public holiday',
  'the next public holiday',
  'when is the next public holiday',
  'show me the next holiday',
  'show next holiday',
];

const holidaysUpcoming: FamilyDefinition = {
  name: 'basis.holidays.upcoming',
  title: 'Upcoming holidays',
  category: 'calendar',
  risk: 'read',
  pattern: `^(?:(${any(MANY_HOLIDAYS)})|${any(ONE_HOLIDAY)})$`,
  triggers: ['праздники', 'праздник', 'праздничный', 'holidays', 'holiday'],
  bindings: {
    many: {
      type: 'enum',
      from: '{{$1|default("")}}',
      values: Object.fromEntries(MANY_HOLIDAYS.map((phrase) => [normalize(phrase), 5])),
      optional: true,
      default: 1,
    },
  },
  steps: [{ call: 'get_holidays', input: { limit: '{{bind.many}}' } }],
  strings: { ru: {}, en: {} },
  examples: [
    'какие праздники в ближайшее время',
    'next public holiday',
    'ближайшие праздники',
    'какие скоро праздники',
    'какие праздники впереди',
    'когда следующий праздник',
    'какой ближайший праздник',
    'upcoming holidays',
    'next holiday',
    'when is the next holiday',
  ],
  negatives: ['какой сегодня праздник', 'праздники в этом году', 'is tomorrow a holiday in Serbia'],
  notes: 'The plural asks for the next five holidays, the singular for the next one.',
};

export const calendarFamilies: FamilyDefinition[] = [
  calendarDay,
  calendarPeriod,
  calendarUpcoming,
  calendarNext,
  calendarSearch,
  calendarWhen,
  calendarCount,
  calendarImage,
  slotsDay,
  slotsWeek,
  slotsCheckTime,
  holidaysUpcoming,
];
