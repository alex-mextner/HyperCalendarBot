// Read-only calendar families: what is on a day / a period, what is next, when a named event is, how many events,
// a picture of the calendar, free time and holidays. Every one only reads, so the cost of a wrong reading is a wrong
// list, not a wrong write; the gates are still strict (a whole message of known words, one day or period, one
// event mention) and anything the bindings cannot read unambiguously goes to the AI before a tool runs.
//
// The phrasing lives in seed-calendar-vocab; the families are in seed-calendar-read, seed-calendar-free and here
// (the calendar picture). This module assembles them into the one list the seed catalog reads.

import { holidaysUpcoming, slotsCheckTime, slotsDay, slotsWeek } from './seed-calendar-free.ts';
import {
  calendarCount,
  calendarDay,
  calendarNext,
  calendarPeriod,
  calendarSearch,
  calendarUpcoming,
  calendarWhen,
} from './seed-calendar-read.ts';
import { any, IMAGE_PERIODS, S } from './seed-calendar-vocab.ts';
import { type FamilyDefinition, SCOPE } from './seed-fragments.ts';

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
