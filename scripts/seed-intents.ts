// scripts/seed-intents.ts — seed standard intents into calendar.db
// Run: bun scripts/seed-intents.ts

import { Database } from 'bun:sqlite';

const db = new Database('data/calendar.db');

const intents: Array<{
  canonical_name: string;
  pattern: string;
  workflow: object;
  phrases: string[];
  trigger_words: string[];
  source_message: string;
}> = [
  // ─── show_today ─────────────────────────────────────────────────────────────
  {
    canonical_name: 'show_today',
    pattern:
      "^(?:что\\s+у\\s+(?:меня|нас)\\s+сегодня|что\\s+сегодня|мои\\s+события\\s+сегодня|покажи\\s+сегодня|what's?\\s+today|show\\s+today|events?\\s+today)\\??$",
    workflow: {
      steps: [
        {
          call: 'get_events',
          input: { start_date: '{{dates.today}}', end_date: '{{dates.today}}', scope: '{{env.scope}}' },
        },
      ],
    },
    phrases: ['что у меня сегодня', 'что у нас сегодня', 'что сегодня', "what's today", 'show today'],
    trigger_words: ['сегодня', 'today'],
    source_message: 'что у меня сегодня',
  },

  // ─── show_tomorrow ──────────────────────────────────────────────────────────
  {
    canonical_name: 'show_tomorrow',
    pattern:
      "^(?:что\\s+у\\s+меня\\s+завтра|что\\s+завтра|мои\\s+события\\s+завтра|покажи\\s+завтра|what's?\\s+tomorrow|show\\s+tomorrow|events?\\s+tomorrow)\\??$",
    workflow: {
      steps: [
        {
          call: 'get_events',
          input: { start_date: '{{dates.tomorrow}}', end_date: '{{dates.tomorrow}}', scope: '{{env.scope}}' },
        },
      ],
    },
    phrases: ['что у меня завтра', 'что завтра', "what's tomorrow", 'show tomorrow'],
    trigger_words: ['завтра', 'tomorrow'],
    source_message: 'что у меня завтра',
  },

  // ─── show_week ──────────────────────────────────────────────────────────────
  {
    canonical_name: 'show_week',
    pattern:
      "^(?:что\\s+у\\s+меня\\s+(?:на\\s+)?(?:этой\\s+)?неделе|расписание\\s+(?:на\\s+)?(?:эту\\s+)?неделю|what's?\\s+this\\s+week|show\\s+(?:this\\s+)?week|this\\s+week)\\??$",
    workflow: {
      steps: [
        {
          call: 'get_events',
          input: { start_date: '{{dates.week_start}}', end_date: '{{dates.week_end}}', scope: '{{env.scope}}' },
        },
      ],
    },
    phrases: ['что у меня на неделе', 'расписание на неделю', 'show this week', 'this week'],
    trigger_words: ['неделе', 'неделю', 'week'],
    source_message: 'что у меня на неделе',
  },

  // ─── free_slots_today ───────────────────────────────────────────────────────
  {
    canonical_name: 'free_slots_today',
    pattern:
      '^(?:когда\\s+(?:я\\s+)?свободен(?:\\s+сегодня)?|свободные\\s+(?:окна|слоты)(?:\\s+сегодня)?|free\\s+slots?(?:\\s+today)?|when\\s+am\\s+i\\s+free(?:\\s+today)?)\\??$',
    workflow: {
      steps: [{ call: 'get_free_slots', input: { date: '{{dates.today}}', scope: '{{env.scope}}' } }],
    },
    phrases: ['когда я свободен', 'свободные окна сегодня', 'free slots today', 'when am I free'],
    trigger_words: ['свободен', 'свободные', 'free', 'slots'],
    source_message: 'когда я свободен сегодня',
  },

  // ─── search_events_by_query ─────────────────────────────────────────────────
  {
    canonical_name: 'search_events_by_query',
    pattern:
      '^(?:найди|поищи|find|search)\\s+(?:событи[ея]|встреч[иу]|events?|meetings?)\\s+(?:про|о|by|about|with\\s+)?(.+)$',
    workflow: {
      steps: [{ call: 'search_events', input: { query: '{{$1}}', scope: '{{env.scope}}' } }],
    },
    phrases: ['найди встречи про стендап', 'search events about standup', 'find events by project'],
    trigger_words: ['найди', 'поищи', 'find', 'search'],
    source_message: 'найди встречи про стендап',
  },

  // ─── create_event_named_tomorrow (with conflict check) ──────────────────────
  {
    canonical_name: 'create_event_named_tomorrow',
    pattern:
      '^(?:сделай|создай|запланируй|create|schedule|make)\\s+(.+?)\\s+(?:завтра\\s+(?:в|на)|tomorrow\\s+at)\\s+(2[0-3]|1\\d|0?\\d)$',
    workflow: {
      steps: [
        {
          call: 'get_events',
          input: {
            start_date: '{{dates.tomorrow}}T{{$2|pad(2)}}:00:00{{user.utc_offset}}',
            end_date: '{{dates.tomorrow}}T{{$2|pad(2)}}:59:59{{user.utc_offset}}',
            scope: '{{env.scope}}',
          },
          as: 'slot_events',
        },
        {
          call: 'ask_user',
          input: { question: '{{t.q}}', options: ['{{t.yes}}', '{{t.no}}'] },
          as: 'confirm|lower',
        },
        {
          when: "ask.confirm == 'да' || ask.confirm == 'yes'",
          call: 'create_event',
          input: {
            title: '{{$1}}',
            start_at: '{{dates.tomorrow}}T{{$2|pad(2)}}:00:00{{user.utc_offset}}',
            scope: '{{env.scope}}',
          },
        },
      ],
      i18n: {
        ru: { q: 'В {{$2}}:00 завтра:\n{{slot_events}}\n\nСоздать «{{$1}}»?', yes: 'Да', no: 'Нет' },
        en: { q: 'At {{$2}}:00 tomorrow:\n{{slot_events}}\n\nCreate «{{$1}}»?', yes: 'Yes', no: 'No' },
      },
    },
    phrases: ['создай стендап завтра в 10', 'make standup tomorrow at 10', 'schedule meeting tomorrow at 15'],
    trigger_words: ['завтра', 'tomorrow'],
    source_message: 'создай стендап завтра в 10',
  },
];

const upsert = db.prepare(`
  INSERT INTO intents (canonical_name, phrases, trigger_words, pattern, workflow, format, status, source_message, created_at)
  VALUES (?, ?, ?, ?, ?, 'text', 'approved', ?, datetime('now'))
  ON CONFLICT(canonical_name) DO UPDATE SET
    phrases       = excluded.phrases,
    trigger_words = excluded.trigger_words,
    pattern       = excluded.pattern,
    workflow      = excluded.workflow,
    format        = 'text',
    status        = 'approved'
`);

let added = 0;
let updated = 0;

for (const intent of intents) {
  const existing = db.query('SELECT id FROM intents WHERE canonical_name = ?').get(intent.canonical_name);
  upsert.run(
    intent.canonical_name,
    JSON.stringify(intent.phrases),
    JSON.stringify(intent.trigger_words),
    intent.pattern,
    JSON.stringify(intent.workflow),
    intent.source_message,
  );
  if (existing) {
    console.log(`↺  updated: ${intent.canonical_name}`);
    updated++;
  } else {
    console.log(`+  added:   ${intent.canonical_name}`);
    added++;
  }
}

console.log(`\nDone: ${added} added, ${updated} updated.`);
const total = (db.query('SELECT COUNT(*) as n FROM intents').get() as { n: number }).n;
console.log(`Total intents in DB: ${total}`);
