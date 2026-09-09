// scripts/seed-intents-free-busy.ts — candidate intents for the "free/busy queries beyond today" category.
//
// NOT wired into the live seed pipeline. A separate integration pass consolidates every
// scripts/seed-intents-<category>.ts file, dedupes canonical_names, and runs the actual
// insert against data/calendar.db. Do not import this from scripts/seed-intents.ts.

export interface SeedIntent {
  canonical_name: string;
  pattern: string;
  workflow: object;
  phrases: string[];
  trigger_words: string[];
  source_message: string;
}

export const freeBusyIntents: SeedIntent[] = [
  // ─── free_slots_tomorrow ──────────────────────────────────────────────────────
  {
    canonical_name: 'free_slots_tomorrow',
    pattern:
      '^(?:когда\\s+(?:я\\s+)?свободен\\s+завтра|свободные\\s+(?:окна|слоты)\\s+завтра|free\\s+slots?\\s+tomorrow|when\\s+am\\s+i\\s+free\\s+tomorrow)$',
    workflow: {
      tools: [{ name: 'get_free_slots', input: { date: '{{dates.tomorrow}}', scope: '{{env.scope}}' } }],
    },
    phrases: ['когда я свободен завтра', 'свободные слоты завтра', 'free slots tomorrow', 'when am I free tomorrow'],
    trigger_words: ['завтра', 'tomorrow', 'свободен', 'свободные', 'free', 'slots'],
    source_message: 'когда я свободен завтра',
  },

  // ─── free_slots_week (visual overview of the current week) ───────────────────
  {
    canonical_name: 'free_slots_week',
    pattern:
      '^(?:свободные\\s+(?:окна|слоты)\\s+на\\s+(?:этой\\s+)?неделе|когда\\s+я\\s+свободен\\s+на\\s+(?:этой\\s+)?неделе|free\\s+slots?\\s+this\\s+week|when\\s+am\\s+i\\s+free\\s+this\\s+week)$',
    workflow: {
      tools: [{ name: 'render_week_image', input: { week_start: '{{dates.week_start}}', scope: '{{env.scope}}' } }],
    },
    phrases: [
      'свободные слоты на этой неделе',
      'когда я свободен на неделе',
      'free slots this week',
      'when am I free this week',
    ],
    trigger_words: ['неделе', 'week', 'свободные', 'свободен', 'free', 'slots'],
    source_message: 'свободные слоты на этой неделе',
  },

  // ─── free_slots_next_week (Monday + Sunday of next week) ─────────────────────
  {
    canonical_name: 'free_slots_next_week',
    pattern:
      '^(?:когда\\s+я\\s+свободен\\s+на\\s+следующей\\s+неделе|свободные\\s+(?:окна|слоты)\\s+на\\s+следующей\\s+неделе|free\\s+slots?\\s+next\\s+week|when\\s+am\\s+i\\s+free\\s+next\\s+week)$',
    workflow: {
      steps: [
        {
          call: 'get_free_slots',
          input: { date: '{{dates.next_week_start}}', scope: '{{env.scope}}' },
          as: 'monday_slots',
        },
        {
          call: 'get_free_slots',
          input: { date: '{{dates.next_week_end}}', scope: '{{env.scope}}' },
          as: 'sunday_slots',
        },
        { respond: '{{t.msg}}' },
      ],
      i18n: {
        ru: { msg: 'Понедельник:\n{{tool_outputs.monday_slots}}\n\nВоскресенье:\n{{tool_outputs.sunday_slots}}' },
        en: { msg: 'Monday:\n{{tool_outputs.monday_slots}}\n\nSunday:\n{{tool_outputs.sunday_slots}}' },
      },
    },
    phrases: [
      'когда я свободен на следующей неделе',
      'свободные слоты на следующей неделе',
      'free slots next week',
      'when am I free next week',
    ],
    trigger_words: ['следующей', 'неделе', 'next', 'week', 'свободен', 'free'],
    source_message: 'когда я свободен на следующей неделе',
  },

  // ─── free_slots_on_date (day-of-month, rolls to next month if the day already passed) ──
  {
    canonical_name: 'free_slots_on_date',
    pattern:
      '^(?:свободные\\s+(?:окна|слоты)\\s+|когда\\s+я\\s+свободен\\s+|свободен\\s+ли\\s+я\\s+|when\\s+am\\s+i\\s+free\\s+on\\s+the\\s+|free\\s+slots?\\s+on\\s+the\\s+)(\\d{1,2})(?:\\s+числа|-?го|(?:st|nd|rd|th))?$',
    workflow: {
      steps: [
        {
          when: 'isPastDay($1) == false',
          call: 'get_free_slots',
          input: { date: '{{dates.today|date("yyyy-MM-")}}{{$1|pad(2)}}', scope: '{{env.scope}}' },
          as: 'slots',
        },
        {
          when: 'isPastDay($1)',
          call: 'get_free_slots',
          input: { date: '{{dates.next_month_start|date("yyyy-MM-")}}{{$1|pad(2)}}', scope: '{{env.scope}}' },
          as: 'slots',
        },
      ],
    },
    phrases: [
      'свободные слоты 15 числа',
      'когда я свободен 20 числа',
      'free slots on the 15th',
      'when am i free on the 20th',
    ],
    trigger_words: ['числа', 'свободные', 'свободен', 'free', 'slots'],
    source_message: 'свободные слоты 15 числа',
  },

  // ─── am_i_free_today_at_time ──────────────────────────────────────────────────
  {
    canonical_name: 'am_i_free_today_at_time',
    pattern:
      '^(?:свободен\\s+ли\\s+я(?:\\s+сегодня)?\\s+в|я\\s+свободен(?:\\s+сегодня)?\\s+в|am\\s+i\\s+free(?:\\s+today)?\\s+at)\\s+(\\d{1,2})(?:\\s\\d{2})?$',
    workflow: {
      steps: [
        {
          call: 'get_events',
          input: {
            start_date: '{{dates.today}}T{{$1|pad(2)}}:00:00{{user.utc_offset}}',
            end_date: '{{dates.today}}T{{$1|pad(2)}}:59:59{{user.utc_offset}}',
            scope: '{{env.scope}}',
          },
          as: 'conflicts',
        },
        { when: 'conflicts.length == 0', respond: '{{t.free}}' },
        { when: 'conflicts.length > 0', respond: '{{t.busy}}' },
      ],
      i18n: {
        ru: {
          free: 'Да, в {{$1}}:00 ты свободен.',
          busy: 'Нет, в {{$1}}:00 у тебя уже «{{tool_outputs.conflicts.0.title}}».',
        },
        en: {
          free: 'Yes, you are free at {{$1}}:00.',
          busy: 'No, you already have "{{tool_outputs.conflicts.0.title}}" at {{$1}}:00.',
        },
      },
    },
    phrases: ['свободен ли я в 15 сегодня', 'я свободен в 15', 'am i free at 15 today', 'am i free today at 3'],
    trigger_words: ['свободен', 'free'],
    source_message: 'свободен ли я в 15 сегодня',
  },

  // ─── am_i_free_tomorrow_at_time ───────────────────────────────────────────────
  {
    canonical_name: 'am_i_free_tomorrow_at_time',
    pattern:
      '^(?:свободен\\s+ли\\s+я\\s+завтра\\s+в|я\\s+свободен\\s+завтра\\s+в|am\\s+i\\s+free\\s+tomorrow\\s+at)\\s+(\\d{1,2})(?:\\s\\d{2})?$',
    workflow: {
      steps: [
        {
          call: 'get_events',
          input: {
            start_date: '{{dates.tomorrow}}T{{$1|pad(2)}}:00:00{{user.utc_offset}}',
            end_date: '{{dates.tomorrow}}T{{$1|pad(2)}}:59:59{{user.utc_offset}}',
            scope: '{{env.scope}}',
          },
          as: 'conflicts',
        },
        { when: 'conflicts.length == 0', respond: '{{t.free}}' },
        { when: 'conflicts.length > 0', respond: '{{t.busy}}' },
      ],
      i18n: {
        ru: {
          free: 'Да, завтра в {{$1}}:00 ты свободен.',
          busy: 'Нет, завтра в {{$1}}:00 у тебя уже «{{tool_outputs.conflicts.0.title}}».',
        },
        en: {
          free: 'Yes, you are free tomorrow at {{$1}}:00.',
          busy: 'No, you already have "{{tool_outputs.conflicts.0.title}}" tomorrow at {{$1}}:00.',
        },
      },
    },
    phrases: [
      'свободен ли я в 15 00 завтра',
      'я свободен завтра в 15',
      'am i free tomorrow at 15',
      'am i free tomorrow at 3',
    ],
    trigger_words: ['завтра', 'tomorrow', 'свободен', 'free'],
    source_message: 'свободен ли я завтра в 15',
  },

  // ─── common_free_time_with_contact (requires active secretary access to the contact) ──
  {
    canonical_name: 'common_free_time_with_contact',
    pattern:
      '^(?:когда\\s+мы\\s+с|общее\\s+свободное\\s+время\\s+с|when\\s+am\\s+i\\s+free\\s+with|common\\s+free\\s+time\\s+with)\\s+(.+?)(?:\\s+свободны)?$',
    workflow: {
      steps: [
        { call: 'find_contact', input: { name: '{{$1}}' }, as: 'contact' },
        {
          call: 'get_free_slots',
          input: {
            date: '{{dates.today}}',
            scope: '{{env.scope}}',
            owner_id: '{{tool_outputs.contact.matches.0.telegram_id}}',
          },
          as: 'their_slots',
        },
        { respond: '{{t.msg}}' },
      ],
      i18n: {
        ru: { msg: 'Свободное время {{tool_outputs.contact.matches.0.name}} сегодня:\n{{tool_outputs.their_slots}}' },
        en: { msg: "{{tool_outputs.contact.matches.0.name}}'s free time today:\n{{tool_outputs.their_slots}}" },
      },
    },
    phrases: [
      'когда мы с вовой свободны',
      'общее свободное время с вовой',
      'common free time with vova',
      'when am i free with vova',
    ],
    trigger_words: ['свободны', 'время', 'with', 'free'],
    source_message: 'когда мы с вовой свободны',
  },

  // ─── busiest_day_this_week ─────────────────────────────────────────────────────
  {
    canonical_name: 'busiest_day_this_week',
    pattern:
      '^(?:какой\\s+день\\s+на\\s+этой\\s+неделе\\s+(?:самый\\s+)?(?:загруженный|занятый)|мой\\s+самый\\s+загруженный\\s+день(?:\\s+на\\s+этой\\s+неделе)?|(?:my\\s+)?busiest\\s+day(?:\\s+this\\s+week)?|when\\s+am\\s+i\\s+busiest\\s+this\\s+week)$',
    workflow: {
      tools: [
        {
          name: 'get_events',
          input: { start_date: '{{dates.week_start}}', end_date: '{{dates.week_end}}', scope: '{{env.scope}}' },
        },
      ],
    },
    phrases: [
      'какой день на этой неделе самый загруженный',
      'мой самый загруженный день',
      'busiest day this week',
      'when am i busiest this week',
    ],
    trigger_words: ['загруженный', 'занятый', 'busiest', 'неделе', 'week'],
    source_message: 'какой день на этой неделе самый загруженный',
  },
];
