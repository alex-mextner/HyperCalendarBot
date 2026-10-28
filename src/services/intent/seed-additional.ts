import {
  abstainInGroup,
  COURTESY,
  confirmStep,
  DATE_SIGNAL,
  type FamilyDefinition,
  guardPrivate,
  slotForms,
  spanVocabulary,
  TIME_SIGNAL,
} from './seed-fragments.ts';

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
const AFTER_SPAN = spanVocabulary(false);
/** The reminder text is not just a connector word ("напомни через час что"), and does not start with a number ("через 1 час 30 минут ...": a longer span this rule does not read). */
const TEXT_GUARD = '(?!(?:что|чтобы|to|that)$)(?!\\d)';
/** The message names neither a day nor a clock time: "через час в 18:00 ..." is something else. */
const NO_WHEN = `(?!${DATE_SIGNAL})(?!${TIME_SIGNAL})`;
const AFTER_SLOTS = {
  amount: String.raw`\d{1,4}`,
  unit: AFTER_SPAN.unit,
  bare: AFTER_SPAN.bare,
  text: String.raw`[^;\n]{1,120}`,
};
/** "20 минут", "2 часа", "полчаса": an amount with a unit, or a unit that stands for one. */
const afterSpan = (slot: (name: string) => string): string =>
  String.raw`(?:${slot('amount')}\s*${slot('unit')}|${slot('bare')})`;
/** Words that only lead into what to do: "напомни через час, что надо позвонить", "remind me in 5 minutes that I need to call". */
const RU_LINK = String.raw`(?:(?:что|чтобы|о\s+том\s+что|про)\s+)?(?:(?:надо|нужно|не\s+забыть|пора)\s+)?`;
const EN_LINK = String.raw`(?:(?:to|that|about)\s+)?(?:(?:i\s+(?:need|have|should|must)\s+to|don['’]t\s+forget\s+to)\s+)?`;
const remindForms = slotForms(
  [
    (s) =>
      String.raw`(?:напомни(?:те)?|напоминай|поставь\s+напоминание|добавь\s+напоминание|создай\s+напоминание)(?:\s+мне)?${COURTESY}\s+(?:через|чрез)\s+${afterSpan(s)}${COURTESY}\s+${RU_LINK}${TEXT_GUARD}${s('text')}`,
    (s) =>
      String.raw`(?:через|чрез)\s+${afterSpan(s)}\s+(?:напомни(?:те)?|напоминай)(?:\s+мне)?${COURTESY}\s+${RU_LINK}${TEXT_GUARD}${s('text')}`,
    (s) =>
      String.raw`(?:remind\s+me|ping\s+me|notify\s+me|set\s+(?:a\s+)?reminder)\s+in\s+${afterSpan(s)}\s+${EN_LINK}${TEXT_GUARD}${s('text')}`,
    (s) => String.raw`in\s+${afterSpan(s)}\s+(?:remind\s+me|ping\s+me)\s+${EN_LINK}${TEXT_GUARD}${s('text')}`,
  ],
  AFTER_SLOTS,
  NO_WHEN,
);

const remindAfter: FamilyDefinition = {
  name: 'basis.reminder.after',
  title: 'Create an explicit reminder after a duration',
  category: 'reminders',
  risk: 'write',
  pattern: remindForms.pattern,
  triggers: [
    'напомни',
    'напомните',
    'напоминай',
    'поставь',
    'добавь',
    'создай',
    'через',
    'чрез',
    'remind',
    'ping',
    'notify',
    'set',
    'in',
  ],
  bindings: {
    delay: {
      type: 'duration',
      from: remindForms.read('amount'),
      unit: `${remindForms.read('unit')}${remindForms.read('bare')}`,
      units: AFTER_SPAN.table,
      default_amount: 1,
      min: 1,
      max: 10080,
    },
    title: { type: 'text', from: remindForms.read('text'), max: 120, capitalize: true },
    at: { type: 'relative_instant', duration: 'delay' },
  },
  steps: [
    abstainInGroup(),
    ...confirmStep('question'),
    {
      call: 'create_event',
      input: { title: '{{bind.title}}', start_at: '{{bind.at}}', reminder_minutes: [0], scope: 'personal' },
    },
    { respond: '{{t.done}}' },
  ],
  strings: {
    ru: {
      question: 'Напомнить «{{bind.title}}» через {{bind.delay|human_duration}}, в {{bind.at|date("HH:mm")}}?',
      done: 'Готово: напомню «{{bind.title}}» через {{bind.delay|human_duration}}, в {{bind.at|date("HH:mm")}}.',
    },
    en: {
      question: 'Remind you “{{bind.title}}” in {{bind.delay|human_duration}}, at {{bind.at|date("HH:mm")}}?',
      done: 'Done: I will remind you “{{bind.title}}” in {{bind.delay|human_duration}}, at {{bind.at|date("HH:mm")}}.',
    },
  },
  examples: [
    'напомни через 20 минут позвонить маме',
    'напомни мне через 2 часа забрать детей',
    'через час напомни, пожалуйста, проверить почту',
    'напомни через полчаса выключить плиту',
    'remind me in 2 hours to take out the trash',
    'ping me in 10 minutes to stretch',
    'через 5 минут напомни про чай',
    'поставь напоминание через час позвонить в банк',
  ],
  negatives: [
    'напомни завтра',
    'напомни через 15 минут',
    'напомни позвонить маме',
    'напомни через час в 18:00 позвонить врачу',
    'remind me to buy milk',
  ],
  invalidInputs: ['напомни через 0 минут тест'],
  notes:
    'A standalone requested reminder is explicitly stored as one calendar reminder event; changing reminders of an existing event instead uses basis.reminder.set and never duplicates that event. Days, clock times and dates in the text go to the AI.',
};
export const additionalFamilies: FamilyDefinition[] = [telegramStatus, callStart, remindAfter];
