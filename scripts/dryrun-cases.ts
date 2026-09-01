/**
 * Request shapes taken from the production `chat_history` table (the recorded
 * user message together with the tool the agent actually called at the time).
 *
 * Names, venues and other personal details are replaced with neutral
 * placeholders — only the linguistic shape of each request is reproduced, since
 * that is what drives tool selection.
 *
 * `expectAnyOf` lists every tool choice that is a correct first move for the
 * request, because several are legitimately possible (e.g. looking an event up
 * before editing it). A case fails when the model picks nothing from the list.
 */
export interface DryRunCase {
  id: string;
  message: string;
  group?: boolean;
  history?: { role: 'user' | 'assistant'; content: string }[];
  expectAnyOf: string[];
  expectNoTools?: boolean;
}

export const DRYRUN_CASES: DryRunCase[] = [
  {
    id: 'create-tomorrow-time',
    message: 'Завтра 12:30 английский',
    expectAnyOf: ['create_event', 'calculate'],
  },
  {
    id: 'create-weekday-errand',
    message: 'Воскресенье в 12 отвезти кошек к врачу',
    expectAnyOf: ['create_event', 'calculate'],
  },
  {
    id: 'create-explicit-date',
    message: '8 сентября в 11 утра придёт мастер',
    expectAnyOf: ['create_event', 'calculate'],
  },
  {
    id: 'create-foreign-timezone',
    message: 'Сегодня в 20:30 по Москве созвон по проекту',
    expectAnyOf: ['create_event', 'get_timezone_info', 'calculate', 'convert_to_timezone'],
  },
  {
    id: 'create-with-invite',
    message: 'Завтра в 15:00 обед в кафе. Пригласи @friend_one',
    expectAnyOf: ['create_event', 'calculate'],
  },
  {
    id: 'reschedule-named-event',
    message: 'Перенеси завтра мой английский на 12:30',
    expectAnyOf: ['search_events', 'get_events', 'update_event', 'calculate'],
  },
  {
    id: 'cancel-series-until-date',
    message: 'Отмени занятия английским до 18-го числа включительно',
    expectAnyOf: ['search_events', 'get_events', 'ask_user', 'delete_event', 'calculate'],
  },
  {
    id: 'delete-two-days',
    message: 'Удали все события на сегодня и завтра',
    expectAnyOf: ['get_events', 'search_events', 'ask_user', 'delete_event', 'calculate'],
  },
  {
    id: 'agenda-tomorrow',
    message: 'Планы на завтра',
    expectAnyOf: ['get_events', 'render_day_image', 'get_upcoming', 'calculate'],
  },
  {
    id: 'agenda-week',
    message: 'Планы на неделю',
    expectAnyOf: ['get_events', 'render_week_image', 'calculate'],
  },
  {
    id: 'settings-read-timezone',
    message: 'Какой часовой пояс стоит?',
    expectAnyOf: ['manage_settings'],
  },
  {
    id: 'settings-change-timezone',
    message: 'Переставь часовой пояс на Белград',
    expectAnyOf: ['manage_settings', 'ask_user', 'get_timezone_info'],
  },
  {
    id: 'add-contact-username',
    message: 'Добавь в контакты Сергея @friend_two',
    expectAnyOf: ['add_contact', 'find_user'],
  },
  {
    id: 'invite-after-create',
    message: 'Пригласи @friend_one',
    history: [
      { role: 'user', content: 'Завтра в 19:00 ужин' },
      { role: 'assistant', content: 'Готово, «Ужин» завтра в 19:00 (event_id 42).' },
    ],
    expectAnyOf: ['send_invitation', 'get_events', 'search_events', 'find_user', 'get_contacts', 'find_contact'],
  },
  {
    id: 'invite-by-name',
    message: 'Позови на него Лену',
    history: [
      { role: 'user', content: 'Завтра в 19:00 ужин' },
      { role: 'assistant', content: 'Готово, «Ужин» завтра в 19:00 (event_id 42).' },
    ],
    expectAnyOf: ['get_contacts', 'find_contact', 'pick_users', 'send_invitation'],
  },
  {
    id: 'relative-reminder',
    message: 'Через полтора часа напомни про бронь отеля',
    expectAnyOf: ['calculate', 'create_event', 'set_reminder', 'schedule_ai_call'],
  },
  {
    id: 'free-slots',
    message: 'Когда у меня завтра свободное время?',
    expectAnyOf: ['get_free_slots', 'get_events', 'calculate'],
  },
  {
    id: 'group-off-topic-date',
    message: 'Доставка будет 1 апреля',
    group: true,
    expectAnyOf: [],
    expectNoTools: true,
  },
  {
    id: 'group-direct-agenda',
    message: 'Календарь, покажи события на завтра',
    group: true,
    expectAnyOf: ['get_events', 'render_day_image', 'calculate'],
  },
];
