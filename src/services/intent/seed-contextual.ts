import {
  ANY_DAY_RX,
  alt,
  BULK_WORDS,
  DAY_WORDS,
  DURATION_UNITS,
  type FamilyDefinition,
  phraseTable,
  resolveEvent,
  SCOPE,
  type SeedStep,
  TIME_RX,
} from './seed-fragments.ts';
import type { Binding } from './workflow-bindings.ts';

/**
 * Rules that act on an event named by the conversation ("delete it", "the second one", "the one
 * I just created") or change its time relative to what it is now. A context phrase only nominates
 * a candidate: it is re-read with get_event, shown with its title, number and time, confirmed,
 * and read again right before the write. A different read aborts instead of writing.
 */

const IT = [
  'его',
  'её',
  'ее',
  'это',
  'этот',
  'эту',
  'это событие',
  'эту встречу',
  'этот ивент',
  'это мероприятие',
  'эту запись',
  'it',
  'this',
  'that',
  'this event',
  'that event',
  'this meeting',
  'that meeting',
];
const CREATED = [
  'последнее',
  'последнее событие',
  'последнюю встречу',
  'последнее созданное',
  'последнее созданное событие',
  'только что созданное',
  'last one',
  'the last one',
  'last event',
  'the last event',
  'the one i just created',
];
const ORDINALS: (readonly [string[], number])[] = [
  [['первое', 'первую', 'первое событие', 'первую встречу', 'first', 'the first one', 'first one'], 1],
  [['второе', 'вторую', 'второе событие', 'вторую встречу', 'second', 'the second one', 'second one'], 2],
  [['третье', 'третью', 'третье событие', 'третью встречу', 'third', 'the third one', 'third one'], 3],
  [['четвертое', 'четвёртое', 'четвертую', 'четвёртую', 'fourth', 'the fourth one'], 4],
  [['пятое', 'пятую', 'fifth', 'the fifth one'], 5],
];
const CONTEXT = phraseTable<'it' | 'created' | number>([[IT, 'it'], [CREATED, 'created'], ...ORDINALS]);
const REF_RX = alt([...IT, ...CREATED, ...ORDINALS.flatMap(([phrases]) => phrases)]);
const FROM_LIST_RX = String.raw`(?:\s+(?:из\s+списка|from\s+the\s+list))?`;
const NOUN_PREFIX_RX = String.raw`(?:(?:событие|встречу|event|meeting)\s+)?`;
/** A context phrase, a number or quoted title, or a short free title; never an explicit event noun first. */
const TARGET_RX = String.raw`(?!(?:событие|встречу|event|meeting|на|by|to)\s)(${REF_RX}|(?:#|№)\d{1,9}|«[^»\n]{1,120}»|"[^"\n]{1,120}"|[^\s;\n][^;\n]{0,119}?)`;

const contextRef = (from: string, names: boolean): Binding => ({
  type: 'eventref',
  from,
  reject: BULK_WORDS,
  context: CONTEXT,
  blank: 'it',
  names,
});
const TARGET_ID = '{{tool_outputs.target.id}}';
const MOVED = 'tool_outputs.moved';
const notCleared = "ask.confirm != 'да' && ask.confirm != 'yes'";

/** Stop with an explanation unless the reference names exactly one candidate, then re-read it as `target`. */
function contextTarget(): SeedStep[] {
  return [
    { when: "bind.ref.kind == 'missing' && bind.ref.reason == 'gone'", respond: '{{t.ctx_gone}}' },
    { when: "bind.ref.kind == 'missing' && bind.ref.reason == 'range'", respond: '{{t.ctx_range}}' },
    { when: "bind.ref.kind == 'missing'", respond: '{{t.ctx_none}}' },
    { when: "bind.ref.kind == 'choices'", respond: '{{t.ctx_pick}}' },
    ...resolveEvent(),
  ];
}

/** Read the confirmed event again; any change since the question aborts instead of writing. */
function recheck(): SeedStep[] {
  return [
    { call: 'get_event', input: { event_id: TARGET_ID, scope: SCOPE }, as: 'current' },
    { when: 'same(tool_outputs.target, tool_outputs.current) == false', respond: '{{t.changed}}' },
  ];
}

function confirm(questionKey: string, when?: string): SeedStep {
  return {
    ...(when ? { when } : {}),
    call: 'ask_user',
    input: { question: `{{t.${questionKey}}}`, options: ['{{t.ok}}', '{{t.cancel}}'] },
    as: 'confirm|lower',
  };
}

const allDayGuard: SeedStep = { when: 'tool_outputs.target.all_day == true', respond: '{{t.all_day}}' };
const writeMoved: SeedStep = {
  call: 'update_event',
  input: { event_id: TARGET_ID, start_at: `{{${MOVED}.start_at}}`, end_at: `{{${MOVED}.end_at}}`, scope: SCOPE },
};

const CONTEXT_STRINGS = {
  ru: {
    ctx_none:
      'Не понял, о каком событии речь. Назови его точнее — названием в кавычках или номером, например #12. Ничего не менял.',
    ctx_gone: 'Этого события уже нет или оно тебе больше недоступно — ничего не менял.',
    ctx_range: 'В последнем списке нет события с таким номером — ничего не менял.',
    ctx_pick:
      'Подходит несколько событий:\n{{bind.ref.text}}\nУточни, какое именно — например, «{{t.pick_example}}», или назови номер #id.',
    changed:
      'Пока ты подтверждал, событие изменилось, поэтому я ничего не сделал. Сейчас оно такое: «{{tool_outputs.current.title}}» (#{{tool_outputs.current.id}}, {{tool_outputs.current.date}} {{tool_outputs.current.time|default("")}}). Повтори команду, если всё ещё нужно.',
    all_day: 'Это событие на весь день — сдвигать его по времени я не буду. Напиши новую дату целиком.',
  },
  en: {
    ctx_none:
      "I'm not sure which event you mean. Name it by its quoted title or number, like #12. Nothing was changed.",
    ctx_gone: 'That event no longer exists or is no longer available to you — nothing was changed.',
    ctx_range: 'The last list has no event with that number — nothing was changed.',
    ctx_pick:
      'Several events fit:\n{{bind.ref.text}}\nSay which one — for example “{{t.pick_example}}” — or give its number #id.',
    changed:
      'The event changed while you were confirming, so I did nothing. It now is: “{{tool_outputs.current.title}}” (#{{tool_outputs.current.id}}, {{tool_outputs.current.date}} {{tool_outputs.current.time|default("")}}). Repeat the request if you still want it.',
    all_day: 'This is an all-day event — I will not shift it by time. Send the new date in full.',
  },
};

const MULTIPART_NEGATIVES = [
  'удали его и пригласи алекса',
  'отмени это событие и отправь алексу уведомление',
  'Удали. И поправь мне тайм зону',
];

const deleteContext: FamilyDefinition = {
  name: 'basis.event.delete_context',
  title: 'Delete the event just discussed, just created or picked from the last list',
  category: 'events',
  risk: 'write',
  pattern: String.raw`^(?:(?:удали|delete)\s*\.?|(?:удали|отмени|убери|delete|cancel|remove)\s+(${REF_RX})${FROM_LIST_RX}\s*\.?)$`,
  triggers: ['удали', 'отмени', 'убери', 'delete', 'cancel', 'remove'],
  bindings: { ref: contextRef('{{$1|default("")}}', false) },
  steps: [
    ...contextTarget(),
    confirm('q'),
    { when: notCleared, respond: '{{t.cancelled}}' },
    ...recheck(),
    { call: 'delete_event', input: { event_id: TARGET_ID, scope: SCOPE } },
  ],
  strings: {
    ru: { ...CONTEXT_STRINGS.ru, q: 'Удалить {{t.target}}? Это нельзя отменить.', pick_example: 'удали второе' },
    en: {
      ...CONTEXT_STRINGS.en,
      q: 'Delete {{t.target}}? This cannot be undone.',
      pick_example: 'delete the second one',
    },
  },
  examples: [
    'удали его',
    'удали последнее',
    'Удали.',
    'отмени это событие',
    'удали второе из списка',
    'delete it',
    'cancel this meeting',
    'delete the last one',
  ],
  negatives: [...MULTIPART_NEGATIVES, 'не удаляй его', 'удали все', 'удали его пожалуйста потом'],
  notes:
    'Deleting an event the user only attends is not offered here: the reference is re-read from the calendar the user can change, so an attended event is reported as unavailable instead of being declined under a delete label.',
};

const showContext: FamilyDefinition = {
  name: 'basis.event.show_context',
  title: 'Show the event just discussed or picked from the last list',
  category: 'events',
  risk: 'read',
  pattern: String.raw`^(?:(?:покажи|открой|show|open)\s+(${REF_RX})${FROM_LIST_RX}|что\s+это\s+за\s+(?:событие|ивент|встреча|мероприятие)|what\s+is\s+this\s+event)$`,
  triggers: ['покажи', 'открой', 'show', 'open', 'что', 'what'],
  bindings: { ref: contextRef('{{$1|default("")}}', false) },
  steps: contextTarget(),
  strings: {
    ru: { ...CONTEXT_STRINGS.ru, pick_example: 'покажи второе' },
    en: { ...CONTEXT_STRINGS.en, pick_example: 'show the second one' },
  },
  examples: ['покажи его', 'покажи второе', 'что это за ивент', 'show it', 'show the first one from the list'],
  negatives: ['покажи все', 'покажи его и удали'],
};

const moveContext: FamilyDefinition = {
  name: 'basis.event.move_context',
  title: 'Move an event to another day, keeping its time and duration unless a time is given',
  category: 'events',
  risk: 'write',
  pattern: String.raw`^(?:перенеси|передвинь|move|reschedule)(?:\s+${TARGET_RX})?\s+(?:на|to)\s+(${ANY_DAY_RX})(?:\s+(?:в|на|at)\s+(${TIME_RX}))?\s*\.?$`,
  triggers: ['перенеси', 'передвинь', 'move', 'reschedule'],
  bindings: {
    ref: contextRef('{{$1|default("")}}', true),
    d: { type: 'date', from: '{{$2}}', words: DAY_WORDS, future: true },
    at: { type: 'time', from: '{{$3|default("")}}', optional: true, default: '' },
  },
  steps: [
    ...contextTarget(),
    allDayGuard,
    {
      call: 'event_time',
      input: { event: '{{tool_outputs.target}}', day: '{{bind.d}}', at: '{{bind.at}}' },
      as: 'moved',
    },
    confirm('q'),
    { when: notCleared, respond: '{{t.cancelled}}' },
    ...recheck(),
    writeMoved,
  ],
  strings: {
    ru: {
      ...CONTEXT_STRINGS.ru,
      q: `Перенести {{t.target}} на {{${MOVED}.date}} {{${MOVED}.time}}?`,
      pick_example: 'перенеси второе на завтра',
    },
    en: {
      ...CONTEXT_STRINGS.en,
      q: `Move {{t.target}} to {{${MOVED}.date}} {{${MOVED}.time}}?`,
      pick_example: 'move the second one to tomorrow',
    },
  },
  examples: [
    'перенеси его на завтра',
    'перенеси это на послезавтра в 11:00',
    'перенеси последнее на 5 октября',
    'перенеси стендап на завтра',
    'перенеси на завтра',
    'move it to tomorrow',
    'move the first one to 2026-10-05 at 3pm',
  ],
  negatives: [
    'перенеси событие стендап на завтра в 11:00',
    'перенеси его на завтра и уведоми всех',
    'не переноси его на завтра',
  ],
  invalidInputs: ['перенеси все на завтра', 'перенеси его на завтра в 3'],
  notes:
    'A day move keeps the wall-clock time (10:00 stays 10:00 across a clock change) and the elapsed duration; an event with an explicit start in the past or an all-day event is not moved.',
};

const moveContextHour: FamilyDefinition = {
  name: 'basis.event.move_context_hour',
  title: 'Move the event just discussed to a bare hour, asking morning or evening',
  category: 'events',
  risk: 'write',
  pattern: String.raw`^(?:перенеси|передвинь|move)(?:\s+(${REF_RX}))?\s+(?:на|to)\s+(\d{1,2})\s*\.?$`,
  triggers: ['перенеси', 'передвинь', 'move'],
  bindings: {
    ref: contextRef('{{$1|default("")}}', false),
    am: { type: 'time', from: '{{$2}} am' },
    pm: { type: 'time', from: '{{$2}} pm' },
  },
  steps: [
    ...contextTarget(),
    allDayGuard,
    {
      call: 'ask_user',
      input: { question: '{{t.q}}', options: ['{{bind.am}}', '{{bind.pm}}', '{{t.cancel}}'] },
      as: 'at',
    },
    { when: 'ask.at != bind.am && ask.at != bind.pm', respond: '{{t.cancelled}}' },
    { call: 'event_time', input: { event: '{{tool_outputs.target}}', at: '{{ask.at}}' }, as: 'moved' },
    ...recheck(),
    writeMoved,
  ],
  strings: {
    ru: {
      ...CONTEXT_STRINGS.ru,
      q: 'Во сколько перенести {{t.target}} в тот же день: {{bind.am}} или {{bind.pm}}?',
      pick_example: 'перенеси второе на 3',
    },
    en: {
      ...CONTEXT_STRINGS.en,
      q: 'What time should {{t.target}} move to on the same day: {{bind.am}} or {{bind.pm}}?',
      pick_example: 'move the second one to 3',
    },
  },
  examples: ['перенеси на 12', 'перенеси его на 3', 'move it to 5'],
  negatives: ['перенеси все на 3', 'перенеси его на 3 и уведоми всех'],
  invalidInputs: ['перенеси его на 13'],
  notes:
    'A bare hour is never guessed: both readings are offered, and choosing one is the confirmation of the named target.',
};

const SHIFT_UNITS = { ...DURATION_UNITS, ...phraseTable([[['полчаса', 'half an hour'], 30]]) };
const SHIFT_UNIT_RX = alt([...Object.keys(DURATION_UNITS), 'полчаса', 'half an hour']);
const DIRECTIONS = phraseTable([
  [['раньше', 'пораньше', 'earlier'], 'earlier'],
  [['позже', 'попозже', 'позднее', 'later'], 'later'],
]);

const shiftContext: FamilyDefinition = {
  name: 'basis.event.shift_context',
  title: 'Move an event earlier or later by a number of minutes or hours',
  category: 'events',
  risk: 'write',
  pattern: String.raw`^(?:перенеси|сдвинь|передвинь|подвинь|move|shift)(?:\s+${NOUN_PREFIX_RX}${TARGET_RX})?\s+(?:на\s+|by\s+)?(?:an?\s+)?(\d{1,4})?\s*(${SHIFT_UNIT_RX})\s+(раньше|пораньше|позже|попозже|позднее|earlier|later)\s*\.?$`,
  triggers: ['перенеси', 'сдвинь', 'передвинь', 'подвинь', 'move', 'shift'],
  bindings: {
    ref: contextRef('{{$1|default("")}}', true),
    dur: {
      type: 'duration',
      from: '{{$2|default("")}}',
      unit: '{{$3}}',
      units: SHIFT_UNITS,
      default_amount: 1,
      max: 10080,
    },
    dir: { type: 'enum', from: '{{$4}}', values: DIRECTIONS },
  },
  steps: [
    ...contextTarget(),
    allDayGuard,
    {
      call: 'event_time',
      input: { event: '{{tool_outputs.target}}', shift: { minutes: '{{bind.dur}}', direction: '{{bind.dir}}' } },
      as: 'moved',
    },
    confirm('q'),
    { when: notCleared, respond: '{{t.cancelled}}' },
    ...recheck(),
    writeMoved,
  ],
  strings: {
    ru: {
      ...CONTEXT_STRINGS.ru,
      q: `Сдвинуть {{t.target}} на {{${MOVED}.date}} {{${MOVED}.time}}?`,
      pick_example: 'сдвинь второе на час позже',
    },
    en: {
      ...CONTEXT_STRINGS.en,
      q: `Move {{t.target}} to {{${MOVED}.date}} {{${MOVED}.time}}?`,
      pick_example: 'move the second one an hour later',
    },
  },
  examples: [
    'перенеси завтрак на час позже',
    'перенеси его на час раньше',
    'сдвинь это на 30 минут позже',
    'сдвинь его на полчаса пораньше',
    'сдвинь встречу стендап на 15 минут раньше',
    'move it an hour later',
    'shift the last one by 30 minutes earlier',
  ],
  negatives: ['сдвинь все на час позже', 'перенеси его на час позже и уведоми всех', 'не сдвигай его на час позже'],
  invalidInputs: ['сдвинь все на час позже'],
};

const RESIZE_DIRECTIONS = phraseTable([
  [['длиннее', 'дольше', 'продли', 'удлини', 'longer', 'extend'], 'longer'],
  [['короче', 'сократи', 'укороти', 'shorter', 'shorten'], 'shorter'],
]);

const resizeContext: FamilyDefinition = {
  name: 'basis.event.resize_context',
  title: 'Make an event longer or shorter by changing only its end',
  category: 'events',
  risk: 'write',
  pattern: String.raw`^(?:(?:сделай|make)(?:\s+${TARGET_RX})?\s+(?:на\s+)?(?:an?\s+)?(\d{1,4})?\s*(${SHIFT_UNIT_RX})\s+(длиннее|дольше|короче|longer|shorter)|(продли|удлини|сократи|укороти|extend|shorten)(?:\s+${NOUN_PREFIX_RX}${TARGET_RX})?\s+(?:на|by)\s+(?:an?\s+)?(\d{1,4})?\s*(${SHIFT_UNIT_RX}))\s*\.?$`,
  triggers: ['сделай', 'make', 'продли', 'удлини', 'сократи', 'укороти', 'extend', 'shorten'],
  bindings: {
    ref: contextRef('{{$1|default("")}}{{$6|default("")}}', true),
    dur: {
      type: 'duration',
      from: '{{$2|default("")}}{{$7|default("")}}',
      unit: '{{$3|default("")}}{{$8|default("")}}',
      units: SHIFT_UNITS,
      default_amount: 1,
      max: 1440,
    },
    dir: { type: 'enum', from: '{{$4|default("")}}{{$5|default("")}}', values: RESIZE_DIRECTIONS },
  },
  steps: [
    ...contextTarget(),
    allDayGuard,
    {
      call: 'event_time',
      input: { event: '{{tool_outputs.target}}', resize: { minutes: '{{bind.dur}}', direction: '{{bind.dir}}' } },
      as: 'moved',
    },
    confirm('q', `${MOVED}.assumed_default == false`),
    confirm('q_default', `${MOVED}.assumed_default == true`),
    { when: notCleared, respond: '{{t.cancelled}}' },
    ...recheck(),
    writeMoved,
  ],
  strings: {
    ru: {
      ...CONTEXT_STRINGS.ru,
      q: `Сделать {{t.target}} до {{${MOVED}.end_time}} — всего {{${MOVED}.minutes}} мин?`,
      q_default: `У {{t.target}} не указан конец, поэтому считаю от длительности по умолчанию ({{${MOVED}.default_minutes}} мин). Сделать его до {{${MOVED}.end_time}} — всего {{${MOVED}.minutes}} мин?`,
      pick_example: 'продли второе на 30 минут',
    },
    en: {
      ...CONTEXT_STRINGS.en,
      q: `Make {{t.target}} end at {{${MOVED}.end_time}} — {{${MOVED}.minutes}} min in total?`,
      q_default: `{{t.target}} has no end, so I count from your default duration ({{${MOVED}.default_minutes}} min). Make it end at {{${MOVED}.end_time}} — {{${MOVED}.minutes}} min in total?`,
      pick_example: 'extend the second one by 30 minutes',
    },
  },
  examples: [
    'сделай его на 30 минут длиннее',
    'сделай это на 15 минут короче',
    'продли его на 30 минут',
    'сократи стендап на 15 минут',
    'make it 30 minutes longer',
    'extend it by an hour',
    'shorten the last one by 15 minutes',
  ],
  negatives: ['продли все на час', 'продли его на 30 минут и уведоми всех', 'не продлевай его на 30 минут'],
  invalidInputs: ['продли все на час'],
  notes:
    'Only the end moves. An event without an end is measured from the default duration, and the question says so; a result that would end at or before the start is refused.',
};

export const contextualFamilies: FamilyDefinition[] = [
  deleteContext,
  showContext,
  moveContext,
  moveContextHour,
  shiftContext,
  resizeContext,
];
