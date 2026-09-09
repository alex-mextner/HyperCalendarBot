// scripts/seed-intents-event-querying.ts — candidate intents for the "event querying beyond
// today/tomorrow/week" category (get_upcoming, a specific date, day-after-tomorrow, this month,
// next month, this weekend, events with a person, and event-count questions).
//
// NOT wired into scripts/seed-intents.ts and NOT run against any DB here — a separate
// integration pass consolidates every category file, dedupes canonical_name, and seeds once.
//
// Shape matches scripts/seed-intents.ts's SeedIntent literal exactly.
//
// Design notes from a 3-round multi-model review (review-cli brainstorm, task=INTENTS-EVENT-QUERYING):
// - get_upcoming's limit tool param is z.number() in src/services/ai/tool-schemas.ts, but every
//   value the workflow DSL can produce for a tool input is a string (ToolInputSchema is
//   z.record(z.string(), z.string()); resolveVariables only preserves a non-string type when the
//   template is a BARE {{var}} that itself resolves to a real number, which none of dates.*/$N/env.*/
//   user.* ever do). So no intent here passes a captured or literal number into limit — it is
//   either omitted (default 5) or the field simply isn't used by that tool.
// - IntentMatcher.match() returns captures: {} on an EXACT phrase-list hit (src/services/intent/
//   intent-matcher.ts:73-76), bypassing the regex entirely. Any intent whose workflow reads a capture
//   group ($1, $2, ...) therefore must NOT list a parameterized example (a phrase containing the
//   specific value) in phrases — an exact match on that literal example would zero out the
//   capture and render "{{$1}}" verbatim. show_specific_date and events_with_person below rely
//   solely on pattern (phrases: []) for this reason.

export type SeedIntent = {
  canonical_name: string;
  pattern: string;
  workflow: object;
  phrases: string[];
  trigger_words: string[];
  source_message: string;
};

export const eventQueryingIntents: SeedIntent[] = [
  // ─── get_upcoming_next ("what's next") ───────────────────────────────────────
  {
    canonical_name: 'get_upcoming_next',
    pattern:
      '^(?:что\\s+у\\s+меня\\s+дальше|что\\s+дальше|что\\s+у\\s+меня\\s+следующее|какое\\s+у\\s+меня\\s+следующее\\s+событие|моя\\s+следующая\\s+встреча|мое\\s+следующее\\s+событие|show\\s+(?:my\\s+)?next\\s+event|(?:what\\s+s|whats|what)\\s+next|next\\s+event|upcoming\\s+events?)$',
    workflow: {
      // No limit — get_upcoming's zod schema requires a real number, which the workflow
      // template DSL cannot produce; the tool already defaults to 5 when omitted.
      tools: [{ name: 'get_upcoming', input: { scope: '{{env.scope}}' } }],
    },
    phrases: [
      'что у меня дальше',
      'что дальше',
      'какое у меня следующее событие',
      'моя следующая встреча',
      'мое следующее событие',
      "what's next",
      'show my next event',
      'next event',
      'upcoming events',
    ],
    trigger_words: ['дальше', 'следующее', 'следующая', 'next', 'upcoming'],
    source_message: 'что у меня дальше',
  },

  // ─── show_specific_date ("what do I have on 25 12") ──────────────────────────
  // Numeric day/month only (no month names — no template mechanism to map "декабря" → 12);
  // assumes the current year. Punctuation like "25.12" normalizes to "25 12" before matching.
  // Openers require an explicit calendar word ("события"/"events") rather than bare
  // "покажи"/"show" — a bare opener would also match unrelated two-number messages
  // (e.g. "show 12:05", which normalizes to "show 12 05" since ":" is stripped too).
  // phrases: [] — see the file-header note on capture loss via exact-phrase matches.
  {
    canonical_name: 'show_specific_date',
    pattern:
      '^(?:что\\s+у\\s+меня|что\\s+будет|мои\\s+события|покажи\\s+события|show\\s+events|events)\\s+(?:на\\s+)?(?:on\\s+)?(0?[1-9]|[12]\\d|3[01])\\s+(0?[1-9]|1[0-2])$',
    workflow: {
      tools: [
        {
          name: 'get_events',
          input: {
            start_date: "{{dates.now|date('yyyy')}}-{{$2|pad(2)}}-{{$1|pad(2)}}",
            end_date: "{{dates.now|date('yyyy')}}-{{$2|pad(2)}}-{{$1|pad(2)}}",
            scope: '{{env.scope}}',
          },
        },
      ],
    },
    phrases: [],
    trigger_words: ['что', 'события', 'show', 'events'],
    source_message: 'что у меня 25 12',
  },

  // ─── show_day_after_tomorrow ──────────────────────────────────────────────────
  {
    canonical_name: 'show_day_after_tomorrow',
    pattern:
      '^(?:что\\s+у\\s+меня\\s+послезавтра|что\\s+послезавтра|мои\\s+события\\s+послезавтра|покажи\\s+послезавтра|show\\s+(?:the\\s+)?day\\s+after\\s+tomorrow|(?:what\\s+s|whats|what)\\s+(?:on\\s+)?(?:the\\s+)?day\\s+after\\s+tomorrow|day\\s+after\\s+tomorrow|events?\\s+day\\s+after\\s+tomorrow)$',
    workflow: {
      steps: [
        { call: 'calculate', input: { expression: '{{dates.tomorrow}} + 1 days' }, as: 'day_after_tomorrow' },
        {
          call: 'get_events',
          input: {
            start_date: '{{tool_outputs.day_after_tomorrow}}',
            end_date: '{{tool_outputs.day_after_tomorrow}}',
            scope: '{{env.scope}}',
          },
        },
      ],
    },
    phrases: [
      'что у меня послезавтра',
      'что послезавтра',
      'мои события послезавтра',
      'покажи послезавтра',
      'day after tomorrow',
      "what's the day after tomorrow",
      'show day after tomorrow',
    ],
    trigger_words: ['послезавтра', 'after', 'tomorrow'],
    source_message: 'что у меня послезавтра',
  },

  // ─── show_this_month ──────────────────────────────────────────────────────────
  {
    canonical_name: 'show_this_month',
    pattern:
      '^(?:что\\s+у\\s+меня\\s+в\\s+этом\\s+месяце|что\\s+в\\s+этом\\s+месяце|мои\\s+события\\s+(?:в\\s+)?этом\\s+месяце|покажи\\s+(?:этот\\s+)?месяц|(?:show|events?)\\s+this\\s+month|this\\s+month|(?:what\\s+s|whats|what)\\s+this\\s+month)$',
    workflow: {
      tools: [
        {
          name: 'get_events',
          input: { start_date: '{{dates.month_start}}', end_date: '{{dates.month_end}}', scope: '{{env.scope}}' },
        },
      ],
    },
    phrases: [
      'что у меня в этом месяце',
      'что в этом месяце',
      'мои события в этом месяце',
      'покажи месяц',
      'show this month',
      'this month',
      'events this month',
    ],
    trigger_words: ['месяце', 'месяц', 'month'],
    source_message: 'что у меня в этом месяце',
  },

  // ─── show_next_month ────────────────────────────────────────────────────────────
  // dates.next_month_start is always the 1st of next month (ALLOWED_VARS), so adding a
  // month to it is exact (no day-of-month clamping); the last day of next month is one
  // day before the 1st of the month after that — also always computed from a day-1 date.
  {
    canonical_name: 'show_next_month',
    pattern:
      '^(?:что\\s+у\\s+меня\\s+в\\s+следующем\\s+месяце|что\\s+в\\s+следующем\\s+месяце|мои\\s+события\\s+в\\s+следующем\\s+месяце|покажи\\s+следующий\\s+месяц|(?:show|events?)\\s+next\\s+month|next\\s+month)$',
    workflow: {
      steps: [
        {
          call: 'calculate',
          input: { expression: '{{dates.next_month_start}} + 1 months' },
          as: 'month_after_next_start',
        },
        {
          call: 'calculate',
          input: { expression: '{{tool_outputs.month_after_next_start}} - 1 days' },
          as: 'next_month_end',
        },
        {
          call: 'get_events',
          input: {
            start_date: '{{dates.next_month_start}}',
            end_date: '{{tool_outputs.next_month_end}}',
            scope: '{{env.scope}}',
          },
        },
      ],
    },
    phrases: [
      'что у меня в следующем месяце',
      'что в следующем месяце',
      'мои события в следующем месяце',
      'покажи следующий месяц',
      'show next month',
      'next month',
      'events next month',
    ],
    trigger_words: ['следующем', 'следующий', 'next', 'месяце', 'месяц', 'month'],
    source_message: 'что у меня в следующем месяце',
  },

  // ─── show_weekend ──────────────────────────────────────────────────────────────
  {
    canonical_name: 'show_weekend',
    pattern:
      '^(?:что\\s+у\\s+меня\\s+на\\s+выходных|что\\s+на\\s+выходных|мои\\s+события\\s+на\\s+выходных|покажи\\s+выходные|(?:show|events?)\\s+(?:this\\s+)?weekend|this\\s+weekend|(?:what\\s+s|whats|what)\\s+this\\s+weekend)$',
    workflow: {
      steps: [
        { call: 'calculate', input: { expression: '{{dates.week_end}} - 1 days' }, as: 'saturday' },
        {
          call: 'get_events',
          input: { start_date: '{{tool_outputs.saturday}}', end_date: '{{dates.week_end}}', scope: '{{env.scope}}' },
        },
      ],
    },
    phrases: [
      'что у меня на выходных',
      'что на выходных',
      'мои события на выходных',
      'покажи выходные',
      'this weekend',
      "what's this weekend",
      'show this weekend',
      'events this weekend',
    ],
    trigger_words: ['выходных', 'выходные', 'weekend'],
    source_message: 'что у меня на выходных',
  },

  // ─── events_with_person (also covers "when's my next meeting with X") ────────
  // Known limitation (accepted — matches the precedent already shipped in
  // search_events_by_query): search_events matches event TITLES, not participants, is not
  // limited to future occurrences, and is ordered by start_at ascending with no "next"
  // filter. It surfaces the right event for the common case (a title that names the
  // person) but is not a true participant-aware "next meeting with X" lookup — there is
  // no tool in src/services/ai/tools.ts for that. phrases: [] — see file-header note.
  {
    canonical_name: 'events_with_person',
    pattern:
      '^(?:когда\\s+(?:моя\\s+)?следующая\\s+встреча\\s+с\\s+|когда\\s+у\\s+меня\\s+встреча\\s+с\\s+|встречи\\s+с\\s+|события\\s+с\\s+|покажи\\s+встречи\\s+с\\s+|when\\s+is\\s+my\\s+next\\s+meeting\\s+with\\s+|(?:when\\s+s|whens|when)\\s+my\\s+next\\s+meeting\\s+with\\s+|meetings?\\s+with\\s+|events?\\s+with\\s+)(.+)$',
    workflow: {
      tools: [{ name: 'search_events', input: { query: '{{$1}}', scope: '{{env.scope}}' } }],
    },
    phrases: [],
    trigger_words: ['когда', 'следующая', 'встреча', 'встречи', 'события', 'with', 'meeting', 'meetings'],
    source_message: 'когда моя следующая встреча с ваней',
  },

  // ─── count_events_today ────────────────────────────────────────────────────────
  {
    canonical_name: 'count_events_today',
    pattern:
      '^(?:сколько\\s+(?:у\\s+меня\\s+)?(?:встреч|событий)\\s+сегодня|how\\s+many\\s+(?:meetings|events)\\s+today)$',
    workflow: {
      steps: [
        {
          call: 'get_events',
          input: { start_date: '{{dates.today}}', end_date: '{{dates.today}}', scope: '{{env.scope}}' },
          as: 'events',
        },
        { respond: '{{t.count}}' },
      ],
      i18n: {
        ru: { count: 'Сегодня событий: {{tool_outputs.events.length}}' },
        en: { count: 'Events today: {{tool_outputs.events.length}}' },
      },
    },
    phrases: [
      'сколько у меня встреч сегодня',
      'сколько событий сегодня',
      'сколько встреч сегодня',
      'how many meetings today',
      'how many events today',
    ],
    trigger_words: ['сколько', 'how', 'many'],
    source_message: 'сколько у меня встреч сегодня',
  },

  // ─── count_events_week ─────────────────────────────────────────────────────────
  {
    canonical_name: 'count_events_week',
    pattern:
      '^(?:сколько\\s+(?:у\\s+меня\\s+)?(?:встреч|событий)\\s+(?:на\\s+)?(?:этой\\s+)?неделе|how\\s+many\\s+(?:meetings|events)\\s+this\\s+week)$',
    workflow: {
      steps: [
        {
          call: 'get_events',
          input: { start_date: '{{dates.week_start}}', end_date: '{{dates.week_end}}', scope: '{{env.scope}}' },
          as: 'events',
        },
        { respond: '{{t.count}}' },
      ],
      i18n: {
        ru: { count: 'На этой неделе событий: {{tool_outputs.events.length}}' },
        en: { count: 'Events this week: {{tool_outputs.events.length}}' },
      },
    },
    phrases: [
      'сколько у меня встреч на этой неделе',
      'сколько событий на неделе',
      'сколько встреч на этой неделе',
      'how many meetings this week',
      'how many events this week',
    ],
    trigger_words: ['сколько', 'how', 'many'],
    source_message: 'сколько у меня встреч на этой неделе',
  },

  // ─── count_events_month ────────────────────────────────────────────────────────
  {
    canonical_name: 'count_events_month',
    pattern:
      '^(?:сколько\\s+(?:у\\s+меня\\s+)?(?:встреч|событий)\\s+в\\s+этом\\s+месяце|how\\s+many\\s+(?:meetings|events)\\s+this\\s+month)$',
    workflow: {
      steps: [
        {
          call: 'get_events',
          input: { start_date: '{{dates.month_start}}', end_date: '{{dates.month_end}}', scope: '{{env.scope}}' },
          as: 'events',
        },
        { respond: '{{t.count}}' },
      ],
      i18n: {
        ru: { count: 'В этом месяце событий: {{tool_outputs.events.length}}' },
        en: { count: 'Events this month: {{tool_outputs.events.length}}' },
      },
    },
    phrases: [
      'сколько у меня встреч в этом месяце',
      'сколько событий в этом месяце',
      'сколько встреч в этом месяце',
      'how many meetings this month',
      'how many events this month',
    ],
    trigger_words: ['сколько', 'how', 'many'],
    source_message: 'сколько у меня встреч в этом месяце',
  },
];
