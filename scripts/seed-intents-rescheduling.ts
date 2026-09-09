// scripts/seed-intents-rescheduling.ts — pre-approved intents for event rescheduling & snoozing.
//
// Category: postponing an event by a fixed amount ("перенеси на 15 минут"), pulling it earlier
// ("подвинь пораньше"), and shifting it to tomorrow / next week / a specific tomorrow slot.
//
// Every workflow resolves the target event via {{last_mentioned_event.id}} — the event most
// recently referenced in the conversation (set by any prior tool call that returned event data,
// e.g. a search, a creation, or a previous reschedule). This mirrors the already-approved
// `update_event_time` intent, which uses the same mechanism.
//
// NOT wired into scripts/seed-intents.ts and NOT run against any DB — a separate integration
// pass consolidates every category's file, dedupes canonical_names, and seeds once.
//
// ── Design notes from a 3-round multi-model review (see task report for full detail) ──
//
// 1. TIME CAPTURES USE A SPACE, NOT A COLON. normalizer.ts strips `:` (with other punctuation)
//    before pattern matching runs, so "15:00" reaches the regex as "15 00". A colon-based capture
//    group (as the already-approved `update_event_time` intent uses) can never match live traffic.
//
// 2. `snooze_event`'s `minutes` field is `z.number().optional()` in tool-schemas.ts, and every
//    workflow input value is a STRING by DSL design (ToolInputSchema = z.record(string, string) in
//    workflow-schema.ts). A templated OR hardcoded `minutes` value therefore always arrives as a
//    string and is REJECTED by `dispatchTool`'s `schema.safeParse(input)` before the handler ever
//    runs (verified directly against the real zod schema and the real resolveVariables output).
//    `snooze_event` is only usable here with `minutes` OMITTED entirely (its server-side +10min
//    default). Every amount-based reschedule below instead uses `calculate` (whose only field is
//    `expression: z.string()` — no numeric coercion wall) to compute a new ISO datetime, then
//    `update_event` to apply it. This is the only route through the current DSL that can honor a
//    user-specified amount.
//
// 3. DURATION IS NOT PRESERVED on a retime — only `start_at` is set, `end_at` is left untouched.
//    This matches the existing approved `update_event_time` intent's own behavior (it never
//    touches `end_at` either). Auto-shifting `end_at` in lockstep would need either a second
//    `calculate` call per intent (which fails the whole workflow — visibly, not silently — for the
//    common case of an event with no `end_at` at all, since the resolver leaves an unresolved
//    `{{last_mentioned_event.end_at}}` template in that case and `calculate` then rejects it) or a
//    duration-preserving primitive the DSL does not have. Matching the established precedent (only
//    `start_at`) was chosen over introducing a new failure mode. `snooze_event_default` below is the
//    one exception — the native tool shifts `start_at` AND `end_at` together, so it keeps duration
//    intact for the bare (+10min) case.
//
// 4. NO PARAMETERIZED EXAMPLE PHRASES. `IntentMatcher.match` returns `captures: {}` on an exact
//    `phrases[]` hit, bypassing the regex (and its capture groups) entirely — confirmed against
//    intent-matcher.ts. An exact phrase like "перенеси на 15 минут" would reach the workflow with
//    `$1` unresolved. Intents whose workflow depends on a capture group therefore ship with an
//    EMPTY `phrases` array and rely solely on `trigger_words` + `pattern`; only intents with no
//    capture-dependent workflow keep example phrases as a matcher fast path.
//
// 5. "move to next week" / "move earlier" / "snooze N minutes" shift the UTC instant by a fixed
//    number of milliseconds (via `calculate`'s ISO-datetime ± duration path), same as the
//    `snooze_event` tool itself does. Twice a year, for a shift that spans a DST transition, this
//    changes the local wall-clock time by ±1h. No calendar-aware "same local time, N days later"
//    primitive exists anywhere in this system (tool or DSL) to avoid it.

const intents: Array<{
  canonical_name: string;
  pattern: string;
  workflow: object;
  phrases: string[];
  trigger_words: string[];
  source_message: string;
}> = [
  // ─── snooze_event_minutes (no phrases — capture-dependent, see note 4) ───────
  {
    canonical_name: 'snooze_event_minutes',
    pattern:
      '^(?:перенеси|отложи|сдвинь|push\\s+back|postpone|snooze|delay)\\s+(?:(?:на|by|for)\\s+)?(\\d{1,3})\\s*(?:минут(?:у|ы)?|мин|min(?:ute)?s?)$',
    workflow: {
      steps: [
        {
          call: 'calculate',
          input: {
            expression:
              '{{last_mentioned_event.date}}T{{last_mentioned_event.time|default("00:00")}}:00{{user.utc_offset}} + {{$1}}min',
          },
          as: 'new_start',
        },
        {
          call: 'update_event',
          input: {
            event_id: '{{last_mentioned_event.id}}',
            start_at: '{{tool_outputs.new_start}}',
            scope: '{{env.scope}}',
          },
        },
      ],
    },
    phrases: [],
    trigger_words: ['перенеси', 'отложи', 'сдвинь', 'push', 'postpone', 'snooze', 'delay'],
    source_message: 'перенеси на 15 минут',
  },

  // ─── snooze_event_hours (no phrases — capture-dependent) ─────────────────────
  {
    canonical_name: 'snooze_event_hours',
    pattern:
      '^(?:перенеси|отложи|сдвинь|push\\s+back|postpone|snooze|delay)\\s+(?:(?:на|by|for)\\s+)?(\\d{1,2})\\s*(?:час(?:а|ов)?|ч|hours?|hrs?)$',
    workflow: {
      steps: [
        {
          call: 'calculate',
          input: {
            expression:
              '{{last_mentioned_event.date}}T{{last_mentioned_event.time|default("00:00")}}:00{{user.utc_offset}} + {{$1}}hour',
          },
          as: 'new_start',
        },
        {
          call: 'update_event',
          input: {
            event_id: '{{last_mentioned_event.id}}',
            start_at: '{{tool_outputs.new_start}}',
            scope: '{{env.scope}}',
          },
        },
      ],
    },
    phrases: [],
    trigger_words: [
      'перенеси',
      'отложи',
      'сдвинь',
      'push',
      'postpone',
      'snooze',
      'delay',
      'час',
      'часа',
      'часов',
      'hour',
      'hours',
    ],
    source_message: 'перенеси на 2 часа',
  },

  // ─── snooze_event_default (bare — no amount, native tool preserves duration) ─
  {
    canonical_name: 'snooze_event_default',
    pattern:
      '^(?:перенеси(?:\\s+его)?|отложи(?:\\s+его)?|push\\s+it\\s+back|postpone\\s+it|delay\\s+it|snooze\\s+it|snooze)$',
    workflow: {
      tools: [{ name: 'snooze_event', input: { event_id: '{{last_mentioned_event.id}}', scope: '{{env.scope}}' } }],
    },
    phrases: [
      'перенеси',
      'отложи',
      'перенеси его',
      'отложи его',
      'push it back',
      'postpone it',
      'delay it',
      'snooze it',
      'snooze',
    ],
    trigger_words: ['перенеси', 'отложи', 'push', 'postpone', 'delay', 'snooze'],
    source_message: 'перенеси',
  },

  // ─── move_event_earlier_minutes (no phrases — capture-dependent) ─────────────
  {
    canonical_name: 'move_event_earlier_minutes',
    pattern:
      '^(?:(?:подвинь|перенеси|сделай|сдвинь)\\s+(?:событие\\s+)?пораньше|move\\s+(?:it\\s+)?(?:up|earlier)|bring\\s+(?:it\\s+)?forward)\\s+(?:на\\s+|by\\s+)?(\\d{1,3})\\s*(?:минут(?:у|ы)?|мин|min(?:ute)?s?)$',
    workflow: {
      steps: [
        {
          call: 'calculate',
          input: {
            expression:
              '{{last_mentioned_event.date}}T{{last_mentioned_event.time|default("00:00")}}:00{{user.utc_offset}} - {{$1}}min',
          },
          as: 'new_start',
        },
        {
          call: 'update_event',
          input: {
            event_id: '{{last_mentioned_event.id}}',
            start_at: '{{tool_outputs.new_start}}',
            scope: '{{env.scope}}',
          },
        },
      ],
    },
    phrases: [],
    trigger_words: ['подвинь', 'перенеси', 'сделай', 'сдвинь', 'пораньше', 'move', 'bring', 'earlier', 'forward', 'up'],
    source_message: 'подвинь пораньше на 15 минут',
  },

  // ─── move_event_earlier_hours (no phrases — capture-dependent) ───────────────
  {
    canonical_name: 'move_event_earlier_hours',
    pattern:
      '^(?:(?:подвинь|перенеси|сделай|сдвинь)\\s+(?:событие\\s+)?пораньше|move\\s+(?:it\\s+)?(?:up|earlier)|bring\\s+(?:it\\s+)?forward)\\s+(?:на\\s+|by\\s+)?(\\d{1,2})\\s*(?:час(?:а|ов)?|ч|hours?|hrs?)$',
    workflow: {
      steps: [
        {
          call: 'calculate',
          input: {
            expression:
              '{{last_mentioned_event.date}}T{{last_mentioned_event.time|default("00:00")}}:00{{user.utc_offset}} - {{$1}}hour',
          },
          as: 'new_start',
        },
        {
          call: 'update_event',
          input: {
            event_id: '{{last_mentioned_event.id}}',
            start_at: '{{tool_outputs.new_start}}',
            scope: '{{env.scope}}',
          },
        },
      ],
    },
    phrases: [],
    trigger_words: [
      'подвинь',
      'перенеси',
      'сделай',
      'сдвинь',
      'пораньше',
      'move',
      'bring',
      'earlier',
      'forward',
      'up',
      'час',
      'часа',
      'часов',
      'hour',
      'hours',
    ],
    source_message: 'подвинь пораньше на 1 час',
  },

  // ─── move_event_earlier_default (bare — no amount, fixed 15-minute pull-forward) ─
  {
    canonical_name: 'move_event_earlier_default',
    pattern:
      '^(?:(?:подвинь|перенеси|сделай|сдвинь)\\s+(?:событие\\s+)?пораньше|move\\s+it\\s+up|move\\s+it\\s+earlier|move\\s+up|move\\s+earlier|bring\\s+it\\s+forward)$',
    workflow: {
      steps: [
        {
          call: 'calculate',
          input: {
            expression:
              '{{last_mentioned_event.date}}T{{last_mentioned_event.time|default("00:00")}}:00{{user.utc_offset}} - 15min',
          },
          as: 'new_start',
        },
        {
          call: 'update_event',
          input: {
            event_id: '{{last_mentioned_event.id}}',
            start_at: '{{tool_outputs.new_start}}',
            scope: '{{env.scope}}',
          },
        },
      ],
    },
    phrases: [
      'подвинь пораньше',
      'сдвинь пораньше',
      'перенеси пораньше',
      'move it up',
      'move earlier',
      'bring it forward',
    ],
    trigger_words: ['подвинь', 'перенеси', 'сделай', 'сдвинь', 'пораньше', 'move', 'bring', 'earlier', 'forward', 'up'],
    source_message: 'подвинь пораньше',
  },

  // ─── move_event_to_tomorrow (shifts by exactly +1 day — same time, preserves duration) ─
  {
    canonical_name: 'move_event_to_tomorrow',
    pattern:
      '^(?:(?:перенеси|передвинь)\\s+(?:событие\\s+)?на\\s+завтра|(?:move|reschedule)\\s+(?:it\\s+)?to\\s+tomorrow)$',
    workflow: {
      steps: [
        {
          call: 'calculate',
          input: {
            expression:
              '{{last_mentioned_event.date}}T{{last_mentioned_event.time|default("00:00")}}:00{{user.utc_offset}} + 1days',
          },
          as: 'new_start',
        },
        {
          call: 'update_event',
          input: {
            event_id: '{{last_mentioned_event.id}}',
            start_at: '{{tool_outputs.new_start}}',
            scope: '{{env.scope}}',
          },
        },
      ],
    },
    phrases: [
      'перенеси на завтра',
      'перенеси событие на завтра',
      'передвинь на завтра',
      'move it to tomorrow',
      'reschedule to tomorrow',
    ],
    trigger_words: ['перенеси', 'передвинь', 'move', 'reschedule', 'tomorrow', 'завтра'],
    source_message: 'перенеси на завтра',
  },

  // ─── move_event_to_next_week (shifts by exactly +7 days — same weekday, same time; DST caveat, see note 5) ─
  {
    canonical_name: 'move_event_to_next_week',
    pattern:
      '^(?:(?:перенеси|передвинь)\\s+(?:событие\\s+)?на\\s+(?:следующую\\s+неделю|след\\s+неделю)|(?:move|reschedule)\\s+(?:it\\s+)?to\\s+next\\s+week)$',
    workflow: {
      steps: [
        {
          call: 'calculate',
          input: {
            expression:
              '{{last_mentioned_event.date}}T{{last_mentioned_event.time|default("00:00")}}:00{{user.utc_offset}} + 7days',
          },
          as: 'new_start',
        },
        {
          call: 'update_event',
          input: {
            event_id: '{{last_mentioned_event.id}}',
            start_at: '{{tool_outputs.new_start}}',
            scope: '{{env.scope}}',
          },
        },
      ],
    },
    phrases: [
      'перенеси на следующую неделю',
      'передвинь на следующую неделю',
      'move it to next week',
      'reschedule to next week',
    ],
    trigger_words: ['перенеси', 'передвинь', 'move', 'reschedule', 'неделю', 'week'],
    source_message: 'перенеси на следующую неделю',
  },

  // ─── reschedule_event_to_tomorrow_at_time (day change + explicit new time; no phrases — capture-dependent) ─
  {
    canonical_name: 'reschedule_event_to_tomorrow_at_time',
    pattern:
      '^(?:перенеси|передвинь|move|reschedule)\\s+(?:событие\\s+|it\\s+)?(?:на\\s+завтра\\s+(?:в|на)|to\\s+tomorrow\\s+at)\\s+([01]?\\d|2[0-3])\\s+([0-5]\\d)$',
    workflow: {
      tools: [
        {
          name: 'update_event',
          input: {
            event_id: '{{last_mentioned_event.id}}',
            start_at: '{{dates.tomorrow}}T{{$1|pad(2)}}:{{$2}}:00{{user.utc_offset}}',
            scope: '{{env.scope}}',
          },
        },
      ],
    },
    phrases: [],
    trigger_words: ['перенеси', 'передвинь', 'move', 'reschedule', 'tomorrow', 'завтра'],
    source_message: 'перенеси на завтра в 15:00',
  },
];

export { intents as reschedulingIntents };
