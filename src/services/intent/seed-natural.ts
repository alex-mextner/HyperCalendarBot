import {
  confirmStep,
  type FamilyDefinition,
  guardPrivate,
  resolveEvent,
  SCOPE,
  type SeedStep,
} from './seed-fragments.ts';

/**
 * Terse natural requests. The two event families are fallbacks: their `event_request` /
 * `cancel_target` binding is also a structural recognizer, so the matcher tries them only
 * when no explicit command rule accepts the message (see IntentMatcher).
 */

const askOptions = ['{{t.ok}}', '{{t.cancel}}'];
const ENTRY = 'bind.entry';
const EXACT = `${ENTRY}.mode == 'exact'`;
const FITS = `fits(availability, ${ENTRY}.start, ${ENTRY}.until)`;
const HAS_END = `has(${ENTRY}.end)`;
const yes = (extra: string) => `ask.pick == 'да' && ${extra} || ask.pick == 'yes' && ${extra}`;

function ask(when: string, question: string, options: string[]): SeedStep {
  return { when, call: 'ask_user', input: { question, options }, as: 'pick|lower' };
}

function create(when: string, start: string, withEnd: boolean): SeedStep {
  return {
    when,
    call: 'create_event',
    input: {
      title: `{{${ENTRY}.title}}`,
      start_at: start,
      ...(withEnd ? { end_at: `{{${ENTRY}.end}}` } : {}),
      scope: SCOPE,
    },
  };
}

/**
 * Every mode suspends on exactly one question stored as `pick`: yes/cancel for an exact
 * or noon time, the concrete clock times for a bare hour. Nothing is created before it.
 */
const createSteps: SeedStep[] = [
  { when: EXACT, call: 'get_free_slots', input: { date: `{{${ENTRY}.date}}`, scope: SCOPE }, as: 'availability' },
  ask(`${EXACT} && ${FITS}`, '{{t.q_free}}', askOptions),
  ask(`${EXACT} && ${FITS} == false`, '{{t.q_clash}}', askOptions),
  ask(`${ENTRY}.mode == 'noon'`, '{{t.q_noon}}', askOptions),
  ask(`${ENTRY}.mode == 'choose' && count(${ENTRY}.time_options) == 2`, '{{t.q_choose}}', [
    `{{${ENTRY}.time_options[0]}}`,
    `{{${ENTRY}.time_options[1]}}`,
    '{{t.cancel}}',
  ]),
  ask(`${ENTRY}.mode == 'choose' && count(${ENTRY}.time_options) == 1`, '{{t.q_one}}', [
    `{{${ENTRY}.time_options[0]}}`,
    '{{t.cancel}}',
  ]),
  create(yes(HAS_END), `{{${ENTRY}.start}}`, true),
  create(yes(`${HAS_END} == false`), `{{${ENTRY}.start}}`, false),
  create(`ask.pick == ${ENTRY}.time_options[0]`, `{{${ENTRY}.start_options[0]}}`, false),
  create(`ask.pick == ${ENTRY}.time_options[1]`, `{{${ENTRY}.start_options[1]}}`, false),
  { when: "ask.pick == 'отмена' || ask.pick == 'cancel'", respond: '{{t.cancelled}}' },
];

const WHAT_RU = '«{{bind.entry.title}}» {{bind.entry.date}}';
const WHAT_EN = '“{{bind.entry.title}}” on {{bind.entry.date}}';
const ZONE = '({{bind.entry.timezone}})';

const naturalCreate: FamilyDefinition = {
  name: 'basis.event.create_natural',
  title: 'Create one event from a terse title, day and time written in any order',
  category: 'events',
  risk: 'write',
  pattern: String.raw`^([^\n]{3,800})$`,
  triggers: ['завтра', 'сегодня', 'tomorrow', 'today'],
  bindings: { entry: { type: 'event_request', from: '{{$1}}' } },
  steps: createSteps,
  strings: {
    ru: {
      q_free: `Создать ${WHAT_RU} в {{bind.entry.time}} ${ZONE}?`,
      q_clash: `Создать ${WHAT_RU} в {{bind.entry.time}} ${ZONE}? Не весь следующий час свободен. Проверенные окна:\n{{tool_outputs.availability_text}}`,
      q_noon: `Создать ${WHAT_RU} в 12:00 ${ZONE}? «12» понял как полдень; если нужна полночь, нажми «Отмена» и напиши 00:00.`,
      q_choose: `Во сколько создать ${WHAT_RU} ${ZONE}? Время без минут может значить и утро, и вечер.`,
      q_one: `Создать ${WHAT_RU} в {{bind.entry.time_options[0]}} ${ZONE}? Утреннее время уже прошло.`,
    },
    en: {
      q_free: `Create ${WHAT_EN} at {{bind.entry.time}} ${ZONE}?`,
      q_clash: `Create ${WHAT_EN} at {{bind.entry.time}} ${ZONE}? The complete following hour is not free. Verified intervals:\n{{tool_outputs.availability_text}}`,
      q_noon: `Create ${WHAT_EN} at 12:00 ${ZONE}? I read “12” as noon; for midnight press Cancel and send 00:00.`,
      q_choose: `What time should ${WHAT_EN} start ${ZONE}? An hour without minutes can mean morning or evening.`,
      q_one: `Create ${WHAT_EN} at {{bind.entry.time_options[0]}} ${ZONE}? The morning reading has already passed.`,
    },
  },
  examples: [
    'Добавь на завтра на 10:30 йогу',
    'Завтра 13:15 стрижка',
    '5 октября 14:00 стоматолог',
    '6 октября, ремонт велосипеда в 16.00',
    'Завтра пробежка в 12',
    'Завтра в 3 пробежка',
    'Послезавтра 13:00-14:30 воркшоп',
    'Завтра в 15:00 по Москве созвон с поставщиком',
    'Tomorrow 9:15 dentist',
    'dentist tomorrow at 17:30',
  ],
  negatives: [
    'Завтра йога',
    'Завтра в 10:30',
    'не ставь йогу завтра в 10:30',
    'Завтра в 10:30 йога и пригласи Анну',
    'Йога завтра в 10:30?',
    'Завтра 10:30 йога\nЗавтра 12:00 бассейн',
    'Каждый вторник в 10:30 йога',
    'удали йогу завтра в 10:30',
    'Завтра в 10:30 йога, послезавтра в 11:00 бассейн',
    'Йога в следующий вторник в 10:30',
    'Через 2 часа йога',
    'Завтра в 16:00 GMT+4 созвон',
    'Завтра в два часа йога',
    'Завтра в 10:30 йога https://example.com/place',
  ],
  invalidInputs: ['Йога 31 февраля в 10:30', 'Йога вчера в 10:30'],
  notes:
    'Title, day and start are required; the day may be a day word, an absolute date or a weekday (nearest from today on). A bare hour 1–11 offers both readings, 12 is confirmed as noon, an explicit zone applies only to this event. Invitations, reminders, links, lists and several events abstain to the assistant.',
};

const cancelByTitle: FamilyDefinition = {
  name: 'basis.event.cancel_by_title',
  title: 'Delete one event named by a short title, verb first or last',
  category: 'events',
  risk: 'write',
  pattern: String.raw`^([^\n]{2,200})$`,
  triggers: ['отмени', 'удали', 'убери', 'cancel', 'delete', 'remove'],
  bindings: { ref: { type: 'cancel_target', from: '{{$1}}' } },
  steps: [
    ...resolveEvent(),
    ...confirmStep('q'),
    { call: 'delete_event', input: { event_id: '{{tool_outputs.target.id}}', scope: SCOPE } },
  ],
  strings: {
    ru: { q: 'Удалить {{t.target}}? Это нельзя отменить.' },
    en: { q: 'Delete {{t.target}}? This cannot be undone.' },
  },
  examples: ['Отмени пробежку', 'Бассейн убери', 'Удали урок гитары', 'cancel dentist', 'Стоматолог отмени'],
  negatives: [
    'Удали его',
    'Отмени всё',
    'Удали бассейн и йогу',
    'Удали йогу завтра',
    'Не отменяй пробежку',
    'Отмена',
    'Йогу в 14 удали',
    'Удали эту встречу',
  ],
  notes:
    'A title must match exactly one event, removal always asks first; pronouns, dates, bulk words and several targets abstain.',
};

const timezoneShow: FamilyDefinition = {
  name: 'basis.settings.timezone_show',
  title: 'Say which timezone is set',
  category: 'settings',
  risk: 'private_read',
  pattern: String.raw`^(?:какая\s+у\s+меня\s+(?:таймзона|тайм\s*зона)|какой\s+(?:у\s+меня\s+)?(?:сейчас\s+)?часовой\s+пояс(?:\s+(?:стоит|установлен|у\s+меня))?|мой\s+часовой\s+пояс|what(?:['’]s|\s+is)\s+my\s+time\s*zone|which\s+time\s*zone\s+am\s+i\s+in)$`,
  triggers: ['какая', 'какой', 'мой', 'what', 'which'],
  steps: [guardPrivate(), { respond: '{{t.tz}}' }],
  strings: {
    ru: { tz: 'Твой часовой пояс: {{user.timezone}}.' },
    en: { tz: 'Your timezone: {{user.timezone}}.' },
  },
  examples: ['Какая у меня таймзона', 'какой часовой пояс стоит', 'мой часовой пояс', "what's my timezone"],
  negatives: ['какой часовой пояс в Токио', 'мой часовой пояс Europe/Moscow'],
};

export const naturalFamilies: FamilyDefinition[] = [naturalCreate, cancelByTitle, timezoneShow];
