import { ANY_DAY_RX, DAY_WORDS, type FamilyDefinition, periodVocabulary, SCOPE, TIME_RX } from './seed-fragments.ts';

const CALENDAR_LEAD = String.raw`(?:что\s+у\s+(?:меня|нас)|что\s+будет|что|(?:мои\s+)?события|(?:мои\s+)?планы?|покажи(?:\s+мне)?(?:\s+события)?|расписание|what(?:['’]s|\s+is|\s+s)(?:\s+on)?|show(?:\s+me)?(?:\s+my)?(?:\s+events|\s+schedule|\s+agenda)?(?:\s+for|\s+on)?|events(?:\s+for|\s+on)?|agenda(?:\s+for)?|schedule(?:\s+for)?)`;
const CALENDAR_TRIGGERS = [
  'что',
  'события',
  'мои',
  'покажи',
  'расписание',
  'план',
  'планы',
  'events',
  'show',
  'agenda',
  'schedule',
  'what',
];

const SLOT_LEAD = String.raw`(?:когда\s+(?:я\s+)?свободен|свободные\s+(?:окна|слоты)|свободное\s+время|when\s+am\s+i\s+free|free\s+(?:slots?|time)|my\s+free\s+(?:slots?|time))`;
const SLOT_TRIGGERS = ['свободен', 'свободные', 'свободное', 'free', 'when', 'my'];

const RANGE_PERIODS = periodVocabulary(['week', 'next_week', 'month', 'next_month', 'weekend']);
const COUNT_PERIODS = periodVocabulary(['today', 'tomorrow', 'week', 'next_week', 'month', 'next_month']);
const IMAGE_PERIODS = periodVocabulary(['today', 'tomorrow', 'week', 'next_week', 'month', 'next_month']);
const WEEK_PERIODS = periodVocabulary(['week', 'next_week']);

const calendarDay: FamilyDefinition = {
  name: 'basis.calendar.day',
  title: 'Events on one day',
  category: 'calendar',
  risk: 'read',
  pattern: String.raw`^${CALENDAR_LEAD}\s+(?:на\s+)?(${ANY_DAY_RX})$`,
  triggers: CALENDAR_TRIGGERS,
  bindings: { day: { type: 'date', from: '{{$1}}', words: DAY_WORDS } },
  steps: [{ call: 'get_events', input: { start_date: '{{bind.day}}', end_date: '{{bind.day}}', scope: SCOPE } }],
  strings: { ru: {}, en: {} },
  examples: [
    'что у меня сегодня',
    'что у нас завтра',
    'покажи послезавтра',
    "what's tomorrow",
    'show events on 2026-10-05',
    'события на 5 октября',
    'agenda for 05.10.2026',
  ],
  negatives: ['что делать завтра', 'что у меня в кошельке', 'покажи завтра погоду', 'не показывай что у меня сегодня'],
  invalidInputs: ['что у меня 31 февраля'],
};

const calendarPeriod: FamilyDefinition = {
  name: 'basis.calendar.period',
  title: 'Events in a week, month or weekend',
  category: 'calendar',
  risk: 'read',
  pattern: String.raw`^${CALENDAR_LEAD}\s+(${RANGE_PERIODS.rx})$`,
  triggers: CALENDAR_TRIGGERS,
  bindings: { p: { type: 'period', from: '{{$1}}', values: RANGE_PERIODS.values } },
  steps: [{ call: 'get_events', input: { start_date: '{{bind.p.start}}', end_date: '{{bind.p.end}}', scope: SCOPE } }],
  strings: { ru: {}, en: {} },
  examples: [
    'что у меня на этой неделе',
    'расписание на следующую неделю',
    'мои события в этом месяце',
    'что у меня в следующем месяце',
    'что у меня на выходных',
    'show this week',
    'events next month',
  ],
  negatives: ['что у меня на прошлой неделе', 'что у меня на неделе после отпуска', 'что у меня в этом году'],
};

const calendarUpcoming: FamilyDefinition = {
  name: 'basis.calendar.upcoming',
  title: 'Next upcoming events',
  category: 'calendar',
  risk: 'read',
  pattern: String.raw`^(?:что\s+(?:у\s+меня\s+)?дальше|(?:мои\s+)?ближайшие(?:\s+(\d{1,2}))?\s+событи[яй]|upcoming(?:\s+(\d{1,2}))?\s+events|next(?:\s+(\d{1,2}))?\s+events|what(?:['’]s|\s+is|\s+s)\s+next)$`,
  triggers: ['дальше', 'ближайшие', 'upcoming', 'next', 'what'],
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
    'ближайшие события',
    'мои ближайшие 3 события',
    'upcoming events',
    'next 2 events',
    "what's next",
  ],
  negatives: ['ближайшие 500 событий', 'что дальше делать с проектом'],
  invalidInputs: ['ближайшие 0 события'],
};

const calendarSearch: FamilyDefinition = {
  name: 'basis.calendar.search',
  title: 'Search events by title',
  category: 'calendar',
  risk: 'read',
  pattern: String.raw`^(?:найди|поищи|покажи|find|search(?:\s+for)?|show)\s+(?:мои\s+|my\s+)?(?:событи[яе]|встреч[иу]|events?|meetings?)\s+(?:про|о|об|по|called|named|about|matching)\s+(.{1,120})$`,
  triggers: ['найди', 'поищи', 'покажи', 'find', 'search', 'show'],
  bindings: { q: { type: 'text', from: '{{$1}}', max: 120 } },
  steps: [{ call: 'search_events', input: { query: '{{bind.q}}', scope: SCOPE } }],
  strings: { ru: {}, en: {} },
  examples: [
    'найди встречи про стендап',
    'поищи события по проекту',
    'find events about standup',
    'search for meetings called retro',
    'покажи события о релизе',
  ],
  negatives: ['найди свободное время', 'найди встречу', 'не ищи события про стендап'],
};

const calendarCount: FamilyDefinition = {
  name: 'basis.calendar.count',
  title: 'How many events in a period',
  category: 'calendar',
  risk: 'read',
  pattern: String.raw`^(?:сколько\s+(?:у\s+меня\s+)?(?:встреч|событий|дел)|how\s+many\s+(?:meetings|events)(?:\s+do\s+i\s+have)?)\s+(${COUNT_PERIODS.rx})$`,
  triggers: ['сколько', 'how'],
  bindings: { p: { type: 'period', from: '{{$1}}', values: COUNT_PERIODS.values } },
  steps: [
    {
      call: 'get_events',
      input: { start_date: '{{bind.p.start}}', end_date: '{{bind.p.end}}', scope: SCOPE },
      as: 'evs',
    },
    { respond: '{{t.count}}' },
  ],
  strings: {
    ru: { count: 'Событий: {{tool_outputs.evs.length}}' },
    en: { count: 'Events: {{tool_outputs.evs.length}}' },
  },
  examples: [
    'сколько у меня встреч сегодня',
    'сколько событий на неделе',
    'сколько дел завтра',
    'how many meetings do i have this week',
    'how many events this month',
  ],
  negatives: ['сколько стоит встреча', 'сколько встреч было вчера'],
};

const calendarImage: FamilyDefinition = {
  name: 'basis.calendar.image',
  title: 'Calendar as an image',
  category: 'calendar',
  risk: 'read',
  pattern: String.raw`^(?:покажи|пришли|отправь|show|send)(?:\s+мне|\s+me)?\s+(?:календарь|расписание|calendar|schedule)\s+(?:картинкой|изображением|as\s+an?\s+image|as\s+a\s+picture)\s+(${IMAGE_PERIODS.rx})$|^(?:покажи|пришли|отправь)(?:\s+мне)?\s+(?:план|расписание|календарь)\s+(${IMAGE_PERIODS.rx})\s+(?:в\s+фото|картинкой|изображением)$`,
  triggers: ['покажи', 'пришли', 'отправь', 'show', 'send'],
  bindings: { p: { type: 'period', from: '{{$1|default("")}}{{$2|default("")}}', values: IMAGE_PERIODS.values } },
  steps: [
    { when: "bind.p.kind == 'day'", call: 'render_day_image', input: { date: '{{bind.p.start}}', scope: SCOPE } },
    {
      when: "bind.p.kind == 'week'",
      call: 'render_week_image',
      input: { week_start: '{{bind.p.start}}', scope: SCOPE },
    },
    { when: "bind.p.kind == 'month'", call: 'render_month_image', input: { month: '{{bind.p.month}}', scope: SCOPE } },
  ],
  strings: { ru: {}, en: {} },
  examples: [
    'покажи календарь картинкой на неделю',
    'пришли план на следующий месяц картинкой',
    'пришли расписание картинкой на завтра',
    'отправь календарь изображением на месяц',
    'show calendar as an image for this month',
    'send me schedule as a picture next week',
  ],
  negatives: ['покажи календарь картинкой', 'покажи календарь на неделю'],
};

const slotsDay: FamilyDefinition = {
  name: 'basis.slots.day',
  title: 'Free time on one day',
  category: 'slots',
  risk: 'read',
  pattern: String.raw`^${SLOT_LEAD}(?:\s+(?:на\s+|on\s+|for\s+)?(${ANY_DAY_RX}))?$`,
  triggers: SLOT_TRIGGERS,
  bindings: { day: { type: 'date', from: '{{$1|default("")}}', words: DAY_WORDS, optional: true, default: 'today' } },
  steps: [{ call: 'get_free_slots', input: { date: '{{bind.day}}', scope: SCOPE } }],
  strings: { ru: {}, en: {} },
  examples: [
    'когда я свободен',
    'когда я свободен завтра',
    'свободные окна на послезавтра',
    'свободные слоты 2026-10-05',
    'when am i free today',
    'free slots on 05.10.2026',
  ],
  negatives: [
    'когда я свободен на неделе после отпуска',
    'не показывай когда я свободен',
    'свободные окна в понедельник',
  ],
};

function weekSection(index: number): string {
  return `{{bind.p.days[${index}]}}:\n{{tool_outputs.d${index}_text}}`;
}

const slotsWeek: FamilyDefinition = {
  name: 'basis.slots.week',
  title: 'Free time on every day of a week',
  category: 'slots',
  risk: 'read',
  pattern: String.raw`^${SLOT_LEAD}\s+(${WEEK_PERIODS.rx})$`,
  triggers: SLOT_TRIGGERS,
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
    'when am i free this week',
    'free slots next week',
  ],
  negatives: ['свободные окна на неделе после отпуска'],
  notes: 'Seven explicit day queries, Monday to Sunday, so every day of the week is answered.',
};

const slotsCheckTime: FamilyDefinition = {
  name: 'basis.slots.check_time',
  title: 'Am I free at a given time',
  category: 'slots',
  risk: 'read',
  pattern: String.raw`^(?:свободен\s+ли\s+я|я\s+свободен|am\s+i\s+free)\s+(${ANY_DAY_RX})\s+(?:в|на|at)\s+(${TIME_RX})$`,
  triggers: ['свободен', 'am'],
  bindings: {
    d: { type: 'date', from: '{{$1}}', words: DAY_WORDS },
    at: { type: 'time', from: '{{$2}}' },
    start: { type: 'datetime', date: 'd', time: 'at' },
    until: { type: 'datetime', date: 'd', time: 'at', plus_minutes: 60 },
  },
  steps: [
    {
      call: 'get_free_slots',
      input: { date: '{{bind.d}}', scope: SCOPE },
      as: 'free',
    },
    { when: 'fits(free, bind.start, bind.until)', respond: '{{t.free}}' },
    { respond: '{{t.busy}}' },
  ],
  strings: {
    ru: {
      free: 'Часовой промежуток {{bind.d}} с {{bind.at}} свободен.',
      busy: 'Весь часовой промежуток не свободен. Проверенные окна:\n{{tool_outputs.free_text}}',
    },
    en: {
      free: 'The hour on {{bind.d}} from {{bind.at}} is free.',
      busy: 'The full hour is not free. Verified intervals:\n{{tool_outputs.free_text}}',
    },
  },
  examples: [
    'свободен ли я завтра в 15:00',
    'я свободен 2026-10-05 в 10:30',
    'свободен ли я сегодня в 7 вечера',
    'am i free tomorrow at 3pm',
  ],
  negatives: ['свободен ли я завтра'],
  invalidInputs: ['свободен ли я завтра в 3', 'am i free tomorrow at 25:00'],
  notes: 'A bare hour from 1 to 12 without am/pm or a day-part word is ambiguous and is never guessed.',
};

const holidaysUpcoming: FamilyDefinition = {
  name: 'basis.holidays.upcoming',
  title: 'Upcoming holidays',
  category: 'calendar',
  risk: 'read',
  pattern: String.raw`^(?:(ближайшие\s+праздники|какие\s+скоро\s+праздники|upcoming\s+holidays|next\s+holidays)|(?:когда\s+)?(?:следующий\s+праздник|next\s+holiday))$`,
  triggers: ['праздники', 'праздник', 'holidays', 'holiday'],
  bindings: {
    many: {
      type: 'enum',
      from: '{{$1|default("")}}',
      values: { 'ближайшие праздники': 5, 'какие скоро праздники': 5, 'upcoming holidays': 5, 'next holidays': 5 },
      optional: true,
      default: 1,
    },
  },
  steps: [{ call: 'get_holidays', input: { limit: '{{bind.many}}' } }],
  strings: { ru: {}, en: {} },
  examples: [
    'ближайшие праздники',
    'какие скоро праздники',
    'когда следующий праздник',
    'upcoming holidays',
    'next holiday',
  ],
  negatives: ['какой сегодня праздник', 'праздники в этом году'],
};

export const calendarFamilies: FamilyDefinition[] = [
  calendarDay,
  calendarPeriod,
  calendarUpcoming,
  calendarSearch,
  calendarCount,
  calendarImage,
  slotsDay,
  slotsWeek,
  slotsCheckTime,
  holidaysUpcoming,
];
