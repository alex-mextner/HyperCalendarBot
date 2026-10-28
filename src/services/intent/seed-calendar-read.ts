// Read-only calendar families that list or count events: a day, a period, what is upcoming or next, a search by
// name, when a named event is, and how many events there are. Built from the shared vocabulary in seed-calendar-vocab.

import {
  AFTER_DAY,
  any,
  COUNT_PERIODS,
  DAY_REF,
  DAY_REF_GROUPS,
  DAY_REF_LITE,
  DAY_REF_LITE_GROUPS,
  DAY_WORDS,
  fillers,
  groupsFrom,
  NOUN_RU,
  RANGE_PERIODS,
  READ_LEAD,
  READ_TAIL,
  S,
  SHOW_EN_BARE,
  SHOW_RU,
  SHOW_RU_BARE,
  TRIGGER_DAYS,
  TRIGGER_PERIODS,
  TRIGGER_READ_LEADS,
  WEEKDAY_SHORT,
} from './seed-calendar-vocab.ts';
import { DATE_SIGNAL, type FamilyDefinition, SCOPE, TIME_SIGNAL } from './seed-fragments.ts';

// ─── calendar.day ───────────────────────────────────────────────────────────

export const calendarDay: FamilyDefinition = {
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

export const calendarPeriod: FamilyDefinition = {
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

export const calendarUpcoming: FamilyDefinition = {
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

export const calendarNext: FamilyDefinition = {
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
export const calendarSearch: FamilyDefinition = {
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

export const calendarWhen: FamilyDefinition = {
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

export const calendarCount: FamilyDefinition = {
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
