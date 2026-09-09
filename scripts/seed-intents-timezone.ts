// scripts/seed-intents-timezone.ts — timezone/time-query intents (category: timezone)
//
// NOT run automatically — a separate integration task consolidates every
// scripts/seed-intents-<category>.ts file, dedupes canonical_names, and runs
// the real seed against data/calendar.db. Do not import bun:sqlite here.

export interface SeedIntent {
  canonical_name: string;
  pattern: string | null;
  workflow: object;
  phrases: string[];
  trigger_words: string[];
  source_message: string;
  format?: string;
}

export const timezoneIntents: SeedIntent[] = [
  // ─── current_time_in_city ───────────────────────────────────────────────────
  // "сколько сейчас времени в Лондоне" / "what time is it in London"
  {
    canonical_name: 'current_time_in_city',
    pattern:
      '^(?:сколько\\s+(?:сейчас\\s+)?врем(?:я|ени)|который\\s+час|какое\\s+(?:сейчас\\s+)?время|время|what\\s+time|current\\s+time|time)\\s+(?:is\\s+it\\s+in|в|во|in)\\s+(.+)$',
    workflow: {
      steps: [
        {
          call: 'get_timezone_info',
          input: { timezone: '{{$1}}', at: '{{dates.now}}' },
          as: 'tz_info',
        },
        { respond: '{{t.msg}}' },
      ],
      i18n: {
        ru: {
          msg: '🕐 {{tool_outputs.tz_info.local_time|date("HH:mm")}} в {{$1}} (UTC{{tool_outputs.tz_info.utc_offset}})',
        },
        en: {
          msg: '🕐 {{tool_outputs.tz_info.local_time|date("h:mm a")}} in {{$1}} (UTC{{tool_outputs.tz_info.utc_offset}})',
        },
      },
    },
    // Parameterized intent — phrases MUST be empty (per learner-prompt.ts's own rule):
    // any exact-match phrase here would short-circuit IntentMatcher.match() via the
    // phraseMap BEFORE the regex ever runs, returning captures: {} and breaking the
    // {{$1}} template. Matching relies entirely on pattern + trigger_words.
    phrases: [],
    trigger_words: ['время', 'времени', 'час', 'time'],
    source_message: 'сколько сейчас времени в Лондоне',
    format: 'text',
  },

  // ─── convert_my_time_to_city ─────────────────────────────────────────────────
  // "переведи 15:00 в Нью-Йорк" / "convert 15:00 to New York" — HH[:MM] is the
  // sender's own local time (their utc_offset), converted to the target city.
  {
    canonical_name: 'convert_my_time_to_city',
    pattern:
      // normalize() strips ":" to a space before pattern.exec() runs (see
      // normalizer.ts's PUNCTUATION_RE), so "15:00" arrives as "15 00" — the
      // hour/minute separator here MUST be \\s+, never a literal colon.
      '^(?:переведи|конвертируй|convert)\\s+(2[0-3]|1\\d|0?\\d)(?:\\s+([0-5]\\d))?\\s+(?:в|to)\\s+(?:время\\s+|часовой\\s+пояс\\s+)?(.+)$',
    workflow: {
      steps: [
        {
          call: 'get_timezone_info',
          input: {
            timezone: '{{$3}}',
            at: '{{dates.today}}T{{$1|pad(2)}}:{{$2|default("00")|pad(2)}}:00{{user.utc_offset}}',
          },
          as: 'tz_info',
        },
        { respond: '{{t.msg}}' },
      ],
      i18n: {
        ru: {
          msg:
            '🕐 {{$1|pad(2)}}:{{$2|default("00")|pad(2)}} у тебя — это {{tool_outputs.tz_info.local_time|date("HH:mm")}} ' +
            'в {{$3}} (UTC{{tool_outputs.tz_info.utc_offset}})',
        },
        en: {
          msg:
            '🕐 {{$1|pad(2)}}:{{$2|default("00")|pad(2)}} your time is {{tool_outputs.tz_info.local_time|date("h:mm a")}} ' +
            'in {{$3}} (UTC{{tool_outputs.tz_info.utc_offset}})',
        },
      },
    },
    // Parameterized intent — phrases MUST be empty; see current_time_in_city's comment.
    phrases: [],
    trigger_words: ['переведи', 'конвертируй', 'convert'],
    source_message: 'переведи 15:00 в Нью-Йорк',
    format: 'text',
  },

  // ─── current_timezone_setting ────────────────────────────────────────────────
  // "какой у меня часовой пояс" / "what's my timezone" — zero tool calls, reads
  // the sender's own profile context (already resolved per-request).
  {
    canonical_name: 'current_timezone_setting',
    pattern: null,
    workflow: {
      steps: [{ respond: '{{t.msg}}' }],
      i18n: {
        ru: { msg: '🌍 Твой часовой пояс — {{user.timezone}} (UTC{{user.utc_offset}})' },
        en: { msg: '🌍 Your timezone is {{user.timezone}} (UTC{{user.utc_offset}})' },
      },
    },
    phrases: [
      'какой у меня часовой пояс',
      'мой часовой пояс',
      'в каком я часовом поясе',
      "what's my timezone",
      'what is my timezone',
      'what timezone am i in',
      'my timezone',
      'check my timezone',
    ],
    trigger_words: ['часовой', 'пояс', 'timezone'],
    source_message: 'какой у меня часовой пояс',
    format: 'text',
  },

  // ─── world_clock_common_cities ───────────────────────────────────────────────
  // "мировые часы" / "world clock" — live current time snapshot across a fixed
  // set of major cities. Each city is a separate call (workflow input values
  // must be plain strings — the tool's array-comparison mode isn't reachable
  // from the workflow DSL), so five deterministic literal calls, not one array call.
  {
    canonical_name: 'world_clock_common_cities',
    pattern: null,
    workflow: {
      steps: [
        { call: 'get_timezone_info', input: { timezone: 'Europe/Moscow' }, as: 'moscow' },
        { call: 'get_timezone_info', input: { timezone: 'Europe/London' }, as: 'london' },
        { call: 'get_timezone_info', input: { timezone: 'America/New_York' }, as: 'newyork' },
        { call: 'get_timezone_info', input: { timezone: 'Asia/Dubai' }, as: 'dubai' },
        { call: 'get_timezone_info', input: { timezone: 'Asia/Tokyo' }, as: 'tokyo' },
        { respond: '{{t.msg}}' },
      ],
      i18n: {
        ru: {
          msg:
            '🌍 Москва {{tool_outputs.moscow.local_time|date("HH:mm")}} · Лондон {{tool_outputs.london.local_time|date("HH:mm")}} · ' +
            'Нью-Йорк {{tool_outputs.newyork.local_time|date("HH:mm")}} · Дубай {{tool_outputs.dubai.local_time|date("HH:mm")}} · ' +
            'Токио {{tool_outputs.tokyo.local_time|date("HH:mm")}}',
        },
        en: {
          msg:
            '🌍 Moscow {{tool_outputs.moscow.local_time|date("h:mm a")}} · London {{tool_outputs.london.local_time|date("h:mm a")}} · ' +
            'New York {{tool_outputs.newyork.local_time|date("h:mm a")}} · Dubai {{tool_outputs.dubai.local_time|date("h:mm a")}} · ' +
            'Tokyo {{tool_outputs.tokyo.local_time|date("h:mm a")}}',
        },
      },
    },
    phrases: [
      'который час сейчас в разных городах',
      'мировые часы',
      'сколько сейчас времени по всему миру',
      'world clock',
      'current time around the world',
      'time in major cities right now',
    ],
    trigger_words: ['мировые', 'часы', 'world', 'clock'],
    source_message: 'мировые часы',
    format: 'text',
  },

  // ─── list_common_timezone_shortcuts ──────────────────────────────────────────
  // "список часовых поясов" / "list of timezones" — static IANA-name cheat
  // sheet (distinct from world_clock_common_cities: this is a reference list of
  // zone NAMES, not a live time snapshot). Zero tool calls.
  {
    canonical_name: 'list_common_timezone_shortcuts',
    pattern: null,
    workflow: {
      steps: [{ respond: '{{t.msg}}' }],
      i18n: {
        ru: {
          msg:
            '🌍 Частые часовые пояса:\nМосква — Europe/Moscow\nЛондон — Europe/London\nНью-Йорк — America/New_York\n' +
            'Дубай — Asia/Dubai\nТокио — Asia/Tokyo\nБерлин — Europe/Berlin\nПариж — Europe/Paris\n\n' +
            'Напиши «сколько времени в <город>», чтобы узнать точное время.',
        },
        en: {
          msg:
            '🌍 Common timezones:\nMoscow — Europe/Moscow\nLondon — Europe/London\nNew York — America/New_York\n' +
            'Dubai — Asia/Dubai\nTokyo — Asia/Tokyo\nBerlin — Europe/Berlin\nParis — Europe/Paris\n\n' +
            'Type "what time is it in <city>" to check the exact time.',
        },
      },
    },
    phrases: [
      'список часовых поясов',
      'какие бывают часовые пояса',
      'покажи часовые пояса',
      'list of timezone names',
      'timezone abbreviations',
      'show me timezone names',
    ],
    trigger_words: ['список', 'пояса', 'поясов', 'timezones', 'abbreviations'],
    source_message: 'список часовых поясов',
    format: 'text',
  },

  // ─── time_now_own_timezone ───────────────────────────────────────────────────
  // "сколько сейчас времени" / "what time is it" (no city) — the sender's own
  // current time. Exact-phrase only, so it never competes with
  // current_time_in_city's pattern (which requires a trailing "в/in <city>").
  {
    canonical_name: 'time_now_own_timezone',
    pattern: null,
    workflow: {
      steps: [{ respond: '{{t.msg}}' }],
      i18n: {
        ru: { msg: '🕐 Сейчас {{dates.now|date("HH:mm")}} ({{user.timezone}})' },
        en: { msg: '🕐 It is {{dates.now|date("h:mm a")}} ({{user.timezone}})' },
      },
    },
    phrases: [
      'сколько сейчас времени',
      'который час',
      'сколько времени',
      'what time is it',
      'what time is it now',
      'current time now',
      'tell me the time',
    ],
    trigger_words: ['время', 'час', 'time'],
    source_message: 'сколько сейчас времени',
    format: 'text',
  },
];
