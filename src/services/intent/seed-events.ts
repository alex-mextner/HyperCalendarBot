// Changing, reading and inviting to ONE existing event. The event is named the way people name it ("йогу", "the dentist
// appointment", "#12"): the pattern of each rule only decides which request this is, the `eventref` binding finds the
// word the title is searched by, and the workflow stops unless exactly one event matches. Every write shows the exact
// event (title, day in words, time) in a yes/cancel question first and ends with a sentence saying what was done.
// A request the rule recognises but must not act on (nothing found, a bare hour, a past time, several events) goes to the AI.
import {
  abstainInGroup,
  alt,
  BULK_WORDS,
  COURTESY,
  confirmStep,
  DATE_SIGNAL,
  type FamilyDefinition,
  resolveEvent,
  resolveEventByName,
  SCOPE,
  type SeedStep,
  type SlotForm,
  slotForms,
  spanVocabulary,
  TIME_SIGNAL,
  USERNAME_RX,
  WB,
  WE,
} from './seed-fragments.ts';
import type { Binding } from './workflow-bindings.ts';

const eventRef = (from: string): Binding => ({ type: 'eventref', from, reject: BULK_WORDS, stem: true });
const TARGET_ID = '{{tool_outputs.target.id}}';
const TITLE = '{{tool_outputs.target.title}}';

// ─── shared pattern pieces ───────────────────────────────────────────────────

/** Words before the verb that change nothing ("щас удали ..."). */
const LEAD = String.raw`(?:(?:щас|сейчас|now)\s+)?`;
/** A noun that only says "an event"; the words after it name which one. */
const NOUN = String.raw`(?:(?:событи[еяю]|встреч[уаие]|мероприяти[еяю]|event|meeting|appointment)\s+)?`;
/** A mention of one event: no sentence punctuation, so a second clause never hides inside it. */
const REF = String.raw`[^;\n.?!,]{1,120}?`;

const LIST_WORDS = alt([
  'и',
  'а',
  'не',
  'нет',
  'потом',
  'затем',
  'также',
  'ещё',
  'еще',
  'and',
  'then',
  'also',
  'plus',
  'but',
  'not',
]);
/** One request: no list, no second clause, no negation. Anything else is for the AI. */
const SINGLE = `(?!.{0,200}(?:${WB}${LIST_WORDS}${WE}|[,;]))`;
/** The message names no day and no clock time: a request that does is a different rule's, or the AI's. */
const NO_WHEN = `(?!${DATE_SIGNAL})(?!${TIME_SIGNAL})`;
/** "all", "every": many events at once is never one rule's job. */
const NO_BULK = `(?!.{0,200}${WB}${alt(BULK_WORDS)}${WE})`;
const NO_REMINDER_WORD = `(?!.{0,200}${WB}(?:напоминани[а-я]*|reminders?)${WE})`;
/** Contacts and secretaries have rules of their own ("удали контакт", "добавь @x в секретари"); an event is never what they name. */
const NOT_PEOPLE_OR_ACCESS = `(?!.{0,200}${WB}(?:контакт[а-я]*|contacts?|секретар[а-я]*|secretar[a-z]*)${WE})`;
/** Checks on the whole message that every rule naming an existing event runs once, ahead of its phrasings. */
const EVENT_MENTION = `${NO_BULK}${NO_WHEN}${NOT_PEOPLE_OR_ACCESS}`;
const eventForms = (forms: readonly SlotForm[], slots: { [name: string]: string }) =>
  slotForms(forms, slots, EVENT_MENTION);

/** A clock time written with a day-part word ("8 вечера", "4pm") that TIME_SIGNAL does not see. */
const DAY_PART_SIGNAL = String.raw`(?=.{0,200}${WB}\d{1,2}(?::\d{2})?\s*(?:am|pm|утра|дня|вечера|ночи)${WE})`;
const WHEN_SIGNAL = `(?:${DATE_SIGNAL}|${TIME_SIGNAL}|${DAY_PART_SIGNAL})`;

const SPAN = spanVocabulary(true);
const SPAN_SLOTS = { amount: String.raw`\d{1,4}`, unit: SPAN.unit, bare: SPAN.bare };
/** "30 минут", "2 hours", "час", "half an hour". */
const spanOf = (slot: (name: string) => string): string =>
  String.raw`(?:${slot('amount')}\s*${slot('unit')}|${slot('bare')})`;

// ─── show ───────────────────────────────────────────────────────────────────

const showForms = eventForms(
  [
    (s) =>
      String.raw`(?:покажи|открой|выведи|дай|show|open)(?:\s+(?:мне|me))?\s+(?:событие|встречу|мероприятие|(?:the\s+)?event|(?:the\s+)?meeting)\s+(?!(?:про|о|об|about|with|с)\s)${SINGLE}${s('ref')}`,
  ],
  { ref: REF },
);

const eventShow: FamilyDefinition = {
  name: 'basis.event.show',
  title: 'Show one event by number or name',
  category: 'events',
  risk: 'read',
  pattern: showForms.pattern,
  triggers: ['покажи', 'открой', 'выведи', 'дай', 'show', 'open'],
  bindings: { ref: eventRef(showForms.read('ref')) },
  steps: resolveEvent(),
  strings: { ru: {}, en: {} },
  examples: [
    'покажи событие #12',
    'открой встречу «Стендап»',
    'show event #7',
    'open meeting "Retro"',
    'покажи событие Стоматолог',
  ],
  negatives: [
    'покажи событие про стендап',
    'покажи событие',
    'покажи события #12',
    'покажи событие завтра',
    'покажи событие все',
  ],
  invalidInputs: ['покажи событие встреча'],
};

// ─── reschedule ─────────────────────────────────────────────────────────────

const MOVE_VERB = alt([
  'перенеси',
  'перенести',
  'передвинь',
  'передвинуть',
  'перекинь',
  'перекинуть',
  'подвинь',
  'подвинуть',
  'сдвинь',
  'сдвинуть',
  'переставь',
  'reschedule',
  'move',
  'push',
  'shift',
  'bump',
]);
/** "на 30 минут", "by an hour": a shift by an amount is a snooze, not a move to a day or a time. */
const NOT_A_SHIFT = String.raw`(?!.{0,200}${WB}(?:на|by|for)\s+(?:\d{1,4}\s*(?:минут[а-я]*|мин|час[а-я]*|ч|min[a-z]*|hours?|hrs?|h)(?!\s*(?:дня|утра|вечера|ночи|am|pm))${WE}|час${WE}|полчаса|an?\s+hour|half\s+an?\s+hour))`;
/** A move to "earlier" or "later" has a direction this rule does not read. */
const NOT_A_DIRECTION = `(?!.{0,200}${WB}(?:позже|раньше|позднее|пораньше|later|earlier|sooner)${WE})`;

const moveForms = slotForms(
  [
    (s) =>
      String.raw`${LEAD}${MOVE_VERB}${COURTESY}\s+${NO_BULK}${NOT_A_SHIFT}${NOT_A_DIRECTION}${WHEN_SIGNAL}${SINGLE}${s('rest')}`,
  ],
  { rest: '.{1,160}' },
);

const eventReschedule: FamilyDefinition = {
  name: 'basis.event.reschedule',
  title: 'Move an event to another day and/or time',
  category: 'events',
  risk: 'write',
  pattern: moveForms.pattern,
  triggers: [
    'перенеси',
    'перенести',
    'передвинь',
    'передвинуть',
    'перекинь',
    'перекинуть',
    'подвинь',
    'подвинуть',
    'сдвинь',
    'сдвинуть',
    'переставь',
    'reschedule',
    'move',
    'push',
    'shift',
    'bump',
  ],
  // The words after the verb hold the event, a day and/or a time in any order; the event is read as a reference and
  // the day/time are cut out of it. `plan_move` then combines them with what the event has now.
  bindings: { ev: { type: 'event_phrase', from: moveForms.read('rest'), reference: true, reject: BULK_WORDS } },
  steps: [
    ...resolveEvent('bind.ev.ref'),
    {
      call: 'plan_move',
      input: {
        date: '{{tool_outputs.target.date|default("")}}',
        time: '{{tool_outputs.target.time|default("")}}',
        end_at: '{{tool_outputs.target.end_at|default("")}}',
        day: '{{bind.ev.date|default("")}}',
        at: '{{bind.ev.time|default("")}}',
      },
      as: 'plan',
    },
    ...confirmStep('q'),
    {
      when: 'has(tool_outputs.plan.end)',
      call: 'update_event',
      input: {
        event_id: TARGET_ID,
        start_at: '{{tool_outputs.plan.start}}',
        end_at: '{{tool_outputs.plan.end}}',
        scope: SCOPE,
      },
    },
    {
      when: 'has(tool_outputs.plan.end) == false',
      call: 'update_event',
      input: { event_id: TARGET_ID, start_at: '{{tool_outputs.plan.start}}', scope: SCOPE },
    },
    { respond: '{{t.done}}' },
  ],
  strings: {
    ru: {
      q: 'Перенести {{t.target}} на {{tool_outputs.plan.when_text}}?',
      done: `Готово: перенёс «${TITLE}» на {{tool_outputs.plan.when_text}}.`,
    },
    en: {
      q: 'Move {{t.target}} to {{tool_outputs.plan.when_text}}?',
      done: `Done: moved “${TITLE}” to {{tool_outputs.plan.when_text}}.`,
    },
  },
  examples: [
    'перенеси стендап на пятницу',
    'перенеси стендап на 11:00',
    'перекинь ретро на завтра в 16:00',
    'move standup to 3pm',
    'передвинь встречу #12 на 2026-10-05 в 15:30',
    'перенеси ужин с родителями на субботу в 19:30',
    'reschedule the dentist to Friday',
    'перенеси ревью на 8 вечера',
  ],
  negatives: [
    'перенеси все события на завтра в 10:30',
    'перенеси стендап',
    'перенеси стендап на 15 минут',
    'не переноси стендап на пятницу',
    'перенеси стендап на пятницу и удали ретро',
    'перенеси стендап на час позже',
    'move retro 30 minutes earlier',
  ],
  invalidInputs: [
    'перенеси стендап на пятницу в 10',
    'перенеси стендап на завтра в 3',
    'перенеси стендап на следующую пятницу',
    'move retro to friday at 99:00',
  ],
  notes:
    'A day alone keeps the event’s time, a time alone keeps its day; an event with an end keeps its length. Bare hours, the weekday of today, a past time, a skipped or repeated wall time and all-day events go to the AI.',
};

// ─── rename ─────────────────────────────────────────────────────────────────

const QUOTED_TITLE = String.raw`«[^»\n]{1,200}»|"[^"\n]{1,200}"|“[^”\n]{1,200}”`;
const renameForms = eventForms(
  [
    (s) =>
      String.raw`${LEAD}(?:переименуй|переименовать|rename)${COURTESY}\s+(?!.{0,200}\s(?:в|на|to|as)\s.{0,200}\s(?:в|на|to|as)\s)${NOUN}${s('ref')}\s+(?:в|на|to|as)\s+${s('title')}`,
    (s) => String.raw`${LEAD}(?:назови|назвать)${COURTESY}\s+${NOUN}${s('ref')}\s+${s('quoted')}`,
  ],
  { ref: REF, title: String.raw`[^;\n]{1,200}`, quoted: QUOTED_TITLE },
);

const eventRename: FamilyDefinition = {
  name: 'basis.event.rename',
  title: 'Rename an event',
  category: 'events',
  risk: 'write',
  pattern: renameForms.pattern,
  triggers: ['переименуй', 'переименовать', 'rename', 'назови', 'назвать'],
  bindings: {
    ref: eventRef(renameForms.read('ref')),
    title: {
      type: 'text',
      from: `${renameForms.read('title')}${renameForms.read('quoted')}`,
      max: 200,
      capitalize: true,
    },
  },
  steps: [
    ...resolveEvent(),
    ...confirmStep('q'),
    { call: 'update_event', input: { event_id: TARGET_ID, title: '{{bind.title}}', scope: SCOPE } },
    { respond: '{{t.done}}' },
  ],
  strings: {
    ru: {
      q: 'Переименовать {{t.target}} в «{{bind.title}}»?',
      done: `Готово: переименовал «${TITLE}» в «{{bind.title}}».`,
    },
    en: {
      q: 'Rename {{t.target}} to “{{bind.title}}”?',
      done: `Done: renamed “${TITLE}” to “{{bind.title}}”.`,
    },
  },
  examples: [
    'переименуй стендап в утренний синк',
    'переименуй событие #12 в Ретро',
    'переименуй встречу «Стендап» в «Планёрка»',
    'rename yoga to evening stretch',
    'назови ретро «ретроспектива спринта»',
  ],
  negatives: [
    'переименуй стендап',
    'переименуй событие #12',
    'переименуй йогу в пилатес и перенеси на завтра',
    'не переименовывай стендап в обед',
  ],
  invalidInputs: ['переименуй событие в обед', 'переименуй встречу в обед'],
};

// ─── set detail ─────────────────────────────────────────────────────────────

const FIELDS: { [word: string]: 'location' | 'description' } = {
  место: 'location',
  локацию: 'location',
  локация: 'location',
  адрес: 'location',
  описание: 'description',
  location: 'location',
  place: 'location',
  address: 'location',
  venue: 'location',
  description: 'description',
};
const RU_FIELD = alt(['место', 'локацию', 'локация', 'адрес', 'описание']);
const EN_FIELD = alt(['location', 'place', 'address', 'venue', 'description']);
/** The value must not carry a second command along ("... и перенеси на пятницу"). */
const NO_COMMAND_IN_VALUE = `(?!.{0,300}${WB}${alt(['перенеси', 'удали', 'создай', 'переименуй', 'пригласи', 'напомни', 'delete', 'move', 'create', 'rename', 'invite', 'remind'])}${WE})`;

const detailForms = slotForms(
  [
    (s) =>
      String.raw`${LEAD}(?:поставь|укажи|установи|задай|добавь|измени|поменяй|сделай|запиши)${COURTESY}\s+${s('field')}\s+(?:(?:для|у|к|на|в|от)\s+)?(?:(?:события|встречи|мероприятия)\s+)?${NO_COMMAND_IN_VALUE}${s('ref')}(?:\s*[:—–-]\s+|\s+(?:на|to)\s+)${s('value')}`,
    (s) =>
      String.raw`${LEAD}(?:set|change|update|add|put|edit)\s+(?:the\s+)?${s('field')}\s+(?:of|for|on|to)\s+(?:the\s+)?${NO_COMMAND_IN_VALUE}${s('ref')}(?:\s*:\s+|\s+(?:to|as)\s+)${s('value')}`,
    (s) =>
      String.raw`${LEAD}(?:set|change|update)\s+(?:the\s+)?${NO_COMMAND_IN_VALUE}${s('ref')}\s+${s('field')}\s+(?:to|as)\s+${s('value')}`,
  ],
  { ref: String.raw`[^;\n:—–]{1,120}?`, field: `${RU_FIELD}|${EN_FIELD}`, value: String.raw`[^;\n]{1,300}` },
);

const eventSetDetail: FamilyDefinition = {
  name: 'basis.event.set_detail',
  title: 'Set the location or description of an event',
  category: 'events',
  risk: 'write',
  pattern: detailForms.pattern,
  triggers: [
    'поставь',
    'укажи',
    'установи',
    'задай',
    'добавь',
    'измени',
    'поменяй',
    'сделай',
    'запиши',
    'set',
    'change',
    'update',
    'add',
    'put',
    'edit',
  ],
  bindings: {
    field: { type: 'enum', from: detailForms.read('field'), values: FIELDS },
    ref: eventRef(detailForms.read('ref')),
    value: { type: 'text', from: detailForms.read('value'), max: 300 },
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
    { respond: '{{t.done}}' },
  ],
  strings: {
    ru: {
      q: 'Поставить {{bind.field|eq("location","место","описание")}} у {{t.target}}: «{{bind.value}}»?',
      done: `Готово: у «${TITLE}» теперь {{bind.field|eq("location","место","описание")}}: «{{bind.value}}».`,
    },
    en: {
      q: 'Set the {{bind.field}} of {{t.target}} to “{{bind.value}}”?',
      done: `Done: the {{bind.field}} of “${TITLE}” is now “{{bind.value}}”.`,
    },
  },
  examples: [
    'поставь место для ужина с родителями: ресторан Дунав',
    'добавь описание к ретро: обсудить релиз и баги',
    'измени место события стендап на переговорка 3',
    'set the location of the dentist to Oak Street 12',
    'change description of the retro to Bring notes',
  ],
  negatives: ['измени место события', 'поставь место для стендапа', 'поставь место: офис', 'измени описание'],
};

// ─── delete ─────────────────────────────────────────────────────────────────

const DELETE_VERB = alt([
  'удали',
  'удалить',
  'удалите',
  'отмени',
  'отменить',
  'отмените',
  'убери',
  'убрать',
  'уберите',
  'сними',
  'снять',
  'выкинь',
  'выбрось',
  'снеси',
  'сотри',
  'delete',
  'remove',
  'cancel',
  'drop',
  'scrap',
]);
/** A polite explanation after the request ("... I can't make it") changes nothing about it. */
const REASON = String.raw`(?:i\s+can['’]?t\s+make\s+it|i\s+won['’]?t\s+(?:make\s+it|be\s+there))`;

/** The title before a trailing removal verb holds no command word of its own ("удали стрижку удали"). */
const NO_VERB_IN_REF = `(?!.{0,200}${WB}${DELETE_VERB}${WE}.{1,200}${WB}${DELETE_VERB}${WE})(?!(?:не|нет|no|don['’]?t)${WE})`;
const deleteForms = eventForms(
  [
    (s) =>
      String.raw`${LEAD}${DELETE_VERB}${COURTESY}\s+${NO_REMINDER_WORD}${SINGLE}${NOUN}${s('ref')}(?:[.?!]+\s*${REASON})?`,
    // Object first, verb last: "Стрижку убери", "Планёрку отмени". The title is the whole text before the verb.
    (s) =>
      String.raw`${LEAD}${NO_REMINDER_WORD}${SINGLE}${NO_VERB_IN_REF}${NOUN}${s('ref')}\s+${DELETE_VERB}(?:\s+(?:пожалуйста|please))?`,
  ],
  { ref: REF },
);

const eventDelete: FamilyDefinition = {
  name: 'basis.event.delete',
  title: 'Delete one event after confirmation',
  category: 'events',
  risk: 'write',
  pattern: deleteForms.pattern,
  triggers: [
    'удали',
    'удалить',
    'удалите',
    'отмени',
    'отменить',
    'отмените',
    'убери',
    'убрать',
    'уберите',
    'сними',
    'снять',
    'выкинь',
    'выбрось',
    'снеси',
    'сотри',
    'delete',
    'remove',
    'cancel',
    'drop',
    'scrap',
  ],
  bindings: { ref: eventRef(deleteForms.read('ref')) },
  steps: [
    ...resolveEvent(),
    ...confirmStep('q'),
    { call: 'delete_event', input: { event_id: TARGET_ID, scope: SCOPE } },
    { respond: '{{t.done}}' },
  ],
  strings: {
    ru: { q: 'Удалить {{t.target}}? Это нельзя отменить.', done: `Готово: удалил «${TITLE}».` },
    en: { q: 'Delete {{t.target}}? This cannot be undone.', done: `Done: deleted “${TITLE}”.` },
  },
  examples: [
    'удали стендап',
    'отмени встречу с Иваном',
    'убери йогу',
    'сними #12',
    'удали событие «Стендап»',
    'cancel my dentist',
    'remove the retro',
    'delete event #7',
  ],
  negatives: [
    'удали все события',
    'удали все встречи сегодня',
    'не удаляй событие #12',
    "don't cancel the dentist",
    'удали встречу завтра в 15:00',
    'удали стендап и создай созвон',
    'удали обед и ужин',
    'убери напоминания у йоги',
  ],
  invalidInputs: ['удали событие', 'удали встречи', 'delete the meeting'],
  notes:
    'A name that finds no event, a bare noun and several matches never delete anything: the first two go to the AI, the last lists the events by number. Messages with a day or time go to the AI.',
};

// ─── snooze ─────────────────────────────────────────────────────────────────

const SNOOZE_VERB = alt([
  'отложи',
  'отложить',
  'сдвинь',
  'сдвинуть',
  'подвинь',
  'подвинуть',
  'перенеси',
  'перенести',
  'передвинь',
  'перекинь',
  'snooze',
  'postpone',
  'delay',
  'push',
  'bump',
  'move',
  'shift',
]);
const snoozeForms = eventForms(
  [
    (s) =>
      String.raw`${LEAD}${SNOOZE_VERB}${COURTESY}\s+${SINGLE}${NOUN}${s('ref')}\s+(?:на|by|for)\s+${spanOf(s)}(?:\s+(?:позже|later))?`,
  ],
  { ref: REF, ...SPAN_SLOTS },
);

const eventSnooze: FamilyDefinition = {
  name: 'basis.event.snooze',
  title: 'Shift an event later by minutes or hours',
  category: 'events',
  risk: 'write',
  pattern: snoozeForms.pattern,
  triggers: [
    'отложи',
    'отложить',
    'сдвинь',
    'сдвинуть',
    'подвинь',
    'подвинуть',
    'перенеси',
    'перенести',
    'передвинь',
    'перекинь',
    'snooze',
    'postpone',
    'delay',
    'push',
    'bump',
    'move',
    'shift',
  ],
  bindings: {
    ref: eventRef(snoozeForms.read('ref')),
    dur: {
      type: 'duration',
      from: snoozeForms.read('amount'),
      unit: `${snoozeForms.read('unit')}${snoozeForms.read('bare')}`,
      units: SPAN.table,
      default_amount: 1,
      min: 1,
      max: 1440,
    },
  },
  steps: [
    ...resolveEvent(),
    ...confirmStep('q'),
    { call: 'snooze_event', input: { event_id: TARGET_ID, minutes: '{{bind.dur}}', scope: SCOPE } },
    { respond: '{{t.done}}' },
  ],
  strings: {
    ru: {
      q: 'Сдвинуть {{t.target}} на {{bind.dur|human_duration}} позже?',
      done: `Готово: сдвинул «${TITLE}» на {{bind.dur|human_duration}} позже.`,
    },
    en: {
      q: 'Move {{t.target}} {{bind.dur|human_duration}} later?',
      done: `Done: moved “${TITLE}” {{bind.dur|human_duration}} later.`,
    },
  },
  examples: [
    'сдвинь тренировку на 30 минут позже',
    'отложи событие #12 на 15 минут',
    'сдвинь стендап на час позже',
    'подвинь тренировку на 15 минут',
    'snooze the client call by 20 minutes',
    'postpone meeting standup for 1 hour',
    'перенеси событие «Ретро» на 30 мин',
  ],
  negatives: [
    'отложи событие #12',
    'отложи событие #12 на потом',
    'сдвинь стендап на 15 минут раньше',
    'сдвинь все встречи на час',
    'отложи стендап на 15 минут и ретро на 10',
  ],
  invalidInputs: ['отложи событие #12 на 0 минут', 'отложи событие #12 на 3000 минут'],
};

// ─── hide ───────────────────────────────────────────────────────────────────

const hideForms = eventForms(
  [
    (s) => String.raw`${LEAD}(?:скрой|скрыть|спрячь|спрятать|hide)${COURTESY}\s+${SINGLE}${NOUN}${s('ref')}`,
    (s) =>
      String.raw`${LEAD}(?:сделай|сделать|make)\s+${SINGLE}${NOUN}${s('ref')}\s+(?:приватн[а-я]*|скрыт[а-я]*|private|hidden)`,
  ],
  { ref: REF },
);

const eventHide: FamilyDefinition = {
  name: 'basis.event.hide',
  title: 'Make an event private',
  category: 'events',
  risk: 'write',
  pattern: hideForms.pattern,
  triggers: ['скрой', 'скрыть', 'спрячь', 'спрятать', 'hide', 'сделай', 'сделать', 'make'],
  bindings: { ref: eventRef(hideForms.read('ref')) },
  steps: [
    abstainInGroup(),
    ...resolveEvent(),
    ...confirmStep('q'),
    { call: 'set_event_visibility', input: { event_id: TARGET_ID, visibility: 'private' } },
    { respond: '{{t.done}}' },
  ],
  strings: {
    ru: {
      q: 'Сделать {{t.target}} приватным? Другие перестанут его видеть.',
      done: `Готово: сделал «${TITLE}» приватным.`,
    },
    en: {
      q: 'Make {{t.target}} private? Others will stop seeing it.',
      done: `Done: “${TITLE}” is now private.`,
    },
  },
  examples: [
    'скрой стендап',
    'скрой событие #12',
    'спрячь встречу с врачом',
    'hide the retro',
    'make the dentist private',
    'сделай йогу приватной',
  ],
  negatives: ['покажи событие всем', 'скрой все события', 'не скрывай событие #12', 'скрой стендап и ретро'],
  invalidInputs: ['скрой событие', 'hide the meeting'],
  notes: 'Only narrows visibility. Widening it (full details for everyone) is never triggered by chat phrasing.',
};

// ─── reminders of an event ──────────────────────────────────────────────────

const REMINDER_SPAN = spanVocabulary(true);
const reminderSetForms = eventForms(
  [
    (s) =>
      String.raw`${LEAD}(?:напомни(?:\s+мне)?|напоминай(?:\s+мне)?|поставь\s+напоминание|добавь\s+напоминание|установи\s+напоминание|сделай\s+напоминание|включи\s+напоминание)${COURTESY}\s+за\s+${spanOf(s)}\s+до\s+${SINGLE}${NOUN}${s('ref')}`,
    (s) => String.raw`за\s+${spanOf(s)}\s+до\s+${SINGLE}${NOUN}${s('ref')}\s+(?:напомни|напоминай)(?:\s+мне)?`,
    (s) =>
      String.raw`${LEAD}(?:remind\s+me|set\s+(?:a\s+)?reminder|add\s+(?:a\s+)?reminder|ping\s+me|notify\s+me)${COURTESY}\s+${spanOf(s)}\s+(?:before|ahead\s+of|prior\s+to)\s+${SINGLE}${NOUN}${s('ref')}`,
  ],
  { ref: REF, ...SPAN_SLOTS },
);

const reminderSet: FamilyDefinition = {
  name: 'basis.reminder.set',
  title: 'Remind before an event',
  category: 'reminders',
  risk: 'write',
  pattern: reminderSetForms.pattern,
  triggers: [
    'напомни',
    'напоминай',
    'поставь',
    'добавь',
    'установи',
    'сделай',
    'включи',
    'за',
    'remind',
    'set',
    'add',
    'ping',
    'notify',
  ],
  bindings: {
    dur: {
      type: 'duration',
      from: reminderSetForms.read('amount'),
      unit: `${reminderSetForms.read('unit')}${reminderSetForms.read('bare')}`,
      units: REMINDER_SPAN.table,
      default_amount: 1,
      min: 1,
      max: 10080,
    },
    ref: eventRef(reminderSetForms.read('ref')),
  },
  steps: [
    ...resolveEvent(),
    ...confirmStep('q'),
    { call: 'set_reminder', input: { event_id: TARGET_ID, minutes_before: ['{{bind.dur}}'], scope: SCOPE } },
    { respond: '{{t.done}}' },
  ],
  strings: {
    ru: {
      q: 'Напомнить за {{bind.dur|human_duration}} до {{t.target}}? Прежние напоминания этого события заменятся.',
      done: `Готово: напомню за {{bind.dur|human_duration}} до «${TITLE}».`,
    },
    en: {
      q: 'Remind you {{bind.dur|human_duration}} before {{t.target}}? Its existing reminders will be replaced.',
      done: `Done: I will remind you {{bind.dur|human_duration}} before “${TITLE}”.`,
    },
  },
  examples: [
    'напомни за 15 минут до стендапа',
    'напомни мне за час до события #12',
    'за день до дня рождения Ани напомни',
    'поставь напоминание за час до стоматолога',
    'remind me 30 minutes before the dentist',
    'напоминай за 10 минут до ретро',
  ],
  negatives: [
    'напомни через 10 минут позвонить маме',
    'напомни завтра в 10 купить молоко',
    'remind me to call mom',
    'напомни за 15 минут',
    'напомни за 15 минут до всех событий',
  ],
  invalidInputs: ['напомни за 0 минут до стендапа', 'напомни за 30 дней до стендапа'],
  notes:
    'Reminders attach to a real event through set_reminder, replacing its earlier ones. A free-standing reminder after a delay is basis.reminder.after.',
};

const reminderListForms = eventForms(
  [
    (s) =>
      String.raw`(?:какие\s+(?:есть\s+)?напоминания\s+(?:у|для|на|перед|к|стоят\s+(?:у|на|для))|(?:покажи|скажи|выведи|дай|открой)(?:\s+мне)?\s+(?:все\s+)?напоминания\s+(?:у|для|на|перед|к)|напоминания\s+(?:для|у|на|перед|к)|есть\s+ли\s+напоминания\s+(?:у|для|на|перед))\s+${SINGLE}${NOUN}${s('ref')}`,
    (s) =>
      String.raw`(?:(?:what|which)\s+reminders\s+(?:does|do|are\s+(?:set\s+)?(?:on|for)|is\s+set\s+(?:on|for))|(?:show|list|get|tell)(?:\s+me)?\s+(?:the\s+|all\s+)?reminders\s+(?:for|of|on)|reminders\s+(?:for|of|on)|do\s+i\s+have\s+(?:any\s+)?reminders\s+(?:for|on))\s+${SINGLE}${NOUN}${s('ref')}(?:\s+(?:have|has))?`,
  ],
  { ref: REF },
);

const reminderList: FamilyDefinition = {
  name: 'basis.reminder.list',
  title: 'Show the reminders of an event',
  category: 'reminders',
  risk: 'read',
  pattern: reminderListForms.pattern,
  triggers: [
    'какие',
    'покажи',
    'скажи',
    'выведи',
    'дай',
    'открой',
    'напоминания',
    'есть',
    'what',
    'which',
    'show',
    'list',
    'get',
    'tell',
    'reminders',
    'do',
  ],
  bindings: { ref: eventRef(reminderListForms.read('ref')) },
  steps: [...resolveEvent(), { call: 'get_reminders', input: { event_id: TARGET_ID, scope: SCOPE } }],
  strings: { ru: {}, en: {} },
  examples: [
    'какие напоминания у стендапа',
    'напоминания для встречи с Иваном',
    'какие напоминания у события #12',
    'what reminders does the dentist have',
    'show reminders for event #7',
    'reminders for standup',
  ],
  negatives: ['напомни мне позвонить', 'напоминания', 'какие напоминания', 'покажи все напоминания'],
  invalidInputs: ['какие напоминания у события'],
};

const reminderClearForms = eventForms(
  [
    (s) =>
      String.raw`${LEAD}(?:отмени|убери|удали|сними|очисти|сотри|отключи|cancel|remove|clear|delete|turn\s+off|disable)${COURTESY}\s+(?:все\s+|all\s+)?(?:мои\s+|my\s+|the\s+)?(?:напоминани[яейю]|reminders?)\s+(?:(?:для|у|на|со|с|к|for|from|on|of)\s+)?${SINGLE}${NOUN}${s('ref')}`,
  ],
  { ref: REF },
);

const reminderClear: FamilyDefinition = {
  name: 'basis.reminder.clear',
  title: 'Remove the reminders of one event',
  category: 'reminders',
  risk: 'write',
  pattern: reminderClearForms.pattern,
  triggers: [
    'отмени',
    'убери',
    'удали',
    'сними',
    'очисти',
    'сотри',
    'отключи',
    'cancel',
    'remove',
    'clear',
    'delete',
    'turn',
    'disable',
  ],
  bindings: { ref: eventRef(reminderClearForms.read('ref')) },
  steps: [
    ...resolveEvent(),
    ...confirmStep('q'),
    { call: 'set_reminder', input: { event_id: TARGET_ID, minutes_before: [], scope: SCOPE } },
    { respond: '{{t.done}}' },
  ],
  strings: {
    ru: { q: 'Убрать все напоминания у {{t.target}}?', done: `Готово: убрал напоминания у «${TITLE}».` },
    en: {
      q: 'Remove all reminders from {{t.target}}?',
      done: `Done: removed the reminders of “${TITLE}”.`,
    },
  },
  examples: [
    'убери напоминания у йоги',
    'отмени напоминания для события #12',
    'remove reminders from gym',
    'clear reminders for event #7',
    'удали напоминание у встречи с Иваном',
  ],
  negatives: [
    'отмени все напоминания',
    'отмени напоминание',
    'убери напоминания на завтра',
    'удали напоминания у стендапа и ретро',
  ],
  invalidInputs: ['отмени напоминания у события'],
};

// ─── invitations ────────────────────────────────────────────────────────────

const WHO = String.raw`@${USERNAME_RX}|\d{5,15}`;
const inviteForms = eventForms(
  [
    (s) =>
      String.raw`${LEAD}(?:пригласи|пригласить|приглашай|позови|позвать|добавь|добавить|инвайтни|invite|add)${COURTESY}\s+${s('who')}\s+(?:на|в|to|for|in|into)\s+${SINGLE}${NOUN}${s('ref')}`,
    (s) =>
      String.raw`${LEAD}(?:кинь|скинь|отправь|отправить|пошли|послать|шли|send)\s+(?:an?\s+)?(?:инвайт|приглашение|invitation|invite)\s+(?:to\s+)?${s('who')}\s+(?:(?:на|в|to|for)\s+)?${SINGLE}${NOUN}${s('ref')}`,
    (s) =>
      String.raw`${LEAD}(?:кинь|скинь|отправь|отправить|пошли|послать|шли|send)\s+(?:инвайт|приглашение|invitation|invite)\s+(?:на|в|to|for)\s+${SINGLE}${NOUN}${s('ref')}\s+${s('who')}`,
  ],
  { who: WHO, ref: REF },
);

const inviteSend: FamilyDefinition = {
  name: 'basis.invite.send',
  title: 'Invite a person to one of my events',
  category: 'invitations',
  risk: 'write',
  pattern: inviteForms.pattern,
  triggers: [
    'пригласи',
    'пригласить',
    'приглашай',
    'позови',
    'позвать',
    'добавь',
    'добавить',
    'инвайтни',
    'кинь',
    'скинь',
    'отправь',
    'отправить',
    'пошли',
    'послать',
    'шли',
    'invite',
    'add',
    'send',
  ],
  bindings: { who: { type: 'recipient', from: inviteForms.read('who') }, ref: eventRef(inviteForms.read('ref')) },
  steps: [
    abstainInGroup(),
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
    { respond: '{{t.done}}' },
  ],
  strings: {
    ru: {
      q: 'Отправить приглашение {{bind.who.label}} на {{t.target}}?',
      done: `Готово: отправил приглашение {{bind.who.label}} на «${TITLE}».`,
    },
    en: {
      q: 'Send an invitation to {{bind.who.label}} for {{t.target}}?',
      done: `Done: sent {{bind.who.label}} an invitation to “${TITLE}”.`,
    },
  },
  examples: [
    'пригласи @ivan_petrov на ретро',
    'позови @anna_smith на ужин с родителями',
    'кинь инвайт @mark_t1 на обед с Иваном',
    'добавь @ivan_petrov в йогу',
    'отправь приглашение на планирование спринта @mark_t1',
    'invite @mark_t1 to the retro',
    'send an invitation to @ivan_petrov for the design review',
    'пригласи 123456789 на встречу «Стендап»',
  ],
  negatives: [
    'пригласи Ивана на событие #12',
    'пригласи @ivan на событие #12',
    'не приглашай @ivan_petrov на событие #12',
    'пригласи @ivan_petrov',
    'пригласи @ivan_petrov на ретро завтра в 15:00',
    'пригласи @ivan_petrov и @anna_smith на ретро',
  ],
  invalidInputs: ['пригласи @ivan_petrov на событие', 'invite @ivan_petrov to the meeting'],
  notes:
    'Recipient must be an exact @username or numeric Telegram ID from the message; the invitation tool verifies it and force is never set.',
};

/** A get_invitation_status step for `eventId`, run only when `when` holds. */
const invitationStatusStep = (eventId: string, when: string): SeedStep => ({
  when,
  call: 'get_invitation_status',
  input: { event_id: eventId },
});

const statusForms = eventForms(
  [
    (s) =>
      String.raw`(?:кто\s+(?:приглашен\S*|приглашал\S*|ответил\S*|принял\S*|придет|пойдет|идет|будет)|(?:какой\s+)?статус\s+приглашени\S+|как\s+(?:дела|успехи)\s+с\s+приглашени\S+)\s+(?:(?:на|в|для|по|к)\s+)?(?:приглашени\S+\s+(?:на|в|для)\s+)?${SINGLE}${NOUN}${s('ref')}`,
    (s) =>
      String.raw`(?:who\s+(?:is|was|are|has\s+been)\s+invited|who\s+(?:is\s+)?(?:coming|going|attending)|who\s+(?:answered|accepted|replied\s+to|responded\s+to)|has\s+anyone\s+(?:answered|accepted|replied\s+to|responded\s+to)|(?:invitation|invite)\s+status|status\s+of\s+(?:the\s+)?(?:invitations?|invites?))\s+(?:(?:to|for|on|at|of)\s+)?(?:(?:the\s+)?(?:invitations?|invites?)\s+(?:to|for|on)\s+)?${SINGLE}${NOUN}${s('ref')}`,
  ],
  { ref: REF },
);

const inviteStatus: FamilyDefinition = {
  name: 'basis.invite.status',
  title: 'Who is invited to an event',
  category: 'invitations',
  risk: 'private_read',
  pattern: statusForms.pattern,
  triggers: ['кто', 'статус', 'какой', 'как', 'who', 'has', 'invitation', 'invite', 'status'],
  bindings: { ref: eventRef(statusForms.read('ref')) },
  // A number goes straight to get_invitation_status, which admits invitees as well as the owner;
  // get_event would turn an invitee away first. A title is searched in the actor's own calendar.
  steps: [
    abstainInGroup(),
    invitationStatusStep('{{bind.ref.id}}', "bind.ref.kind == 'id'"),
    ...resolveEventByName(),
    invitationStatusStep(TARGET_ID, "bind.ref.kind == 'name'"),
  ],
  strings: { ru: {}, en: {} },
  examples: [
    'статус приглашений на стендап',
    'кто приглашен на событие #12',
    'кто ответил на приглашение на день рождения Ани',
    'кто приглашён на ужин с родителями',
    'has anyone answered the invite for the retro',
    'who is invited to standup',
    'invitation status for event #7',
  ],
  negatives: ['кто приглашен', 'статус приглашений', 'кто приглашен на все встречи'],
  invalidInputs: ['кто приглашен на событие'],
};

export const eventFamilies: FamilyDefinition[] = [
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
