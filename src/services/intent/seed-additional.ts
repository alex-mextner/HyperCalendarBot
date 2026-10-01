import {
  ANY_DAY_RX,
  confirmStep,
  DAY_WORDS,
  type FamilyDefinition,
  guardPrivate,
  SCOPE,
  TIME_RX,
} from './seed-fragments.ts';

const createRange: FamilyDefinition = {
  name: 'basis.event.create_range',
  title: 'Create an event with an explicit start and end',
  category: 'events',
  risk: 'write',
  pattern: String.raw`^(?:создай|добавь|запланируй|create|add|schedule)\s+(.{1,120}?)\s+(${ANY_DAY_RX})\s+(?:с|from)\s+(${TIME_RX})\s+(?:до|to)\s+(${TIME_RX})$`,
  triggers: ['создай', 'добавь', 'запланируй', 'create', 'add', 'schedule'],
  bindings: {
    title: { type: 'text', from: '{{$1}}', max: 120 },
    day: { type: 'date', from: '{{$2}}', words: DAY_WORDS },
    first: { type: 'time', from: '{{$3}}' },
    last: { type: 'time', from: '{{$4}}' },
    start: { type: 'datetime', date: 'day', time: 'first', future: true },
    end: { type: 'datetime', date: 'day', time: 'last' },
  },
  steps: [
    { when: 'bind.end <= bind.start', respond: '{{t.invalid_range}}' },
    ...confirmStep('question'),
    {
      call: 'create_event',
      input: { title: '{{bind.title}}', start_at: '{{bind.start}}', end_at: '{{bind.end}}', scope: SCOPE },
    },
  ],
  strings: {
    ru: {
      invalid_range: 'Конец должен быть позже начала в тот же день. Уточните диапазон.',
      question: 'Добавить «{{bind.title}}» {{bind.day}} с {{bind.first}} до {{bind.last}}?',
    },
    en: {
      invalid_range: 'The end must be later on the same day. Specify the interval.',
      question: 'Add “{{bind.title}}” on {{bind.day}} from {{bind.first}} to {{bind.last}}?',
    },
  },
  examples: [
    'создай стендап завтра с 10:00 до 11:00',
    'добавь встречу 2026-10-05 с 15:00 до 16:30',
    'create planning tomorrow from 10am to 11am',
  ],
  negatives: ['создай стендап с 10:00 до 11:00', 'не создай стендап завтра с 10:00 до 11:00'],
  invalidInputs: ['создай стендап завтра с 3 до 5', 'create standup tomorrow from 25:00 to 26:00'],
  notes:
    'Replaces the stored today/tomorrow timerange recipes with one typed, confirmed interval. Cross-midnight requires an explicit different request, never a guessed end date.',
};
const telegramStatus: FamilyDefinition = {
  name: 'basis.telegram.status',
  title: 'Inspect the current personal Telegram connection',
  category: 'google',
  risk: 'private_read',
  pattern: String.raw`^(?:проверь\s+(?:мо[её]\s+)?подключение\s+(?:телеграм|telegram)|статус\s+(?:телеграм|telegram)|telegram\s+(?:connection\s+)?status|check\s+(?:my\s+)?telegram\s+connection|подключ(?:и|ить)\s+(?:мой\s+)?(?:тг|телеграм|telegram)|добавь\s+мой\s+(?:тг|телеграм|telegram)\s+чтоб\s+отправлялись\s+приглашения\s+от\s+моего\s+имени)$`,
  triggers: ['проверь', 'статус', 'telegram', 'check', 'подключи', 'подключить', 'добавь'],
  steps: [
    guardPrivate(),
    { call: 'connect_telegram_status', input: {}, as: 'connection' },
    { respond: '{{tool_outputs.connection_text}}\n\n{{t.connect_help}}' },
  ],
  strings: {
    ru: {
      connect_help:
        'Для подключения вашего аккаунта откройте /connect_telegram в личном чате с ботом. Сам статус подключения ничего не меняет.',
    },
    en: {
      connect_help:
        'To connect your account, open /connect_telegram in this private bot chat. Reading the status does not change the connection.',
    },
  },
  examples: [
    'проверь подключение телеграм',
    'статус telegram',
    'telegram connection status',
    'подключи мой telegram',
    'check my telegram connection',
  ],
  negatives: ['проверь подключение telegram Лены', 'подключи чужой telegram'],
  notes:
    'Replaces approved DB39 with an owner-scoped status query. No QR, credentials or connection changes are performed by the intent.',
};

const callStart: FamilyDefinition = {
  name: 'basis.call.start',
  title: 'Start a call to the requesting account',
  category: 'contacts',
  risk: 'write',
  pattern: String.raw`^(?:позвони\s+мне|набери\s+меня|call\s+me|start\s+a\s+call)$`,
  triggers: ['позвони', 'набери', 'call', 'start'],
  steps: [guardPrivate(), ...confirmStep('question'), { call: 'make_call', input: { text: '{{t.call_text}}' } }],
  strings: {
    ru: {
      question: 'Начать звонок в ваш подключённый Telegram-аккаунт?',
      call_text: 'Здравствуйте! Вы запросили звонок из календаря.',
    },
    en: {
      question: 'Start a call to your connected Telegram account?',
      call_text: 'Hello! You requested a call from your calendar.',
    },
  },
  examples: ['позвони мне', 'набери меня', 'call me'],
  negatives: ['позвони Лене', 'не звони мне'],
  notes:
    'Replaces stored DB7 with actor-scoped explicit intent and confirmation. Unsupported call capabilities fail without inventing success.',
};
const remindAfter: FamilyDefinition = {
  name: 'basis.reminder.after',
  title: 'Create an explicit reminder after a duration',
  category: 'reminders',
  risk: 'write',
  pattern: String.raw`^(?:напомни(?:\s+мне)?\s+через|remind\s+me\s+in)\s+(\d{1,4})\s+(минут(?:у|ы)?|мин|час(?:а|ов)?|minutes?|hours?)\s+(.{1,120})$`,
  triggers: ['напомни', 'remind'],
  bindings: {
    delay: {
      type: 'duration',
      from: '{{$1}}',
      unit: '{{$2}}',
      units: {
        минута: 1,
        минуту: 1,
        минуты: 1,
        минут: 1,
        мин: 1,
        час: 60,
        часа: 60,
        часов: 60,
        minute: 1,
        minutes: 1,
        hour: 60,
        hours: 60,
      },
      min: 1,
      max: 10080,
    },
    title: { type: 'text', from: '{{$3}}', max: 120 },
    at: { type: 'relative_instant', duration: 'delay' },
  },
  steps: [
    guardPrivate(),
    ...confirmStep('question'),
    {
      call: 'create_event',
      input: { title: '{{bind.title}}', start_at: '{{bind.at}}', reminder_minutes: [0], scope: 'personal' },
    },
  ],
  strings: {
    ru: {
      question: 'Создать запись-напоминание «{{bind.title}}» через {{bind.delay}} мин. с уведомлением в момент начала?',
    },
    en: {
      question: 'Create reminder event “{{bind.title}}” in {{bind.delay}} minutes, with a notification at its start?',
    },
  },
  examples: [
    'напомни через 15 минут выключить духовку',
    'напомни мне через 2 часа отправить отчёт',
    'remind me in 10 minutes take a break',
  ],
  negatives: ['напомни завтра', 'напомни через 15 минут'],
  invalidInputs: ['напомни через 0 минут тест'],
  notes:
    'A standalone requested reminder is explicitly stored as one calendar reminder event; changing reminders of an existing event instead uses basis.reminder.set and never duplicates that event.',
};
export const additionalFamilies: FamilyDefinition[] = [createRange, telegramStatus, callStart, remindAfter];
