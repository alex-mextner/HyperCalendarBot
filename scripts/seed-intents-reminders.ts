// scripts/seed-intents-reminders.ts — Reminders category intent designs.
//
// Design notes (read before extending):
// - `set_reminder`'s `minutes_before: number[]` (and `create_event`'s
//   `reminder_minutes: number[]`) cannot be populated from a workflow: the
//   workflow-schema.ts `ToolInputSchema` is `z.record(z.string(), z.string())`
//   — every step input value must be a plain string — and every resolver/filter
//   path (captures, `tool_outputs.*`, all `applyFilters` branches) that could
//   produce a value for such a field ultimately yields a string, never a real
//   array. `set_reminder` and explicit `reminder_minutes` are therefore
//   unreachable from the intent DSL as it exists today. Every intent below
//   routes around this by using `create_event` WITHOUT `reminder_minutes`:
//   the reminder materializer (src/services/notification/materializer.ts)
//   automatically applies the user's `default_reminder_intervals` setting
//   (default `[30, 0]` — 30 min before + at start) whenever `reminder_minutes`
//   is omitted, and silently skips any computed reminder time that has
//   already passed (materializer.ts:78) — so a reminder "in 15 minutes" still
//   fires correctly via the "at start" (0) default even though the "30 min
//   before" default has already elapsed by creation time.
// - Absolute future timestamps ("in N minutes/hours", "N minutes before event
//   X") are computed via the real `calculate` tool
//   (src/services/ai/tool-handlers/calculate.ts), never via manual
//   hour/minute filter arithmetic — `calculate` handles ISO datetime +/-
//   duration correctly including month/day/hour rollover; hand-rolled
//   `{{dates.now|date('HH')|add(1)}}`-style arithmetic does NOT roll over
//   (verified: `new Date("...T24:30:00+03:00")` throws RangeError) and would
//   silently misfire once per day for anyone near a boundary.
// - `when` clause array indexing uses bracket syntax `arr[0].field`
//   (src/services/intent/expression-evaluator.ts parsePropertyAccess) — NOT
//   the dot-numeric `arr.0.field` that the *template* resolver's accessPath
//   accepts. The two evaluators have different grammars; `{{tool_outputs.x.0.id}}`
//   is correct inside `{{}}` templates, `tool_outputs.x[0].id` is correct
//   inside a `when` string. Mixing them up fails at runtime, not at schema
//   validation time (validateWorkflowVariables does not parse `when`).
// - "cancel a reminder" deletes the underlying event (search_events + guard +
//   delete_event) rather than clearing a reminder array, for the same
//   set_reminder-is-unreachable reason. This is correct for reminders created
//   by the intents below (they ARE plain events), but means a message like
//   "отмени напоминание про митинг" that happens to match a real, unrelated
//   meeting title will delete that meeting outright rather than just muting
//   its alert — flagged explicitly in the review pass, not a silent gap.
//
// All 8 entries were structurally validated against the real WorkflowSchema
// and validateWorkflowVariables (src/services/intent/workflow-schema.ts,
// workflow-validator.ts), checked against the real tool catalog
// (getToolDefinitions() in src/services/ai/tools.ts), and exercised end-to-end
// through the real IntentMatcher + IntentExecutor with stubbed tool responses
// (regex matching, capture extraction, guard branching, calculate wiring, and
// the numeric-typed event_id/tool_outputs chain all confirmed at runtime).
//
// Consumed by the integration/consolidation task — NOT run directly against
// the live DB by this file.

interface SeedIntent {
  canonical_name: string;
  pattern: string;
  workflow: object;
  phrases: string[];
  trigger_words: string[];
  source_message: string;
}

export const remindersIntents: SeedIntent[] = [
  // 1 ─── reminders_for_event ──────────────────────────────────────────────
  {
    canonical_name: 'reminders_for_event',
    pattern:
      '^(?:какие(?:\\s+у\\s+меня)?\\s+напоминани[яе]|напоминани[яе]|покажи\\s+напоминани[яе]|reminders?\\s+for|show\\s+(?:my\\s+)?reminders?\\s+for)\\s+(?:про|о|об|для|у|на)?\\s*(.+)$',
    workflow: {
      steps: [{ call: 'get_reminders', input: { query: '{{$1}}', scope: '{{env.scope}}' } }],
    },
    phrases: [],
    trigger_words: ['напоминания', 'напоминание', 'reminders', 'reminder'],
    source_message: 'какие у меня напоминания про стендап',
  },
  // 2 ─── remind_minutes_before_event ──────────────────────────────────────
  {
    canonical_name: 'remind_minutes_before_event',
    pattern:
      '^(?:напомни(?:\\s+мне)?\\s+за|remind\\s+me)\\s+(\\d{1,3})\\s+(?:минут[уы]?\\s+до|minutes?\\s+before)\\s+(.+)$',
    workflow: {
      steps: [
        { call: 'search_events', input: { query: '{{$2}}', scope: '{{env.scope}}' }, as: 'found' },
        { when: 'tool_outputs.found.length == 0', respond: '{{t.notfound}}' },
        {
          when: 'tool_outputs.found.length > 0 && tool_outputs.found[0].all_day == true',
          respond: '{{t.allday}}',
        },
        {
          when: 'tool_outputs.found.length > 0 && tool_outputs.found[0].all_day == false',
          call: 'calculate',
          input: {
            expression: '{{tool_outputs.found.0.date}}T{{tool_outputs.found.0.time}}:00{{user.utc_offset}} - {{$1}}min',
          },
          as: 'remind_at',
        },
        {
          when: 'tool_outputs.found.length > 0 && tool_outputs.found[0].all_day == false',
          call: 'create_event',
          input: { title: '{{t.title}}', start_at: '{{tool_outputs.remind_at}}', scope: '{{env.scope}}' },
        },
      ],
      i18n: {
        ru: {
          notfound: 'Не нашёл событие «{{$2}}» — уточни название.',
          allday: '«{{tool_outputs.found.0.title}}» — событие на весь день, точное время неизвестно.',
          title: 'Напоминание: {{tool_outputs.found.0.title}}',
        },
        en: {
          notfound: `Couldn't find an event called "{{$2}}" — try a different name.`,
          allday: '"{{tool_outputs.found.0.title}}" is an all-day event with no specific time.',
          title: 'Reminder: {{tool_outputs.found.0.title}}',
        },
      },
    },
    phrases: [],
    trigger_words: ['напомни', 'remind'],
    source_message: 'напомни за 15 минут до стендапа',
  },
  // 3 ─── remind_hours_before_event ────────────────────────────────────────
  {
    canonical_name: 'remind_hours_before_event',
    pattern:
      '^(?:напомни(?:\\s+мне)?\\s+за|remind\\s+me)\\s+(\\d{1,2})\\s+(?:час(?:а|ов)?\\s+до|hours?\\s+before)\\s+(.+)$',
    workflow: {
      steps: [
        { call: 'search_events', input: { query: '{{$2}}', scope: '{{env.scope}}' }, as: 'found' },
        { when: 'tool_outputs.found.length == 0', respond: '{{t.notfound}}' },
        {
          when: 'tool_outputs.found.length > 0 && tool_outputs.found[0].all_day == true',
          respond: '{{t.allday}}',
        },
        {
          when: 'tool_outputs.found.length > 0 && tool_outputs.found[0].all_day == false',
          call: 'calculate',
          input: {
            expression:
              '{{tool_outputs.found.0.date}}T{{tool_outputs.found.0.time}}:00{{user.utc_offset}} - {{$1}}hour',
          },
          as: 'remind_at',
        },
        {
          when: 'tool_outputs.found.length > 0 && tool_outputs.found[0].all_day == false',
          call: 'create_event',
          input: { title: '{{t.title}}', start_at: '{{tool_outputs.remind_at}}', scope: '{{env.scope}}' },
        },
      ],
      i18n: {
        ru: {
          notfound: 'Не нашёл событие «{{$2}}» — уточни название.',
          allday: '«{{tool_outputs.found.0.title}}» — событие на весь день, точное время неизвестно.',
          title: 'Напоминание: {{tool_outputs.found.0.title}}',
        },
        en: {
          notfound: `Couldn't find an event called "{{$2}}" — try a different name.`,
          allday: '"{{tool_outputs.found.0.title}}" is an all-day event with no specific time.',
          title: 'Reminder: {{tool_outputs.found.0.title}}',
        },
      },
    },
    phrases: [],
    trigger_words: ['напомни', 'remind'],
    source_message: 'напомни за 2 часа до встречи',
  },
  // 4 ─── remind_relative_minutes ──────────────────────────────────────────
  {
    canonical_name: 'remind_relative_minutes',
    pattern:
      '^(?:напомни(?:\\s+мне)?\\s+через|remind\\s+me\\s+in)\\s+(\\d{1,3})\\s+(?:минут[уы]?|minutes?)\\s+(?:мне\\s+)?(?:to\\s+)?(.+)$',
    workflow: {
      steps: [
        { call: 'calculate', input: { expression: '{{dates.now}} + {{$1}}min' }, as: 'remind_at' },
        {
          call: 'create_event',
          input: { title: '{{$2}}', start_at: '{{tool_outputs.remind_at}}', scope: '{{env.scope}}' },
        },
      ],
    },
    phrases: [],
    trigger_words: ['напомни', 'remind'],
    source_message: 'напомни через 15 минут позвонить маме',
  },
  // 5 ─── remind_relative_hours (1 or N hours, unified via default(1)) ─────
  {
    canonical_name: 'remind_relative_hours',
    pattern:
      '^(?:напомни(?:\\s+мне)?\\s+через|remind\\s+me\\s+in)\\s+(?:(\\d{1,2})\\s*|an\\s+)?(?:час(?:а|ов)?|hours?)\\s+(?:to\\s+)?(.+)$',
    workflow: {
      steps: [
        { call: 'calculate', input: { expression: '{{dates.now}} + {{$1|default(1)}}hour' }, as: 'remind_at' },
        {
          call: 'create_event',
          input: { title: '{{$2}}', start_at: '{{tool_outputs.remind_at}}', scope: '{{env.scope}}' },
        },
      ],
    },
    phrases: [],
    trigger_words: ['напомни', 'remind'],
    source_message: 'напомни через час позвонить маме',
  },
  // 6 ─── remind_at_time_today ─────────────────────────────────────────────
  {
    canonical_name: 'remind_at_time_today',
    pattern:
      '^(?:напомни(?:\\s+мне)?(?:\\s+сегодня)?\\s+в|remind\\s+me\\s+at)\\s+(2[0-3]|1\\d|0?\\d)\\s+(?:to\\s+)?(.+)$',
    workflow: {
      steps: [
        {
          when: 'isPastHour($1) == false',
          call: 'create_event',
          input: {
            title: '{{$2}}',
            start_at: '{{dates.today}}T{{$1|pad(2)}}:00:00{{user.utc_offset}}',
            scope: '{{env.scope}}',
          },
        },
        {
          when: 'isPastHour($1)',
          call: 'create_event',
          input: {
            title: '{{$2}}',
            start_at: '{{dates.tomorrow}}T{{$1|pad(2)}}:00:00{{user.utc_offset}}',
            scope: '{{env.scope}}',
          },
        },
      ],
    },
    phrases: [],
    trigger_words: ['напомни', 'remind'],
    source_message: 'напомни в 9 позвонить клиенту',
  },
  // 7 ─── remind_recurring_daily ───────────────────────────────────────────
  {
    canonical_name: 'remind_recurring_daily',
    pattern:
      '^(?:напоминай(?:\\s+мне)?\\s+каждый\\s+день\\s+в|remind\\s+me\\s+every\\s+day\\s+at)\\s+(2[0-3]|1\\d|0?\\d)\\s+(?:to\\s+)?(.+)$',
    workflow: {
      steps: [
        {
          when: 'isPastHour($1) == false',
          call: 'create_event',
          input: {
            title: '{{$2}}',
            start_at: '{{dates.today}}T{{$1|pad(2)}}:00:00{{user.utc_offset}}',
            recurrence_rule: 'FREQ=DAILY',
            scope: '{{env.scope}}',
          },
        },
        {
          when: 'isPastHour($1)',
          call: 'create_event',
          input: {
            title: '{{$2}}',
            start_at: '{{dates.tomorrow}}T{{$1|pad(2)}}:00:00{{user.utc_offset}}',
            recurrence_rule: 'FREQ=DAILY',
            scope: '{{env.scope}}',
          },
        },
      ],
    },
    phrases: [],
    trigger_words: ['напоминай', 'каждый', 'remind', 'every'],
    source_message: 'напоминай мне каждый день в 9 пить воду',
  },
  // 8 ─── cancel_reminder ──────────────────────────────────────────────────
  {
    canonical_name: 'cancel_reminder',
    pattern:
      '^(?:(?:отмени|убери|удали)\\s+напоминани[ея]|cancel\\s+(?:the\\s+)?reminder|delete\\s+(?:the\\s+)?reminder|remove\\s+(?:the\\s+)?reminder)\\s+(?:про|о|об|для|у|на|to|for|about)?\\s*(.+)$',
    workflow: {
      steps: [
        { call: 'search_events', input: { query: '{{$1}}', scope: '{{env.scope}}' }, as: 'found' },
        { when: 'tool_outputs.found.length == 0', respond: '{{t.notfound}}' },
        {
          when: 'tool_outputs.found.length > 0',
          call: 'delete_event',
          input: { event_id: '{{tool_outputs.found.0.id}}', scope: '{{env.scope}}' },
        },
      ],
      i18n: {
        ru: { notfound: 'Не нашёл напоминание «{{$1}}» — уточни название.' },
        en: { notfound: `Couldn't find a reminder called "{{$1}}" — try a different name.` },
      },
    },
    phrases: [],
    trigger_words: ['отмени', 'убери', 'удали', 'cancel', 'delete', 'remove'],
    source_message: 'отмени напоминание про стендап',
  },
];
