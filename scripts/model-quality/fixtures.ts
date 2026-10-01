import type { Args, Fixture } from './core.ts';
export const CLOCK = '2026-09-27 Sun 10:00';
export const BASE_EVENT: Args = {
  id: 101,
  title: 'Завтрак',
  start_at: '2026-09-28T11:00:00Z',
  end_at: '2026-09-28T12:00:00Z',
  owner_id: 123,
  scope: 'personal',
  description: '',
  location: '',
};
const eventContext =
  'Последнее обсуждаемое событие — №101 «Завтрак», 28 сентября 2026, 13:00–14:00 Europe/Belgrade. Оно принадлежит пользователю123.';
function f(id: string, family: string, provenance: string, user: string, patch: Partial<Fixture> = {}): Fixture {
  return { id, family, provenance, user, context: '', required: [], allowedWrites: [], maxWrites: 0, ...patch };
}
/** Wording and private values are transformed; context/IDs are reconstructed synthetic state. */
export const fixtures: Fixture[] = [
  f('today', 'read', 'history-derived-family:canonical-corpus-402;not-literal-replay', 'План на сегодня', {
    required: [
      { name: 'get_events', args: { start_date: '2026-09-26T22:00:00Z', end_date: '2026-09-27T22:00:00Z' } },
      { name: 'render_day_image', args: { date: '2026-09-27' } },
    ],
  }),
  f('tomorrow', 'read', 'history-derived-family:canonical-corpus-402;not-literal-replay', 'Планы на завтра', {
    events: [BASE_EVENT],
    required: [
      { name: 'get_events', args: { start_date: '2026-09-27T22:00:00Z', end_date: '2026-09-28T22:00:00Z' } },
      { name: 'render_day_image', args: { date: '2026-09-28' } },
    ],
  }),
  f(
    'next-week-picture',
    'read',
    'history-derived-family:canonical-corpus-402;not-literal-replay',
    'Покажи план на следующую неделю в фото',
    {
      required: [{ name: 'render_week_image', args: { week_start: '2026-09-28' } }],
    },
  ),
  f(
    'english-tomorrow',
    'read',
    'history-derived-family:canonical-corpus-402;not-literal-replay',
    'Okay. Check my calendar. What do I have tomorrow?',
    {
      language: 'en',
      required: [
        { name: 'get_events', args: { start_date: '2026-09-27T22:00:00Z', end_date: '2026-09-28T22:00:00Z' } },
      ],
    },
  ),
  f(
    'terse-create',
    'create',
    'history-derived-family:canonical-corpus-402;not-literal-replay',
    'Завтра 13:15 занятие',
    {
      required: [{ name: 'create_event', args: { start_at: '2026-09-28T11:15:00Z', end_at: '2026-09-28T12:15:00Z' } }],
      allowedWrites: ['create_event'],
      maxWrites: 1,
    },
  ),
  f(
    'duration',
    'create',
    'history-derived-family:canonical-corpus-402;not-literal-replay',
    'Сегодня с16:00 до18:00 тренировка',
    {
      required: [{ name: 'create_event', args: { start_at: '2026-09-27T14:00:00Z', end_at: '2026-09-27T16:00:00Z' } }],
      allowedWrites: ['create_event'],
      maxWrites: 1,
    },
  ),
  f(
    'relative-time',
    'create',
    'history-derived-family:canonical-corpus-402;not-literal-replay',
    'Через полтора часа напомни забрать посылку',
    {
      required: [{ name: 'create_event', args: { start_at: '2026-09-27T09:30:00Z' } }],
      allowedWrites: ['create_event'],
      maxWrites: 1,
    },
  ),
  f(
    'explicit-offset',
    'timezone',
    'history-derived-family:canonical-corpus-402;not-literal-replay',
    'В16:00 GMT+4 завтра созвон с командой на час',
    {
      required: [{ name: 'create_event', args: { start_at: '2026-09-28T12:00:00Z', end_at: '2026-09-28T13:00:00Z' } }],
      allowedWrites: ['create_event'],
      maxWrites: 1,
    },
  ),
  f(
    'future-dst',
    'timezone',
    'history-derived-family:canonical-corpus-402;not-literal-replay',
    '5 ноября2026 в13:00 по Белграду занятие на час',
    {
      holdout: true,
      required: [{ name: 'create_event', args: { start_at: '2026-11-05T12:00:00Z', end_at: '2026-11-05T13:00:00Z' } }],
      allowedWrites: ['create_event'],
      maxWrites: 1,
    },
  ),
  f(
    'two-events',
    'batch',
    'history-derived-family:canonical-corpus-402;not-literal-replay',
    'Создай на завтра:11:00 Урок;13:45 Тренировка. Каждое по часу.',
    {
      required: [
        { name: 'create_event', args: { start_at: '2026-09-28T09:00:00Z', end_at: '2026-09-28T10:00:00Z' } },
        { name: 'create_event', args: { start_at: '2026-09-28T11:45:00Z', end_at: '2026-09-28T12:45:00Z' } },
      ],
      allowedWrites: ['create_event'],
      maxWrites: 2,
    },
  ),
  f(
    'move-one-hour',
    'context',
    'history-derived-family:canonical-corpus-402;not-literal-replay',
    'Перенеси завтрак на час позже',
    {
      context: eventContext,
      events: [BASE_EVENT],
      required: [
        {
          name: 'update_event',
          args: { event_id: 101, start_at: '2026-09-28T12:00:00Z', end_at: '2026-09-28T13:00:00Z' },
        },
      ],
      allowedWrites: ['update_event'],
      maxWrites: 1,
    },
  ),
  f('last-mentioned', 'context', 'history-derived-family:canonical-corpus-402;not-literal-replay', 'Перенеси на12', {
    context: eventContext,
    events: [BASE_EVENT],
    required: [
      {
        name: 'update_event',
        args: { event_id: 101, start_at: '2026-09-28T10:00:00Z', end_at: '2026-09-28T11:00:00Z' },
      },
    ],
    allowedWrites: ['update_event'],
    maxWrites: 1,
  }),
  f(
    'title-only',
    'context',
    'history-derived-family:canonical-corpus-402;not-literal-replay',
    'Не Завтрак, а Демо. Исправь только название.',
    {
      context: eventContext,
      events: [BASE_EVENT],
      required: [{ name: 'update_event', args: { event_id: 101, title: 'Демо' } }],
      allowedWrites: ['update_event'],
      maxWrites: 1,
    },
  ),
  f(
    'ambiguous-reference',
    'clarify',
    'history-derived-family:canonical-corpus-402;not-literal-replay',
    'Перенеси это на вечер',
    {
      context: 'Нет предыдущего события, активного выбора или подтверждения.',
      oneOf: ['ask_user'],
    },
  ),
  f(
    'missing-time',
    'clarify',
    'history-derived-family:canonical-corpus-402;not-literal-replay',
    'Завтра настолки с Олегом',
    { oneOf: ['ask_user'] },
  ),
  f(
    'ambiguous-number',
    'clarify',
    'history-derived-family:canonical-corpus-402;not-literal-replay',
    'Создай встречу на8',
    { oneOf: ['ask_user'] },
  ),
  f('conditional', 'clarify', 'synthetic:conditional-variant', 'Могу в17 или19 завтра. Когда лучше?', {
    oneOf: ['ask_user'],
  }),
  f(
    'delete-unconfirmed',
    'confirmation',
    'history-derived-family:canonical-corpus-402;not-literal-replay',
    'Удали завтрак',
    {
      context: `${eventContext} Удаление ещё НЕ подтверждалось.`,
      events: [BASE_EVENT],
      oneOf: ['ask_user'],
    },
  ),
  f(
    'delete-confirmed',
    'confirmation',
    'history-derived-family:canonical-corpus-402;not-literal-replay',
    'Да, удалить',
    {
      context:
        eventContext +
        ' Предыдущий вопрос бота: «Удалить событие №101 Завтрак 28 сентября13:00?» Текущий ответ относится именно к этому подтверждению.',
      events: [BASE_EVENT],
      required: [{ name: 'delete_event', args: { event_id: 101 } }],
      allowedWrites: ['delete_event'],
      maxWrites: 1,
    },
  ),
  f('cancel-choice', 'confirmation', 'history-derived-family:canonical-corpus-402;not-literal-replay', 'Отмена', {
    context: `${eventContext} Бот ожидает подтверждение удаления. Пользователь отменяет только этот запрос.`,
    forbiddenText: ['событие удалено', 'удалил событие'],
  }),
  f('yes-no-context', 'confirmation', 'history-derived-family:canonical-corpus-402;not-literal-replay', 'Да', {
    context: 'Нет ожидающего вопроса, события или незавершённого действия.',
    oneOf: ['ask_user'],
  }),
  f(
    'reminders',
    'reminder',
    'history-derived-family:canonical-corpus-402;not-literal-replay',
    'Для события101 напомни за час и за полчаса',
    {
      context: eventContext,
      events: [BASE_EVENT],
      required: [{ name: 'set_reminder', args: { event_id: 101, minutes_before: [60, 30] } }],
      allowedWrites: ['set_reminder'],
      maxWrites: 1,
    },
  ),
  f(
    'invite-verified',
    'contacts',
    'history-derived-family:canonical-corpus-402;not-literal-replay',
    'Пригласи Олега на это событие',
    {
      context: eventContext,
      events: [BASE_EVENT],
      contacts: [{ id: 1, name: 'Олег', preferred_name: 'Олег', telegram_id: 201 }],
      required: [{ name: 'send_invitation', args: { event_id: 101, invitee_id: 201 } }],
      allowedWrites: ['send_invitation'],
      maxWrites: 1,
      forbiddenText: ['приглашение доставлено', 'получил приглашение'],
    },
  ),
  f(
    'ambiguous-contact',
    'contacts',
    'history-derived-family:canonical-corpus-402;not-literal-replay',
    'Пригласи Олега на это событие',
    {
      context: eventContext,
      events: [BASE_EVENT],
      contacts: [
        { id: 1, name: 'Олег', telegram_id: 201 },
        { id: 2, name: 'Олег', telegram_id: 202 },
      ],
      oneOf: ['ask_user', 'pick_users'],
    },
  ),
  f(
    'failed-delivery',
    'outcomes',
    'history-derived-family:canonical-corpus-402;not-literal-replay',
    'Приглашение создалось, но доставка не прошла. Объясни статус, ничего заново не отправляй.',
    {
      context: eventContext,
      events: [BASE_EVENT],
      responses: {
        get_invitation_status: {
          success: true,
          invitations: [{ id: 301, event_id: 101, invitee_id: 201, status: 'pending', delivery_status: 'failed' }],
        },
      },
      required: [{ name: 'get_invitation_status', args: { event_id: 101 } }],
      forbiddenText: ['приглашение доставлено', 'приглашение отправлено'],
    },
  ),
  f(
    'do-not-replay',
    'outcomes',
    'history-derived-family:canonical-corpus-402;not-literal-replay',
    'Ты опять создал два события вместо одного. Ничего не создавай и не удаляй. Проверь, что произошло.',
    {
      context:
        'Предыдущие действия: create_event успешно создал события101 и102. Неизвестно, какое пользователь хочет оставить.',
      events: [BASE_EVENT, { ...BASE_EVENT, id: 102 }],
      oneOf: ['get_action_log', 'get_events', 'search_events', 'get_history'],
      holdout: true,
    },
  ),
  f(
    'settings-confirmed',
    'settings',
    'history-derived-family:canonical-corpus-402;not-literal-replay',
    'Да, переключись на английский',
    {
      context: 'Предыдущий вопрос бота: «Изменить язык интерфейса на английский?»',
      required: [
        { name: 'manage_settings', args: { action: 'update', category: 'general', updates: { language: 'en' } } },
      ],
      allowedWrites: ['manage_settings'],
      maxWrites: 1,
    },
  ),
  f(
    'timezone-confirmed',
    'settings',
    'history-derived-family:canonical-corpus-402;not-literal-replay',
    'Да, обнови часовой пояс на Europe/Moscow',
    {
      context: 'Предыдущий вопрос бота: «Изменить ваш часовой пояс на Europe/Moscow?»',
      required: [
        {
          name: 'manage_settings',
          args: { action: 'update', category: 'general', updates: { timezone: 'Europe/Moscow' } },
        },
      ],
      allowedWrites: ['manage_settings'],
      maxWrites: 1,
    },
  ),
  f(
    'group-read',
    'scope',
    'history-derived-family:canonical-corpus-402;not-literal-replay',
    'Календарь, что завтра у нашей группы?',
    {
      group: true,
      required: [
        {
          name: 'get_events',
          args: { start_date: '2026-09-27T22:00:00Z', end_date: '2026-09-28T22:00:00Z', scope: 'group' },
        },
      ],
    },
  ),
  f(
    'group-miss',
    'scope',
    'history-derived-family:canonical-corpus-402;not-literal-replay',
    'Найди встречу Демо в календаре этой группы',
    {
      group: true,
      responses: { search_events: { success: true, events: [] } },
      required: [{ name: 'search_events', args: { scope: 'group' } }],
      holdout: true,
    },
  ),
  f(
    'calculator',
    'read',
    'history-derived-family:canonical-corpus-402;not-literal-replay',
    'Сколько будет19 умножить на3?',
    {
      required: [{ name: 'calculate', args: {} }],
      requiredText: ['57'],
    },
  ),
  f(
    'chitchat',
    'no-action',
    'history-derived-family:canonical-corpus-402;not-literal-replay',
    'Сегодня дождь, настроение сонное.',
    { holdout: true },
  ),
];
