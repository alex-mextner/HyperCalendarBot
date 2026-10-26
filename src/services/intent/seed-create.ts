// Creating events from free-form phrasing. The pattern of each rule only decides "this is a create request"; the
// `event_phrase` binding reads title, day, time, span and invitee from the whole phrase in any order, and refuses
// (the message then goes to the AI) whenever any of them is missing, doubled or ambiguous. Nothing is written before
// the user confirms, and the answer after "yes" says what was created.
import { alt, DATE_SIGNAL, type FamilyDefinition, guardPrivate, SCOPE, TIME_SIGNAL, WB, WE } from './seed-fragments.ts';

/** Start of a message that is a command or a question about something other than creating: such a message is never a verb-less create. */
const NOT_A_CREATE_START =
  '(?:не|нет|что|как|когда|где|кто|зачем|почему|сколько|какой|какая|какие|покажи|скажи|найди|поищи|удали|отмени|убери|перенеси|передвинь|сдвинь|перекинь|переименуй|пригласи|позови|what|when|where|who|why|how|show|find|delete|cancel|remove|move|reschedule|rename|invite|do|does|did|is|are|can|could|will|would|don|dont|свободен|свободна|свободно|свободные|есть|расписание|планы|события|мои|мой|окна|ближайшие|календарь|agenda|schedule for|my|free|я\\s+свободен|я\\s+свободна|am\\s+i|events?|anything|something|tell|give|send|display|list|check|open|скинь|глянь|посмотри|расскажи|подскажи|дай|пришли|выведи|открой|нарисуй|сделай(?!\\s+(?:встреч|событи|напомин|event|meeting|reminder))|во\\s+сколько|подвинь|подвинуть|переставь|отложи|скрой|спрячь|снеси|назови|измени|поменяй|push|shift|bump|snooze|postpone|hide|отправь)';
const CREATE_VERB = alt([
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
  'внеси',
  'организуй',
  'назначь',
  'назначить',
  'create',
  'add',
  'schedule',
  'book',
  'put',
  'plan',
]);
/** Words between the verb and the event: "мне", "в календарь", "to my calendar", "a new". */
const CREATE_OBJECT = String.raw`(?:(?:мне|себе|нам|в\s+(?:мой\s+)?(?:календарь|расписание)|(?:to|into|in|on)\s+(?:my\s+)?calendar|a|an|new|on|for)\s+){0,4}`;
const REMIND_VERB = String.raw`(?:напомни(?:те)?|remind\s+me)`;
const INVITE_WORD = String.raw`(?:пригласи\w*|позови|invite)`;
// A time range is its own reading ("с 14:00 до 15:30"); it is a create too, with an explicit end.
// A second command in the same message ("…и удали все события") is not a create: the AI takes the whole message.
const NO_SECOND_COMMAND = String.raw`(?!.*${WB}(?:удали\w*|отмени\w*|убери\w*|перенеси\w*|передвинь|сдвинь|delete|cancel|remove|reschedule)${WE})`;
const NO_INVITE = `(?!.*${WB}${INVITE_WORD}${WE})(?!.*@[A-Za-z])`;
// "напомни через 15 минут …" and "напомни за 15 минут до …" belong to other rules.
const NOT_RELATIVE_REMINDER = String.raw`(?!(?:напомни(?:те)?|remind\s+me)\s+(?:мне\s+)?(?:через|за|in)\s)`;

// A verb-less create starts with its day or its time ("12 июня 13:45 окрашивание", "Пятница 16:00 Ада"), so the day
// names, the months and any clock hour select this rule as a candidate; the pattern and the binding decide.
const CREATE_TRIGGERS = [
  'в',
  'на',
  'at',
  'on',
  'сегодня',
  'завтра',
  'послезавтра',
  'today',
  'tomorrow',
  ...'понедельник вторник среда среду четверг пятница пятницу суббота субботу воскресенье пн вт ср чт пт сб вс'.split(
    ' ',
  ),
  ...'monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thurs fri sat sun'.split(' '),
  ...'января февраля марта апреля мая июня июля августа сентября октября ноября декабря'.split(' '),
  ...'january february march april may june july august september october november december'.split(' '),
  ...Array.from({ length: 32 }, (_, number) => String(number)),
];

const STRINGS = {
  ru: {
    q_free: 'Создать «{{bind.ev.title}}» {{bind.ev.when_text}}{{bind.ev.end_suffix|default("")}}?',
    q_clash:
      'Создать «{{bind.ev.title}}» {{bind.ev.when_text}}{{bind.ev.end_suffix|default("")}}? В это время уже что-то есть. Свободные окна дня:\n{{tool_outputs.availability_text}}',
    done: 'Готово: создал «{{bind.ev.title}}» — {{bind.ev.when_text}}{{bind.ev.end_suffix|default("")}}.',
  },
  en: {
    q_free: 'Create “{{bind.ev.title}}” {{bind.ev.when_text}}{{bind.ev.end_suffix|default("")}}?',
    q_clash:
      'Create “{{bind.ev.title}}” {{bind.ev.when_text}}{{bind.ev.end_suffix|default("")}}? Something else is scheduled then. Free windows that day:\n{{tool_outputs.availability_text}}',
    done: 'Done: created “{{bind.ev.title}}” — {{bind.ev.when_text}}{{bind.ev.end_suffix|default("")}}.',
  },
};

const eventCreate: FamilyDefinition = {
  name: 'basis.event.create',
  title: 'Create an event with a title, a day and a time',
  category: 'events',
  risk: 'write',
  // Verb optional: "завтра в 15:00 стоматолог" is a create too. A message that starts with another command or a
  // question word, or that asks for an invitation, is not this rule's.
  pattern: String.raw`^(?!${NOT_A_CREATE_START}${WE})${DATE_SIGNAL}${TIME_SIGNAL}${NOT_RELATIVE_REMINDER}${NO_INVITE}${NO_SECOND_COMMAND}(?:(?:${CREATE_VERB}|${REMIND_VERB})\s+${CREATE_OBJECT}(?:(?:что|чтобы|to|that)\s+)?)?(.{3,300})$`,
  triggers: CREATE_TRIGGERS,
  bindings: {
    ev: { type: 'event_phrase', from: '{{$1}}', date: 'require', time: 'require', span: 'allow', future: true },
  },
  steps: [
    { call: 'get_free_slots', input: { date: '{{bind.ev.date}}', scope: SCOPE }, as: 'availability' },
    {
      when: 'fits(availability, bind.ev.start, bind.ev.end)',
      call: 'ask_user',
      input: { question: '{{t.q_free}}', options: ['{{t.ok}}', '{{t.cancel}}'] },
      as: 'confirm|lower',
    },
    {
      when: 'fits(availability, bind.ev.start, bind.ev.end) == false',
      call: 'ask_user',
      input: { question: '{{t.q_clash}}', options: ['{{t.ok}}', '{{t.cancel}}'] },
      as: 'confirm|lower',
    },
    { when: "ask.confirm != 'да' && ask.confirm != 'yes'", respond: '{{t.cancelled}}' },
    {
      when: 'bind.ev.has_end == false',
      call: 'create_event',
      input: { title: '{{bind.ev.title}}', start_at: '{{bind.ev.start}}', scope: SCOPE },
    },
    {
      when: 'bind.ev.has_end == true',
      call: 'create_event',
      input: { title: '{{bind.ev.title}}', start_at: '{{bind.ev.start}}', end_at: '{{bind.ev.end}}', scope: SCOPE },
    },
    { respond: '{{t.done}}' },
  ],
  strings: STRINGS,
  examples: [
    'создай стендап завтра в 10:30',
    'запланируй встречу с Иваном послезавтра в 15:00',
    'добавь событие Зубной 2026-10-05 в 9:15',
    'поставь ретро 5 октября в 7 вечера',
    'завтра в 15:00 стоматолог',
    'пятница 16:00 урок с Лилей',
    '12 июня 13:45 окрашивание',
    'завтра 13 нотариус',
    'среда с 13 до 15 обед',
    'созвон с Пашей в пятницу в 18:30 на час',
    'напомни завтра в 10:00 позвонить врачу',
    'create standup tomorrow at 10:30',
    'schedule meeting with Anna 05.10.2026 at 3pm',
    'dentist tomorrow at 3pm',
  ],
  negatives: [
    'создай стендап завтра',
    'создай встречу',
    'не создавай стендап завтра в 10:30',
    'что у меня завтра в 15:00',
    'покажи события завтра в 15:00',
    'удали стендап завтра в 10:30',
    'напомни через 10 минут позвонить маме',
  ],
  invalidInputs: [
    'завтра 13 человек придёт',
    'среда с 13 до 15 человек в зале',
    'создай стендап завтра в 10',
    'создай стендап 31 февраля в 10:30',
    'создай стендап вчера в 10:30',
    'create standup tomorrow at 99:00',
    'создай стендап в следующую пятницу в 10:30',
    'стендап завтра вечером в 19:00',
  ],
  notes:
    'One rule for explicit-verb, reminder-phrased and verb-less creates, with an optional end time or duration. Day, time and title must each appear exactly once; a bare hour, a next-weekday, a day part or a clock time that a DST change skips go to the AI.',
};

const eventCreateInvite: FamilyDefinition = {
  name: 'basis.event.create_invite',
  title: 'Create an event and invite a named @username',
  category: 'invitations',
  risk: 'write',
  pattern: String.raw`^(?!${NOT_A_CREATE_START}${WE})${DATE_SIGNAL}${TIME_SIGNAL}${NO_SECOND_COMMAND}(?=.*(?:${WB}${INVITE_WORD}\s+(?:(?:туда|его|её|ее|them|him|her)\s+)?@|^@|${WB}(?:с|with)\s+@))(?:(?:${CREATE_VERB})\s+${CREATE_OBJECT})?(.{3,300})$`,
  triggers: [
    'пригласи',
    'позови',
    'invite',
    'создай',
    'добавь',
    'запланируй',
    'поставь',
    'create',
    'schedule',
    'add',
    ...CREATE_TRIGGERS,
  ],
  bindings: {
    ev: {
      type: 'event_phrase',
      from: '{{$1}}',
      date: 'require',
      time: 'require',
      span: 'allow',
      invitee: 'require',
      future: true,
    },
  },
  steps: [
    guardPrivate(),
    { call: 'get_free_slots', input: { date: '{{bind.ev.date}}', scope: SCOPE }, as: 'availability' },
    {
      when: 'fits(availability, bind.ev.start, bind.ev.end)',
      call: 'ask_user',
      input: { question: '{{t.q_free}}', options: ['{{t.ok}}', '{{t.cancel}}'] },
      as: 'confirm|lower',
    },
    {
      when: 'fits(availability, bind.ev.start, bind.ev.end) == false',
      call: 'ask_user',
      input: { question: '{{t.q_clash}}', options: ['{{t.ok}}', '{{t.cancel}}'] },
      as: 'confirm|lower',
    },
    { when: "ask.confirm != 'да' && ask.confirm != 'yes'", respond: '{{t.cancelled}}' },
    {
      when: 'bind.ev.has_end == false',
      call: 'create_event',
      input: { title: '{{bind.ev.title}}', start_at: '{{bind.ev.start}}', scope: SCOPE },
      as: 'created',
    },
    {
      when: 'bind.ev.has_end == true',
      call: 'create_event',
      input: { title: '{{bind.ev.title}}', start_at: '{{bind.ev.start}}', end_at: '{{bind.ev.end}}', scope: SCOPE },
      as: 'created',
    },
    {
      call: 'send_invitation',
      input: { event_id: '{{tool_outputs.created.id}}', invitee_username: '{{bind.ev.invitee}}' },
    },
    { respond: '{{t.done}}' },
  ],
  strings: {
    ru: {
      q_free: 'Создать «{{bind.ev.title}}» {{bind.ev.when_text}} и пригласить @{{bind.ev.invitee}}?',
      q_clash:
        'Создать «{{bind.ev.title}}» {{bind.ev.when_text}} и пригласить @{{bind.ev.invitee}}? В это время уже что-то есть. Свободные окна дня:\n{{tool_outputs.availability_text}}',
      done: 'Готово: создал «{{bind.ev.title}}» — {{bind.ev.when_text}} — и отправил приглашение @{{bind.ev.invitee}}.',
    },
    en: {
      q_free: 'Create “{{bind.ev.title}}” {{bind.ev.when_text}} and invite @{{bind.ev.invitee}}?',
      q_clash:
        'Create “{{bind.ev.title}}” {{bind.ev.when_text}} and invite @{{bind.ev.invitee}}? Something else is scheduled then. Free windows that day:\n{{tool_outputs.availability_text}}',
      done: 'Done: created “{{bind.ev.title}}” — {{bind.ev.when_text}} — and sent an invitation to @{{bind.ev.invitee}}.',
    },
  },
  examples: [
    'создай встречу завтра в 15:00 и пригласи @ivan_petrov',
    'запланируй ретро в пятницу в 16:00, пригласи @anna_smith',
    'schedule sync tomorrow at 3pm and invite @mark_t1',
    '@anna_smith завтра в 15:00 созвон',
    'ретро в пятницу в 16:00 с @anna_smith',
  ],
  negatives: [
    'пригласи @ivan_petrov на событие #12',
    'создай встречу завтра в 15:00 и пригласи Ивана',
    'не приглашай @ivan_petrov на встречу завтра в 15:00',
    'создай встречу завтра и пригласи @ivan_petrov',
  ],
  invalidInputs: ['создай встречу завтра в 10 и пригласи @ivan_petrov'],
  notes:
    'Two effects behind one confirmation: the event, then the invitation to an exact @username. If the invitation fails after the event exists, the executor reports the applied write instead of retrying.',
};

export const createFamilies: FamilyDefinition[] = [eventCreate, eventCreateInvite];
