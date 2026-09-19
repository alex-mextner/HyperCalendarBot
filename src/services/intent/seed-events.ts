import {
  ANY_DAY_RX,
  BULK_WORDS,
  confirmStep,
  DAY_WORDS,
  DURATION_UNIT_RX,
  DURATION_UNITS,
  EVENT_NOUN_RX,
  type FamilyDefinition,
  guardPrivate,
  QUOTED_OR_ID_RX,
  resolveEvent,
  SCOPE,
  TIME_RX,
  USERNAME_RX,
} from './seed-fragments.ts';
import type { Binding } from './workflow-bindings.ts';

const eventRef = (from: string): Binding => ({ type: 'eventref', from, reject: BULK_WORDS });
const TARGET_ID = '{{tool_outputs.target.id}}';
const askOptions = ['{{t.ok}}', '{{t.cancel}}'];
const notCleared = "ask.confirm != 'да' && ask.confirm != 'yes'";

const eventCreate: FamilyDefinition = {
  name: 'basis.event.create',
  title: 'Create an event with a title, day and time',
  category: 'events',
  risk: 'write',
  pattern: String.raw`^(?:создай|добавь|запланируй|поставь|create|add|schedule)\s+(?:(?:новое\s+)?(?:событие|встречу)\s+|(?:a\s+|an\s+|new\s+)?(?:event|meeting)\s+)?(.{1,200}?)\s+(${ANY_DAY_RX})\s+(?:в|на|at)\s+(${TIME_RX})$`,
  triggers: ['создай', 'добавь', 'запланируй', 'поставь', 'create', 'add', 'schedule'],
  bindings: {
    title: { type: 'text', from: '{{$1}}', max: 200 },
    d: { type: 'date', from: '{{$2}}', words: DAY_WORDS, future: true },
    at: { type: 'time', from: '{{$3}}' },
    start: { type: 'datetime', date: 'd', time: 'at', future: true },
    until: { type: 'datetime', date: 'd', time: 'at', plus_minutes: 60 },
  },
  steps: [
    {
      call: 'get_free_slots',
      input: { date: '{{bind.d}}', scope: SCOPE },
      as: 'availability',
    },
    {
      when: 'fits(availability, bind.start, bind.until)',
      call: 'ask_user',
      input: { question: '{{t.q_free}}', options: askOptions },
      as: 'confirm|lower',
    },
    {
      when: 'fits(availability, bind.start, bind.until) == false',
      call: 'ask_user',
      input: { question: '{{t.q_clash}}', options: askOptions },
      as: 'confirm|lower',
    },
    { when: notCleared, respond: '{{t.cancelled}}' },
    { call: 'create_event', input: { title: '{{bind.title}}', start_at: '{{bind.start}}', scope: SCOPE } },
  ],
  strings: {
    ru: {
      q_free: 'Создать «{{bind.title}}» {{bind.d}} в {{bind.at}}?',
      q_clash:
        'Создать «{{bind.title}}» {{bind.d}} в {{bind.at}}? Не весь следующий час свободен. Проверенные окна:\n{{tool_outputs.availability_text}}',
    },
    en: {
      q_free: 'Create “{{bind.title}}” on {{bind.d}} at {{bind.at}}?',
      q_clash:
        'Create “{{bind.title}}” on {{bind.d}} at {{bind.at}}? The complete following hour is not free. Verified intervals:\n{{tool_outputs.availability_text}}',
    },
  },
  examples: [
    'создай стендап завтра в 10:30',
    'запланируй встречу с Иваном послезавтра в 15:00',
    'добавь событие Зубной 2026-10-05 в 9:15',
    'поставь ретро 5 октября в 7 вечера',
    'create standup tomorrow at 10:30',
    'schedule meeting with Anna 05.10.2026 at 3pm',
  ],
  negatives: ['создай стендап завтра', 'создай встречу', 'не создавай стендап завтра в 10:30'],
  invalidInputs: [
    'создай стендап завтра в 10',
    'создай стендап 31 февраля в 10:30',
    'создай стендап вчера в 10:30',
    'create standup tomorrow at 99:00',
  ],
  notes:
    'Actual free intervals determine the conflict warning inside the confirmation question; nothing is written before the user answers yes.',
};

const eventShow: FamilyDefinition = {
  name: 'basis.event.show',
  title: 'Show one event by number or exact title',
  category: 'events',
  risk: 'read',
  pattern: String.raw`^(?:покажи|открой|show|open)\s+${EVENT_NOUN_RX}\s+${QUOTED_OR_ID_RX}$`,
  triggers: ['покажи', 'открой', 'show', 'open'],
  bindings: { ref: eventRef('{{$1}}') },
  steps: resolveEvent(),
  strings: { ru: {}, en: {} },
  examples: ['покажи событие #12', 'открой встречу «Стендап»', 'show event #7', 'open meeting "Retro"'],
  negatives: ['покажи событие про стендап', 'покажи событие', 'покажи события #12'],
};

const eventReschedule: FamilyDefinition = {
  name: 'basis.event.reschedule',
  title: 'Move an event to an explicit day and time',
  category: 'events',
  risk: 'write',
  pattern: String.raw`^(?:перенеси|передвинь|reschedule|move)\s+${EVENT_NOUN_RX}\s+(.{1,120}?)\s+(?:на|to)\s+(${ANY_DAY_RX})\s+(?:в|на|at)\s+(${TIME_RX})$`,
  triggers: ['перенеси', 'передвинь', 'reschedule', 'move'],
  bindings: {
    ref: eventRef('{{$1}}'),
    d: { type: 'date', from: '{{$2}}', words: DAY_WORDS, future: true },
    at: { type: 'time', from: '{{$3}}' },
    start: { type: 'datetime', date: 'd', time: 'at', future: true },
  },
  steps: [
    ...resolveEvent(),
    { when: 'has(tool_outputs.target.end_at)', respond: '{{t.needs_end}}' },
    ...confirmStep('q'),
    { call: 'update_event', input: { event_id: TARGET_ID, start_at: '{{bind.start}}', scope: SCOPE } },
  ],
  strings: {
    ru: {
      q: 'Перенести {{t.target}} на {{bind.d}} в {{bind.at}}?',
      needs_end:
        'У этого события задана длительность, и сдвиг только начала её испортит. Напиши новое время начала и конца целиком, например «перенеси событие #{{tool_outputs.target.id}} на завтра с 10:00 до 11:00».',
    },
    en: {
      q: 'Move {{t.target}} to {{bind.d}} at {{bind.at}}?',
      needs_end:
        'This event has an end time, and moving only its start would corrupt it. Send the new start and end together, for example “move event #{{tool_outputs.target.id}} tomorrow from 10:00 to 11:00”.',
    },
  },
  examples: [
    'перенеси событие стендап на завтра в 11:00',
    'передвинь встречу #12 на 2026-10-05 в 15:30',
    'перенеси событие «Ретро» на послезавтра в 7 вечера',
    'reschedule event #12 to tomorrow at 3pm',
    'move meeting standup to 05.10.2026 at 10:30',
  ],
  negatives: ['перенеси событие стендап', 'перенеси все события на завтра в 10:30'],
  invalidInputs: ['перенеси событие все на завтра в 10:30', 'перенеси событие стендап на завтра в 3'],
  notes:
    'Events with an explicit end time are refused rather than silently corrupted; a relative shift is the snooze family.',
};

const eventRename: FamilyDefinition = {
  name: 'basis.event.rename',
  title: 'Rename an event',
  category: 'events',
  risk: 'write',
  pattern: String.raw`^(?:переименуй|rename)\s+${EVENT_NOUN_RX}\s+${QUOTED_OR_ID_RX}\s+(?:в|на|to|as)\s+(.{1,200})$`,
  triggers: ['переименуй', 'rename'],
  bindings: { ref: eventRef('{{$1}}'), title: { type: 'text', from: '{{$2}}', max: 200 } },
  steps: [
    ...resolveEvent(),
    ...confirmStep('q'),
    { call: 'update_event', input: { event_id: TARGET_ID, title: '{{bind.title}}', scope: SCOPE } },
  ],
  strings: {
    ru: { q: 'Переименовать {{t.target}} в «{{bind.title}}»?' },
    en: { q: 'Rename {{t.target}} to “{{bind.title}}”?' },
  },
  examples: [
    'переименуй событие #12 в Ретро',
    'переименуй встречу «Стендап» в «Планёрка»',
    'rename event #7 to Retro',
    'rename meeting "Sync" as Planning',
  ],
  negatives: ['переименуй событие стендап в обед', 'переименуй событие #12'],
};

const eventSetDetail: FamilyDefinition = {
  name: 'basis.event.set_detail',
  title: 'Change an event location or description',
  category: 'events',
  risk: 'write',
  pattern: String.raw`^(?:измени|поменяй|укажи|установи|set|change|update)\s+(место|локацию|описание|location|description)\s+(?:of\s+)?(?:события|встречи|event|meeting)\s+${QUOTED_OR_ID_RX}\s+(?:на|to)\s+(.{1,300})$`,
  triggers: ['измени', 'поменяй', 'укажи', 'установи', 'set', 'change', 'update'],
  bindings: {
    field: {
      type: 'enum',
      from: '{{$1}}',
      values: {
        место: 'location',
        локацию: 'location',
        location: 'location',
        описание: 'description',
        description: 'description',
      },
    },
    ref: eventRef('{{$2}}'),
    value: { type: 'text', from: '{{$3}}', max: 300 },
  },
  steps: [
    ...resolveEvent(),
    ...confirmStep('q'),
    {
      when: "bind.field == 'location'",
      call: 'update_event',
      input: { event_id: TARGET_ID, location: '{{bind.value}}', scope: SCOPE },
    },
    {
      when: "bind.field == 'description'",
      call: 'update_event',
      input: { event_id: TARGET_ID, description: '{{bind.value}}', scope: SCOPE },
    },
  ],
  strings: {
    ru: { q: 'Изменить {{bind.field}} у {{t.target}} на «{{bind.value}}»?' },
    en: { q: 'Change {{bind.field}} of {{t.target}} to “{{bind.value}}”?' },
  },
  examples: [
    'измени место события #12 на Переговорка 3',
    'укажи описание встречи «Стендап» на Обсудить релиз',
    'set location of event #7 to Room 4',
    'change description event "Retro" to Bring notes',
  ],
  negatives: ['измени место события стендап на офис', 'измени место события #12'],
};

const eventDelete: FamilyDefinition = {
  name: 'basis.event.delete',
  title: 'Delete one event after confirmation',
  category: 'events',
  risk: 'write',
  pattern: String.raw`^(?:удали|отмени|delete|cancel|remove)\s+${EVENT_NOUN_RX}\s+([^;\n]{1,120})$`,
  triggers: ['удали', 'отмени', 'delete', 'cancel', 'remove'],
  bindings: { ref: eventRef('{{$1}}') },
  steps: [
    ...resolveEvent(),
    ...confirmStep('q'),
    { call: 'delete_event', input: { event_id: TARGET_ID, scope: SCOPE } },
  ],
  strings: {
    ru: { q: 'Удалить {{t.target}}? Это нельзя отменить.' },
    en: { q: 'Delete {{t.target}}? This cannot be undone.' },
  },
  examples: [
    'удали событие #12',
    'отмени встречу с Иваном',
    'удали событие «Стендап»',
    'delete event #7',
    'cancel meeting with Anna',
    'remove event Retro',
  ],
  negatives: ['удали все события', 'удали все встречи сегодня', 'не удаляй событие #12', 'удали событие'],
  invalidInputs: ['удали событие все'],
  notes: 'Bulk words are rejected, a title must match exactly one event, and removal always asks first.',
};

const eventSnooze: FamilyDefinition = {
  name: 'basis.event.snooze',
  title: 'Shift an event later by minutes or hours',
  category: 'events',
  risk: 'write',
  pattern: String.raw`^(?:отложи|сдвинь|перенеси|snooze|postpone|delay)\s+${EVENT_NOUN_RX}\s+(.{1,120}?)\s+(?:на|by|for)\s+(\d{1,4})\s*(${DURATION_UNIT_RX})$`,
  triggers: ['отложи', 'сдвинь', 'перенеси', 'snooze', 'postpone', 'delay'],
  bindings: {
    ref: eventRef('{{$1}}'),
    dur: { type: 'duration', from: '{{$2}}', unit: '{{$3}}', units: DURATION_UNITS, min: 1, max: 1440 },
  },
  steps: [
    ...resolveEvent(),
    ...confirmStep('q'),
    { call: 'snooze_event', input: { event_id: TARGET_ID, minutes: '{{bind.dur}}', scope: SCOPE } },
  ],
  strings: {
    ru: { q: 'Сдвинуть {{t.target}} на {{bind.dur}} мин позже?' },
    en: { q: 'Move {{t.target}} {{bind.dur}} min later?' },
  },
  examples: [
    'отложи событие #12 на 15 минут',
    'сдвинь встречу стендап на 2 часа',
    'перенеси событие «Ретро» на 30 мин',
    'snooze event #7 by 20 minutes',
    'postpone meeting standup for 1 hour',
    'перенеси событие стендап на 15 минут',
  ],
  negatives: ['отложи событие #12', 'отложи событие #12 на потом'],
  invalidInputs: ['отложи событие #12 на 0 минут', 'отложи событие #12 на 3000 минут'],
};

const eventHide: FamilyDefinition = {
  name: 'basis.event.hide',
  title: 'Make an event private',
  category: 'events',
  risk: 'write',
  pattern: String.raw`^(?:скрой|спрячь|hide)\s+${EVENT_NOUN_RX}\s+([^;\n]{1,120})$`,
  triggers: ['скрой', 'спрячь', 'hide'],
  bindings: { ref: eventRef('{{$1}}') },
  steps: [
    guardPrivate(),
    ...resolveEvent(),
    ...confirmStep('q'),
    { call: 'set_event_visibility', input: { event_id: TARGET_ID, visibility: 'private' } },
  ],
  strings: {
    ru: { q: 'Сделать {{t.target}} приватным? Другие перестанут его видеть.' },
    en: { q: 'Make {{t.target}} private? Others will stop seeing it.' },
  },
  examples: ['скрой событие #12', 'спрячь встречу с врачом', 'hide event #7', 'hide meeting Retro'],
  negatives: ['покажи событие всем', 'скрой все события', 'не скрывай событие #12'],
  invalidInputs: ['скрой событие все'],
  notes: 'Only narrows visibility. Widening it (full details for everyone) is never triggered by chat phrasing.',
};

const reminderSet: FamilyDefinition = {
  name: 'basis.reminder.set',
  title: 'Remind before an event',
  category: 'reminders',
  risk: 'write',
  pattern: String.raw`^(?:напомни(?:\s+мне)?\s+за|remind\s+me)\s+(\d{1,3})\s*(${DURATION_UNIT_RX})\s+(?:до|before)\s+(?:(?:событи[яе]|встречи|the\s+event|the\s+meeting|event|meeting)\s+)?([^;\n]{1,120})$`,
  triggers: ['напомни', 'remind'],
  bindings: {
    dur: { type: 'duration', from: '{{$1}}', unit: '{{$2}}', units: DURATION_UNITS, min: 1, max: 10080 },
    ref: eventRef('{{$3}}'),
  },
  steps: [
    ...resolveEvent(),
    ...confirmStep('q'),
    { call: 'set_reminder', input: { event_id: TARGET_ID, minutes_before: ['{{bind.dur}}'], scope: SCOPE } },
  ],
  strings: {
    ru: { q: 'Напомнить за {{bind.dur}} мин до {{t.target}}? Прежние напоминания этого события будут заменены.' },
    en: { q: 'Remind {{bind.dur}} min before {{t.target}}? Its existing reminders will be replaced.' },
  },
  examples: [
    'напомни за 15 минут до встречи с Иваном',
    'напомни мне за 1 час до события #12',
    'напомни за 30 мин до стендапа',
    'remind me 10 minutes before the meeting standup',
    'remind me 2 hours before event #7',
  ],
  negatives: ['напомни через 10 минут позвонить маме', 'напомни завтра в 10 купить молоко', 'remind me to call mom'],
  invalidInputs: ['напомни за 0 минут до встречи с Иваном', 'напомни за 15 минут до всех событий'],
  notes:
    'Reminders attach to a real event through set_reminder. Free-standing reminders have no tool and are not faked with events.',
};

const reminderList: FamilyDefinition = {
  name: 'basis.reminder.list',
  title: 'Show the reminders of an event',
  category: 'reminders',
  risk: 'read',
  pattern: String.raw`^(?:какие\s+напоминания\s+(?:у|для|перед)|напоминания\s+(?:для|у|перед)|show\s+reminders\s+for|reminders\s+for)\s+(?:(?:событи[яе]|встречи|event|meeting)\s+)?([^;\n]{1,120})$`,
  triggers: ['напоминания', 'reminders', 'show'],
  bindings: { ref: eventRef('{{$1}}') },
  steps: [...resolveEvent(), { call: 'get_reminders', input: { event_id: TARGET_ID, scope: SCOPE } }],
  strings: { ru: {}, en: {} },
  examples: [
    'какие напоминания у события #12',
    'напоминания для встречи с Иваном',
    'show reminders for event #7',
    'reminders for standup',
  ],
  negatives: ['напомни мне позвонить', 'напоминания'],
};

const reminderClear: FamilyDefinition = {
  name: 'basis.reminder.clear',
  title: 'Remove the reminders of one event',
  category: 'reminders',
  risk: 'write',
  pattern: String.raw`^(?:отмени|убери|удали|cancel|remove|clear)\s+(?:напоминани[яе]|reminders?)\s+(?:(?:для|у|for)\s+)?(?:(?:события|встречи|event|meeting)\s+)?([^;\n]{1,120})$`,
  triggers: ['отмени', 'убери', 'удали', 'cancel', 'remove', 'clear'],
  bindings: { ref: eventRef('{{$1}}') },
  steps: [
    ...resolveEvent(),
    ...confirmStep('q'),
    { call: 'set_reminder', input: { event_id: TARGET_ID, minutes_before: [], scope: SCOPE } },
  ],
  strings: {
    ru: { q: 'Убрать все напоминания у {{t.target}}?' },
    en: { q: 'Remove all reminders from {{t.target}}?' },
  },
  examples: [
    'отмени напоминания для события #12',
    'убери напоминания у встречи с Иваном',
    'clear reminders for event #7',
  ],
  negatives: ['отмени все напоминания', 'отмени напоминание'],
  invalidInputs: ['отмени напоминания у всех событий'],
};

const inviteSend: FamilyDefinition = {
  name: 'basis.invite.send',
  title: 'Invite a person to one of my events',
  category: 'invitations',
  risk: 'write',
  pattern: String.raw`^(?:пригласи|invite)\s+(@${USERNAME_RX}|\d{5,15})\s+(?:на|to)\s+${EVENT_NOUN_RX}\s+([^;\n]{1,120})$`,
  triggers: ['пригласи', 'invite'],
  bindings: { who: { type: 'recipient', from: '{{$1}}' }, ref: eventRef('{{$2}}') },
  steps: [
    guardPrivate(),
    ...resolveEvent(),
    ...confirmStep('q'),
    {
      when: "bind.who.kind == 'username'",
      call: 'send_invitation',
      input: { event_id: TARGET_ID, invitee_username: '{{bind.who.username}}' },
    },
    {
      when: "bind.who.kind == 'id'",
      call: 'send_invitation',
      input: { event_id: TARGET_ID, invitee_id: '{{bind.who.id}}' },
    },
  ],
  strings: {
    ru: { q: 'Отправить приглашение {{bind.who.label}} на {{t.target}}?' },
    en: { q: 'Send an invitation to {{bind.who.label}} for {{t.target}}?' },
  },
  examples: [
    'пригласи @ivan_petrov на событие #12',
    'пригласи 123456789 на встречу «Стендап»',
    'invite @anna_smith to event #7',
    'invite 987654321 to meeting Retro',
  ],
  negatives: [
    'пригласи Ивана на событие #12',
    'пригласи @ivan на событие #12',
    'не приглашай @ivan_petrov на событие #12',
  ],
  invalidInputs: ['пригласи @ivan_petrov на событие все'],
  notes:
    'Recipient must be an exact @username or numeric Telegram ID from the message; the invitation tool verifies it and force is never set.',
};

const inviteStatus: FamilyDefinition = {
  name: 'basis.invite.status',
  title: 'Who is invited to an event',
  category: 'invitations',
  risk: 'private_read',
  pattern: String.raw`^(?:кто\s+приглашен|кто\s+приглашён|статус\s+приглашений|invitation\s+status|who\s+is\s+invited)\s+(?:на|to|for)\s+(?:(?:событие|встречу|event|meeting)\s+)?([^;\n]{1,120})$`,
  triggers: ['приглашен', 'приглашён', 'статус', 'invitation', 'who'],
  bindings: { ref: eventRef('{{$1}}') },
  steps: [guardPrivate(), ...resolveEvent(), { call: 'get_invitation_status', input: { event_id: TARGET_ID } }],
  strings: { ru: {}, en: {} },
  examples: [
    'кто приглашен на событие #12',
    'статус приглашений на встречу с Иваном',
    'invitation status for event #7',
    'who is invited to standup',
  ],
  negatives: ['кто приглашен', 'статус приглашений'],
};

export const eventFamilies: FamilyDefinition[] = [
  eventCreate,
  eventShow,
  eventReschedule,
  eventRename,
  eventSetDetail,
  eventDelete,
  eventSnooze,
  eventHide,
  reminderSet,
  reminderList,
  reminderClear,
  inviteSend,
  inviteStatus,
];
