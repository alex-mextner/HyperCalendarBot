import {
  alt,
  confirmStep,
  DURATION_UNIT_RX,
  DURATION_UNITS,
  type FamilyDefinition,
  guardPrivate,
  phraseTable,
  type SeedStep,
  TIME_RX,
  USERNAME_RX,
} from './seed-fragments.ts';

const NAME_REF_RX = String.raw`(«[^»\n]{1,80}»|"[^"\n]{1,80}"|[^\s"«»@]{1,40})`;
const GOOGLE_RX = String.raw`(?:google|гугл)(?:\s*(?:calendar|календарь))?`;

/** A contact named by the user must match exactly one saved contact before anything is changed. */
function resolveContact(refBinding: string): SeedStep[] {
  return [
    { call: 'find_contact', input: { name: `{{bind.${refBinding}}}` }, as: 'found' },
    { when: 'count(found.matches) != 1', respond: '{{t.not_unique}}' },
  ];
}

const CONTACT_STRINGS = {
  ru: { not_unique: 'Нашёл несколько контактов — назови точнее:\n{{tool_outputs.found_text}}' },
  en: { not_unique: 'Several contacts match — be more specific:\n{{tool_outputs.found_text}}' },
};

const contactsList: FamilyDefinition = {
  name: 'basis.contacts.list',
  title: 'List my contacts',
  category: 'contacts',
  risk: 'private_read',
  pattern: String.raw`^(?:(?:покажи\s+)?(?:мои\s+)?контакты|список\s+контактов|show\s+(?:my\s+)?contacts|list\s+(?:my\s+)?contacts|my\s+contacts|address\s+book)$`,
  triggers: ['контакты', 'покажи', 'мои', 'contacts', 'address'],
  steps: [guardPrivate(), { call: 'get_contacts', input: {} }],
  strings: { ru: {}, en: {} },
  examples: ['покажи мои контакты', 'мои контакты', 'список контактов', 'show my contacts', 'address book'],
  negatives: ['покажи контакты всем', 'не показывай мои контакты', 'контакты Ивана'],
  notes: 'Refuses in a group before reading; the tool is never called with force.',
};

const contactsFind: FamilyDefinition = {
  name: 'basis.contacts.find',
  title: 'Find a contact by name',
  category: 'contacts',
  risk: 'private_read',
  pattern: String.raw`^(?:найди|поищи|find|search(?:\s+for)?)\s+(?:контакт|contact)\s+(.{1,80})$`,
  triggers: ['найди', 'поищи', 'find', 'search'],
  bindings: { q: { type: 'text', from: '{{$1}}', max: 80 } },
  steps: [guardPrivate(), { call: 'find_contact', input: { name: '{{bind.q}}' } }],
  strings: { ru: {}, en: {} },
  examples: ['найди контакт Иван', 'поищи контакт @ivan_petrov', 'find contact Anna', 'search for contact Smith'],
  negatives: ['найди контакт', 'найди Ивана'],
};

const contactsAdd: FamilyDefinition = {
  name: 'basis.contacts.add',
  title: 'Save a contact',
  category: 'contacts',
  risk: 'write',
  pattern: String.raw`^(?:добавь|сохрани|add|save)\s+(?:контакт|contact)\s+([^@\n]{1,80}?)(?:\s+@(${USERNAME_RX}))?$`,
  triggers: ['добавь', 'сохрани', 'add', 'save'],
  bindings: {
    name: { type: 'text', from: '{{$1}}', max: 80 },
    username: { type: 'text', from: '{{$2|default("")}}', max: 32, optional: true, default: '' },
  },
  steps: [
    guardPrivate(),
    { when: "bind.username == ''", call: 'add_contact', input: { name: '{{bind.name}}' } },
    {
      when: "bind.username != ''",
      call: 'add_contact',
      input: { name: '{{bind.name}}', username: '{{bind.username}}' },
    },
  ],
  strings: { ru: {}, en: {} },
  examples: [
    'добавь контакт Иван Петров',
    'сохрани контакт Анна @anna_smith',
    'add contact Mark Twain',
    'save contact Lena @lena_k5',
  ],
  negatives: ['добавь контакт', 'не добавляй контакт Иван'],
  notes: 'The username is verified by the contact tool against the message text; a guessed username cannot be saved.',
};

const contactsRename: FamilyDefinition = {
  name: 'basis.contacts.rename',
  title: 'Rename a contact',
  category: 'contacts',
  risk: 'write',
  pattern: String.raw`^(?:переименуй|rename)\s+(?:контакт|contact)\s+${NAME_REF_RX}\s+(?:в|на|to|as)\s+(.{1,80})$`,
  triggers: ['переименуй', 'rename'],
  bindings: { old: { type: 'text', from: '{{$1}}', max: 80 }, new: { type: 'text', from: '{{$2}}', max: 80 } },
  steps: [
    guardPrivate(),
    ...resolveContact('old'),
    ...confirmStep('q'),
    { call: 'update_contact', input: { search: '{{bind.old}}', name: '{{bind.new}}' } },
  ],
  strings: {
    ru: { ...CONTACT_STRINGS.ru, q: 'Переименовать контакт «{{bind.old}}» в «{{bind.new}}»?' },
    en: { ...CONTACT_STRINGS.en, q: 'Rename contact “{{bind.old}}” to “{{bind.new}}”?' },
  },
  examples: ['переименуй контакт Иван в Ваня', 'переименуй контакт «Анна Смит» в Аня', 'rename contact Mark to Marcus'],
  negatives: ['переименуй контакт Иван', 'переименуй всех контактов в Иван'],
};

const contactsSetUsername: FamilyDefinition = {
  name: 'basis.contacts.set_username',
  title: 'Set the username of a contact',
  category: 'contacts',
  risk: 'write',
  pattern: String.raw`^(?:укажи|поменяй|установи|set|change)\s+(?:ник|username|юзернейм)\s+(?:контакта|for\s+contact|of\s+contact)\s+${NAME_REF_RX}\s+(?:на|to)\s+@(${USERNAME_RX})$`,
  triggers: ['укажи', 'поменяй', 'установи', 'set', 'change'],
  bindings: { who: { type: 'text', from: '{{$1}}', max: 80 }, user: { type: 'text', from: '{{$2}}', max: 32 } },
  steps: [
    guardPrivate(),
    ...resolveContact('who'),
    ...confirmStep('q'),
    { call: 'update_contact', input: { search: '{{bind.who}}', username: '{{bind.user}}' } },
  ],
  strings: {
    ru: { ...CONTACT_STRINGS.ru, q: 'Указать @{{bind.user}} контакту «{{bind.who}}»?' },
    en: { ...CONTACT_STRINGS.en, q: 'Set @{{bind.user}} for contact “{{bind.who}}”?' },
  },
  examples: [
    'укажи ник контакта Иван на @ivan_petrov',
    'поменяй username контакта «Анна Смит» на @anna_smith',
    'set username for contact Mark to @mark_t1',
  ],
  negatives: ['укажи ник контакта Иван на ivan_petrov', 'укажи ник контакта Иван'],
};

const contactsDelete: FamilyDefinition = {
  name: 'basis.contacts.delete',
  title: 'Delete one contact after confirmation',
  category: 'contacts',
  risk: 'write',
  pattern: String.raw`^(?:удали|delete|remove)\s+(?:контакт|contact)\s+(.{1,80})$`,
  triggers: ['удали', 'delete', 'remove'],
  bindings: { q: { type: 'text', from: '{{$1}}', max: 80 } },
  steps: [
    guardPrivate(),
    ...resolveContact('q'),
    ...confirmStep('q_confirm'),
    { call: 'delete_contact', input: { contact_id: '{{tool_outputs.found.matches[0].id}}' } },
  ],
  strings: {
    ru: {
      ...CONTACT_STRINGS.ru,
      q_confirm: 'Удалить контакт «{{tool_outputs.found.matches[0].name}}»? Это нельзя отменить.',
    },
    en: {
      ...CONTACT_STRINGS.en,
      q_confirm: 'Delete contact “{{tool_outputs.found.matches[0].name}}”? This cannot be undone.',
    },
  },
  examples: ['удали контакт Иван Петров', 'delete contact Anna', 'remove contact Smith'],
  negatives: ['удали все контакты', 'удали контакт', 'не удаляй контакт Иван'],
  notes: 'A query that matches more than one contact is refused with the candidates; there is no bulk deletion.',
};

const settingsView: FamilyDefinition = {
  name: 'basis.settings.view',
  title: 'Show my settings',
  category: 'settings',
  risk: 'private_read',
  pattern: String.raw`^(?:(?:покажи\s+)?(?:мои\s+)?настройки|show\s+(?:my\s+)?settings|my\s+settings)(?:\s+(уведомлений|общие|голоса|приватности|notifications|general|voice|privacy))?$`,
  triggers: ['настройки', 'settings', 'покажи', 'мои', 'show', 'my'],
  bindings: {
    cat: {
      type: 'enum',
      from: '{{$1|default("")}}',
      values: phraseTable([
        [['уведомлений', 'notifications'], 'notifications'],
        [['общие', 'general'], 'general'],
        [['голоса', 'voice'], 'voice'],
        [['приватности', 'privacy'], 'privacy'],
      ]),
      optional: true,
      default: 'all',
    },
  },
  steps: [
    guardPrivate(),
    { when: "bind.cat == 'all'", call: 'manage_settings', input: { action: 'get' } },
    { when: "bind.cat != 'all'", call: 'manage_settings', input: { action: 'get', category: '{{bind.cat}}' } },
  ],
  strings: { ru: {}, en: {} },
  examples: [
    'покажи мои настройки',
    'мои настройки',
    'настройки уведомлений',
    'show my settings',
    'my settings privacy',
  ],
  negatives: ['настройки погоды', 'покажи чужие настройки'],
};

const TOGGLE_ON = [
  [['включи', 'enable', 'turn on'], true],
  [['выключи', 'отключи', 'disable', 'turn off', 'не присылай'], false],
] as const;
const TOGGLE_FEATURES = [
  [['утреннюю сводку', 'утренние уведомления', 'morning agenda', 'morning digest'], 'morning'],
  [['вечерний обзор', 'вечернюю сводку', 'evening review', 'evening digest'], 'evening'],
  [['тихие часы', 'тихий режим', 'quiet hours'], 'quiet'],
  [['голосовые ответы', 'voice replies', 'voice responses'], 'voice'],
] as const;

function toggleStep(feature: string, category: string, key: string): SeedStep {
  return {
    when: `bind.feature == '${feature}'`,
    call: 'manage_settings',
    input: { action: 'update', category, updates: { [key]: '{{bind.on}}' } },
  };
}

const settingsToggle: FamilyDefinition = {
  name: 'basis.settings.toggle',
  title: 'Turn a notification or voice setting on or off',
  category: 'settings',
  risk: 'write',
  pattern: String.raw`^(${alt(TOGGLE_ON.flatMap(([phrases]) => phrases))})\s+(${alt(TOGGLE_FEATURES.flatMap(([phrases]) => phrases))})$`,
  triggers: ['включи', 'выключи', 'отключи', 'enable', 'disable', 'turn', 'не'],
  bindings: {
    on: { type: 'enum', from: '{{$1}}', values: phraseTable(TOGGLE_ON) },
    feature: { type: 'enum', from: '{{$2}}', values: phraseTable(TOGGLE_FEATURES) },
  },
  steps: [
    guardPrivate(),
    toggleStep('morning', 'notifications', 'morning_agenda_enabled'),
    toggleStep('evening', 'notifications', 'evening_review_enabled'),
    toggleStep('quiet', 'notifications', 'quiet_hours_enabled'),
    toggleStep('voice', 'voice', 'voice_response_enabled'),
  ],
  strings: { ru: {}, en: {} },
  examples: [
    'включи утреннюю сводку',
    'выключи вечерний обзор',
    'отключи тихие часы',
    'не присылай утреннюю сводку',
    'включи голосовые ответы',
    'disable morning agenda',
    'turn on quiet hours',
  ],
  negatives: ['не включай утреннюю сводку', 'включи всё', 'выключи голосовые ответы навсегда'],
};

const AGENDA_FEATURES = [
  [['утреннюю сводку', 'morning agenda', 'morning digest'], 'morning'],
  [['вечерний обзор', 'вечернюю сводку', 'evening review', 'evening digest'], 'evening'],
] as const;

const settingsAgendaTime: FamilyDefinition = {
  name: 'basis.settings.agenda_time',
  title: 'Set when the morning or evening summary arrives',
  category: 'settings',
  risk: 'write',
  pattern: String.raw`^(?:поставь|установи|set)\s+(${alt(AGENDA_FEATURES.flatMap(([phrases]) => phrases))})\s+(?:на|в|at|to)\s+(${TIME_RX})$`,
  triggers: ['поставь', 'установи', 'set'],
  bindings: {
    feature: { type: 'enum', from: '{{$1}}', values: phraseTable(AGENDA_FEATURES) },
    at: { type: 'time', from: '{{$2}}' },
  },
  steps: [
    guardPrivate(),
    {
      when: "bind.feature == 'morning'",
      call: 'manage_settings',
      input: { action: 'update', category: 'notifications', updates: { morning_agenda_time: '{{bind.at}}' } },
    },
    {
      when: "bind.feature == 'evening'",
      call: 'manage_settings',
      input: { action: 'update', category: 'notifications', updates: { evening_review_time: '{{bind.at}}' } },
    },
  ],
  strings: { ru: {}, en: {} },
  examples: [
    'поставь утреннюю сводку на 08:30',
    'установи вечерний обзор в 21:00',
    'set morning agenda at 7:45',
    'set evening review to 9pm',
  ],
  negatives: ['поставь утреннюю сводку', 'поставь сводку на 08:30'],
  invalidInputs: ['поставь утреннюю сводку на 8'],
};

const settingsDuration: FamilyDefinition = {
  name: 'basis.settings.duration',
  title: 'Set the default event duration',
  category: 'settings',
  risk: 'write',
  pattern: String.raw`^(?:поставь|установи|сделай|set)\s+(?:длительность\s+событи[яй]\s+по\s+умолчанию|стандартную\s+длительность(?:\s+событи[яй])?|default\s+event\s+duration)\s+(?:на\s+|to\s+)?(\d{1,4})\s*(${DURATION_UNIT_RX})$`,
  triggers: ['поставь', 'установи', 'сделай', 'set'],
  bindings: {
    dur: { type: 'duration', from: '{{$1}}', unit: '{{$2}}', units: DURATION_UNITS, min: 5, max: 1440 },
  },
  steps: [
    guardPrivate(),
    {
      call: 'manage_settings',
      input: { action: 'update', category: 'general', updates: { default_event_duration_minutes: '{{bind.dur}}' } },
    },
  ],
  strings: { ru: {}, en: {} },
  examples: [
    'поставь длительность события по умолчанию 45 минут',
    'сделай стандартную длительность 1 час',
    'установи стандартную длительность события на 30 мин',
    'set default event duration to 90 minutes',
  ],
  negatives: ['поставь длительность события по умолчанию', 'сделай стандартную длительность'],
  invalidInputs: [
    'поставь длительность события по умолчанию 0 минут',
    'поставь длительность события по умолчанию 3 минут',
  ],
};

const LANGUAGES = [
  [['русский', 'russian', 'ru'], 'ru'],
  [['английский', 'english', 'en'], 'en'],
] as const;
const LANGUAGE_LABELS = [
  [['русский', 'russian', 'ru'], 'Русский'],
  [['английский', 'english', 'en'], 'English'],
] as const;

const settingsLanguage: FamilyDefinition = {
  name: 'basis.settings.language',
  title: 'Switch the bot language',
  category: 'settings',
  risk: 'write',
  pattern: String.raw`^(?:(?:переключи|смени|поставь|set|switch|change)\s+(?:язык|language)(?:\s+(?:на|to))?|(?:переключись|switch)\s+(?:на|to))\s+(${alt(LANGUAGES.flatMap(([phrases]) => phrases))})$`,
  triggers: ['переключи', 'переключись', 'смени', 'поставь', 'set', 'switch', 'change'],
  bindings: {
    lang: { type: 'enum', from: '{{$1}}', values: phraseTable(LANGUAGES) },
    label: { type: 'enum', from: '{{$1}}', values: phraseTable(LANGUAGE_LABELS) },
  },
  steps: [
    guardPrivate(),
    {
      call: 'manage_settings',
      input: { action: 'update', category: 'general', updates: { language: '{{bind.lang}}' } },
    },
    { respond: '✓ {{bind.label}}' },
  ],
  strings: { ru: {}, en: {} },
  examples: [
    'switch to russian',
    'переключи язык на английский',
    'смени язык на русский',
    'switch language to english',
    'set language ru',
  ],
  negatives: ['переключи язык на французский', 'переключи язык'],
};

const settingsTimezone: FamilyDefinition = {
  name: 'basis.settings.timezone',
  title: 'Set my timezone from an IANA name',
  category: 'settings',
  risk: 'write',
  pattern: String.raw`^(?:мой\s+часовой\s+пояс|установи\s+часовой\s+пояс|поставь\s+часовой\s+пояс|set\s+(?:my\s+)?timezone(?:\s+to)?)\s+([A-Za-z][A-Za-z0-9_+/-]{1,60})$`,
  triggers: ['часовой', 'timezone', 'установи', 'поставь', 'мой', 'set'],
  bindings: { tz: { type: 'timezone', from: '{{$1}}' } },
  steps: [
    guardPrivate(),
    ...confirmStep('q'),
    { call: 'manage_settings', input: { action: 'update', category: 'general', updates: { timezone: '{{bind.tz}}' } } },
  ],
  strings: {
    ru: { q: 'Сменить часовой пояс на {{bind.tz}}? Все времена будут показываться в нём.' },
    en: { q: 'Change your timezone to {{bind.tz}}? All times will be shown in it.' },
  },
  examples: [
    'мой часовой пояс Europe/Belgrade',
    'установи часовой пояс Asia/Tokyo',
    'set my timezone to America/New_York',
    'set timezone UTC',
  ],
  negatives: ['мой часовой пояс Москва', 'мой часовой пояс'],
  invalidInputs: ['мой часовой пояс Foo/Bar'],
  notes: 'Only exact IANA names are accepted; offsets and city names are left to the assistant to clarify.',
};

const historySearch: FamilyDefinition = {
  name: 'basis.history.search',
  title: 'Search the chat history',
  category: 'history',
  risk: 'private_read',
  pattern: String.raw`^(?:найди\s+в\s+истории|поищи\s+в\s+истории|search\s+(?:my\s+)?history\s+for|history\s+search)\s+(.{1,100})$|^(?:покажи\s+(?:нашу\s+переписку|историю(?:\s+чата)?)|show\s+(?:our|my)\s+chat\s+history)$`,
  triggers: ['найди', 'поищи', 'search', 'history', 'покажи', 'show'],
  bindings: { q: { type: 'text', from: '{{$1|default("")}}', max: 100, optional: true, default: '' } },
  steps: [
    guardPrivate(),
    { when: "bind.q == ''", call: 'get_history', input: { limit: 10 } },
    { when: "bind.q != ''", call: 'get_history', input: { search: '{{bind.q}}', limit: 10 } },
  ],
  strings: { ru: {}, en: {} },
  examples: [
    'найди в истории отпуск',
    'show my chat history',
    'поищи в истории билеты',
    'search history for invoice',
    'history search dentist',
  ],
  negatives: ['найди в истории', 'найди в интернете отпуск'],
};

const actionLogRecent: FamilyDefinition = {
  name: 'basis.actionlog.recent',
  title: 'Show what the bot changed recently',
  category: 'history',
  risk: 'private_read',
  pattern: String.raw`^(?:что\s+ты\s+(?:сделал|менял)|журнал\s+действий|последние\s+действия|action\s+log|recent\s+actions|what\s+did\s+you\s+do)(?:\s+(\d{1,2}))?$`,
  triggers: ['что', 'журнал', 'последние', 'action', 'recent', 'what'],
  bindings: {
    limit: { type: 'integer', from: '{{$1|default("")}}', min: 1, max: 30, optional: true, default: 10 },
  },
  steps: [guardPrivate(), { call: 'get_action_log', input: { limit: '{{bind.limit}}' } }],
  strings: { ru: {}, en: {} },
  examples: ['что ты сделал', 'журнал действий', 'последние действия 5', 'action log', 'recent actions 20'],
  negatives: ['что ты сделал вчера вечером с проектом', 'журнал'],
  invalidInputs: ['журнал действий 0'],
};

const memoryRemember: FamilyDefinition = {
  name: 'basis.memory.remember',
  title: 'Remember a fact when explicitly asked',
  category: 'memory',
  risk: 'write',
  pattern: String.raw`^(?:запомни(?:,?\s+что)?[:,]?|remember\s+that[:,]?)\s+(.{5,300})$`,
  triggers: ['запомни', 'remember'],
  bindings: { fact: { type: 'text', from: '{{$1}}', max: 300 } },
  steps: [guardPrivate(), { call: 'remember_user_fact', input: { type: 'append', content: '{{bind.fact}}' } }],
  strings: { ru: {}, en: {} },
  examples: [
    'запомни, что я живу в Белграде',
    'запомни: у меня аллергия на орехи',
    'запомни мою жену зовут Анна',
    'remember that I prefer morning meetings',
  ],
  negatives: ['не запоминай это', 'remember to buy milk', 'запомни'],
  notes: 'Only an explicit request appends a fact; the memory is never rewritten by chat phrasing.',
};

const timeNow: FamilyDefinition = {
  name: 'basis.time.now',
  title: 'Current time here or in a city',
  category: 'utility',
  risk: 'read',
  pattern: String.raw`^(?:время|который\s+час|сколько\s+(?:сейчас\s+)?времени|what\s+time\s+is\s+it|current\s+time)(?:\s+(?:в|in)\s+([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё\s.'-]{1,40}))?$`,
  triggers: ['час', 'времени', 'время', 'time'],
  bindings: { city: { type: 'text', from: '{{$1|default("")}}', max: 40, optional: true, default: '' } },
  steps: [
    { when: "bind.city == ''", call: 'get_timezone_info', input: { timezone: '{{user.timezone}}' } },
    { when: "bind.city != ''", call: 'get_timezone_info', input: { timezone: '{{bind.city}}' } },
  ],
  strings: { ru: {}, en: {} },
  examples: [
    'который час',
    'сколько сейчас времени',
    'сколько времени в Токио',
    'what time is it',
    'current time in Tokyo',
  ],
  negatives: ['сколько времени займёт дорога до офиса завтра утром', 'который час в 123'],
};

const timeConvert: FamilyDefinition = {
  name: 'basis.time.convert',
  title: 'Convert my clock time today to another timezone',
  category: 'utility',
  risk: 'read',
  pattern: String.raw`^(?:переведи|конвертируй|convert)\s+(${TIME_RX})\s+(?:в|to)\s+(?:время\s+)?(UTC|[A-Za-z][A-Za-z0-9_+-]*(?:/[A-Za-z0-9_+-]+){1,2})$`,
  triggers: ['переведи', 'конвертируй', 'convert'],
  bindings: {
    d: { type: 'date', from: 'today', words: { today: 'today' } },
    at: { type: 'time', from: '{{$1}}' },
    when: { type: 'datetime', date: 'd', time: 'at' },
    tz: { type: 'timezone', from: '{{$2}}' },
  },
  steps: [
    { call: 'convert_to_timezone', input: { datetime: '{{bind.when}}', timezone: '{{bind.tz}}' }, as: 'c' },
    { respond: '{{t.out}}' },
  ],
  strings: {
    ru: { out: '{{tool_outputs.c.local_datetime}} ({{tool_outputs.c.timezone}})' },
    en: { out: '{{tool_outputs.c.local_datetime}} ({{tool_outputs.c.timezone}})' },
  },
  examples: [
    'переведи 15:00 в Asia/Tokyo',
    'переведи 15:00 в UTC',
    'конвертируй 9:30 в время Europe/London',
    'convert 3pm to America/New_York',
  ],
  negatives: ['переведи 15:00 в Токио', 'переведи текст в Asia/Tokyo'],
  invalidInputs: ['переведи 3 в Asia/Tokyo'],
  notes: 'Today in my own timezone, resolved through the zone rules; a skipped or repeated local time is rejected.',
};

const calc: FamilyDefinition = {
  name: 'basis.calc.evaluate',
  title: 'Evaluate an arithmetic expression',
  category: 'utility',
  risk: 'read',
  pattern: String.raw`^(?:посчитай|вычисли|сколько\s+будет|calculate|calc|compute)\s+([0-9+*/().\s-]{1,100})$`,
  triggers: ['посчитай', 'вычисли', 'сколько', 'calculate', 'calc', 'compute'],
  bindings: { expr: { type: 'text', from: '{{$1}}', max: 100 } },
  steps: [{ call: 'calculate', input: { expression: '{{bind.expr}}' } }],
  strings: { ru: {}, en: {} },
  examples: ['посчитай 12*(3+4)', 'вычисли 100/8', 'сколько будет 2+2', 'calculate 15*200/100', 'calc 7*6'],
  negatives: ['посчитай мои расходы', 'calculate my taxes', 'посчитай'],
};

const googleStatus: FamilyDefinition = {
  name: 'basis.google.status',
  title: 'Is Google Calendar connected',
  category: 'google',
  risk: 'private_read',
  pattern: String.raw`^(?:подключен\s+ли\s+(?:у\s+меня\s+)?${GOOGLE_RX}|статус\s+${GOOGLE_RX}|синхронизируется\s+ли\s+${GOOGLE_RX}|is\s+google\s+calendar\s+(?:connected|syncing)|google\s+calendar\s+status)$`,
  triggers: ['подключен', 'статус', 'синхронизируется', 'google', 'is'],
  steps: [guardPrivate(), { call: 'get_google_calendar_status', input: {} }],
  strings: { ru: {}, en: {} },
  examples: [
    'подключен ли google календарь',
    'подключен ли у меня гугл',
    'статус google calendar',
    'синхронизируется ли google календарь',
    'is google calendar connected',
  ],
  negatives: ['подключи google календарь', 'подключен ли принтер'],
};

const googleCalendars: FamilyDefinition = {
  name: 'basis.google.calendars',
  title: 'List my Google calendars',
  category: 'google',
  risk: 'private_read',
  pattern: String.raw`^(?:покажи\s+(?:мои\s+)?(?:google|гугл)\s*календари|какие\s+у\s+меня\s+(?:google|гугл)\s*календари|list\s+(?:my\s+)?google\s+calendars|show\s+(?:my\s+)?google\s+calendars)$`,
  triggers: ['покажи', 'какие', 'list', 'show'],
  steps: [guardPrivate(), { call: 'list_google_calendars', input: {} }],
  strings: { ru: {}, en: {} },
  examples: [
    'покажи мои google календари',
    'какие у меня гугл календари',
    'list my google calendars',
    'show google calendars',
  ],
  negatives: ['покажи календари друзей', 'не показывай google календари'],
};

const googleConnectHelp: FamilyDefinition = {
  name: 'basis.google.connect_help',
  title: 'How to connect, reconnect or disconnect Google Calendar',
  category: 'google',
  risk: 'read',
  pattern: String.raw`^(?:как\s+(?:подключить|переподключить|отключить)\s+${GOOGLE_RX}|хочу\s+подключить\s+${GOOGLE_RX}|(?:отключи|переподключи)\s+(?:мой\s+)?${GOOGLE_RX}|how\s+(?:do\s+i|to)\s+(?:re)?connect\s+google\s+calendar|how\s+(?:do\s+i|to)\s+disconnect\s+google\s+calendar)$`,
  triggers: ['как', 'хочу', 'отключи', 'переподключи', 'how'],
  steps: [{ respond: '{{t.help}}' }],
  strings: {
    ru: {
      help: 'Google Calendar подключается командой /connect_google, отключается командой /disconnect_google — обе работают в личке с ботом. По фразе в чате я ничего не отключаю.',
    },
    en: {
      help: 'Google Calendar is connected with /connect_google and disconnected with /disconnect_google — both work in a private chat with the bot. I do not disconnect anything from a chat phrase.',
    },
  },
  examples: [
    'как подключить google календарь',
    'хочу подключить гугл',
    'отключи google календарь',
    'переподключи мой гугл календарь',
    'how to connect google calendar',
    'how do i disconnect google calendar',
  ],
  negatives: ['как подключить принтер', 'как отключить уведомления'],
  notes: 'Instructions only. A chat phrase never disconnects an account.',
};

const secretaryList: FamilyDefinition = {
  name: 'basis.secretary.list',
  title: 'Who has access to my calendar',
  category: 'secretary',
  risk: 'private_read',
  pattern: String.raw`^(?:кто\s+имеет\s+доступ\s+к\s+моему\s+календарю|мои\s+секретари|список\s+секретарей|who\s+has\s+access\s+to\s+my\s+calendar|list\s+(?:my\s+)?secretaries)$`,
  triggers: ['кто', 'мои', 'список', 'who', 'list'],
  steps: [guardPrivate(), { call: 'list_calendar_access', input: {} }],
  strings: { ru: {}, en: {} },
  examples: [
    'кто имеет доступ к моему календарю',
    'мои секретари',
    'список секретарей',
    'who has access to my calendar',
    'list my secretaries',
  ],
  negatives: ['кто имеет доступ к календарю друга', 'мои секретари уволены'],
};

const PERMISSIONS = [
  [['чтение', 'read'], 'read'],
  [['редактирование', 'write'], 'write'],
] as const;

const secretaryInvite: FamilyDefinition = {
  name: 'basis.secretary.invite',
  title: 'Give one numeric Telegram ID access to my calendar',
  category: 'secretary',
  risk: 'sensitive_write',
  pattern: String.raw`^(?:дай|предоставь|give|grant)\s+(?:пользователю|user)\s+(\d{5,15})\s+(?:доступ\s+на\s+(чтение|редактирование)|(read|write)\s+access)\s+(?:к\s+моему\s+календарю|to\s+my\s+calendar)$`,
  triggers: ['дай', 'предоставь', 'give', 'grant'],
  bindings: {
    who: { type: 'recipient', from: '{{$1}}' },
    perm: { type: 'enum', from: '{{$2|default("")}}{{$3|default("")}}', values: phraseTable(PERMISSIONS) },
  },
  steps: [
    guardPrivate(),
    ...confirmStep('q'),
    {
      call: 'manage_secretaries',
      input: { action: 'invite', secretary_telegram_id: '{{bind.who.id}}', permission: '{{bind.perm}}' },
    },
  ],
  strings: {
    ru: {
      q: 'Дать пользователю {{bind.who.label}} доступ ({{bind.perm}}) к твоему календарю? Это чувствительное действие.',
    },
    en: { q: 'Give user {{bind.who.label}} {{bind.perm}} access to your calendar? This is a sensitive action.' },
  },
  examples: [
    'дай пользователю 123456789 доступ на чтение к моему календарю',
    'предоставь пользователю 987654321 доступ на редактирование к моему календарю',
    'give user 123456789 read access to my calendar',
    'grant user 555000111 write access to my calendar',
  ],
  negatives: [
    'дай пользователю 123456789 доступ к моему календарю',
    'дай пользователю Иван доступ на чтение к моему календарю',
  ],
  notes: 'Needs a numeric ID and an explicit permission, and always asks first.',
};

const secretaryClarify: FamilyDefinition = {
  name: 'basis.secretary.clarify',
  title: 'Ask for a numeric ID instead of granting calendar access by @username',
  category: 'secretary',
  risk: 'read',
  pattern: String.raw`^(?:добавь|сделай|назначь|дай|add|make|give)\s+@${USERNAME_RX}\s+(?:в\s+секретари|моим\s+секретарем|моим\s+секретарём|секретарем|(?:as\s+)?(?:my\s+)?secretary|access\s+to\s+my\s+calendar|доступ\s+к\s+календарю)$`,
  triggers: ['добавь', 'сделай', 'назначь', 'дай', 'add', 'make', 'give'],
  steps: [{ respond: '{{t.clarify}}' }],
  strings: {
    ru: {
      clarify:
        'Доступ к календарю — чувствительная настройка, по @username я её не выдаю. Напиши числовой Telegram ID и тип доступа, например: «дай пользователю 123456789 доступ на чтение к моему календарю».',
    },
    en: {
      clarify:
        'Calendar access is sensitive, so I do not grant it by @username. Send a numeric Telegram ID and the access type, for example: “give user 123456789 read access to my calendar”.',
    },
  },
  examples: [
    'добавь @ivan_petrov в секретари',
    'сделай @anna_smith моим секретарем',
    'дай @mark_t1 доступ к календарю',
    'add @ivan_petrov as my secretary',
    'give @anna_smith access to my calendar',
  ],
  negatives: ['добавь Ивана в секретари', 'сделай @ivan моим секретарем'],
  notes: 'No tool runs; the reply only explains the accepted, verifiable phrasing.',
};

const botInfo: FamilyDefinition = {
  name: 'basis.bot.info',
  title: 'What the bot can do and how to reach its developer',
  category: 'bot',
  risk: 'read',
  pattern: String.raw`^(?:что\s+ты\s+умеешь|что\s+умеет\s+этот\s+бот|расскажи\s+о\s+возможностях|скрытые\s+возможности|как\s+связаться\s+с\s+разработчиком|what\s+can\s+you\s+do|bot\s+capabilities|hidden\s+features|contact\s+the\s+developer)$`,
  triggers: ['умеешь', 'умеет', 'расскажи', 'скрытые', 'как', 'what', 'bot', 'hidden', 'contact'],
  steps: [{ call: 'get_bot_info', input: {} }],
  strings: { ru: {}, en: {} },
  examples: [
    'что ты умеешь',
    'что умеет этот бот',
    'скрытые возможности',
    'как связаться с разработчиком',
    'what can you do',
    'hidden features',
  ],
  negatives: ['что ты умеешь готовить', 'что ты сделал'],
};

export const personalFamilies: FamilyDefinition[] = [
  contactsList,
  contactsFind,
  contactsAdd,
  contactsRename,
  contactsSetUsername,
  contactsDelete,
  settingsView,
  settingsToggle,
  settingsAgendaTime,
  settingsDuration,
  settingsLanguage,
  settingsTimezone,
  historySearch,
  actionLogRecent,
  memoryRemember,
  timeNow,
  timeConvert,
  calc,
  googleStatus,
  googleCalendars,
  googleConnectHelp,
  secretaryList,
  secretaryInvite,
  secretaryClarify,
  botInfo,
];
