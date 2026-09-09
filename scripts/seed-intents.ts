// scripts/seed-intents.ts — seed standard + domain intents into calendar.db
// Run: bun scripts/seed-intents.ts

import { Database } from 'bun:sqlite';
import { getToolDefinitions } from '../src/services/ai/tools.ts';
import type { Workflow } from '../src/services/intent/workflow-schema.ts';
import { WorkflowSchema } from '../src/services/intent/workflow-schema.ts';
import { validateWorkflowVariables } from '../src/services/intent/workflow-validator.ts';
import { contactsIntents } from './seed-intents-contacts.ts';
import { eventDeletionIntents } from './seed-intents-event-deletion.ts';
import { eventEditingIntents } from './seed-intents-event-editing.ts';
import { eventQueryingIntents } from './seed-intents-event-querying.ts';
import { freeBusyIntents } from './seed-intents-free-busy.ts';
import { googleCalendarIntents } from './seed-intents-google-calendar.ts';
import { holidaysAndInfoIntents } from './seed-intents-holidays-and-info.ts';
import { remindersIntents } from './seed-intents-reminders.ts';
import { reschedulingIntents } from './seed-intents-rescheduling.ts';
import { settingsIntents } from './seed-intents-settings.ts';
import { sharingSecretaryIntents } from './seed-intents-sharing-secretary.ts';
import { timezoneIntents } from './seed-intents-timezone.ts';

/**
 * Shared shape every scripts/seed-intents-<domain>.ts file's exported array structurally
 * matches. Each domain file declares its own local `SeedIntent` (some narrower — `pattern:
 * string` rather than `string | null` — since every entry they define has a concrete
 * pattern); this is the union that covers all of them, used only for the merged array below.
 */
export interface SeedIntent {
  canonical_name: string;
  pattern: string | null;
  workflow: object;
  phrases: string[];
  trigger_words: string[];
  source_message: string;
  format?: string;
}

export const inlineIntents: SeedIntent[] = [
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

export const domainIntents: SeedIntent[] = [
  ...eventDeletionIntents,
  ...eventQueryingIntents,
  ...reschedulingIntents,
  ...remindersIntents,
  ...holidaysAndInfoIntents,
  ...googleCalendarIntents,
  ...sharingSecretaryIntents,
  ...timezoneIntents,
  ...settingsIntents,
  ...contactsIntents,
  ...freeBusyIntents,
  ...eventEditingIntents,
];

const allIntents: SeedIntent[] = [...inlineIntents, ...domainIntents];

// ── Validate before inserting anything ──────────────────────────────────────

const realToolNames = new Set(
  getToolDefinitions()
    .filter((t) => t.type === 'function')
    .map((t) => t.function.name),
);
const RESERVED_CALLS: Record<string, true> = { respond: true, ask_user: true };

interface RawToolEntry {
  name?: unknown;
}
interface RawStepEntry {
  call?: unknown;
}

function collectToolCalls(workflow: object): string[] {
  const calls: string[] = [];
  if ('tools' in workflow && Array.isArray(workflow.tools)) {
    for (const entry of workflow.tools as RawToolEntry[]) {
      if (typeof entry.name === 'string') calls.push(entry.name);
    }
  }
  if ('steps' in workflow && Array.isArray(workflow.steps)) {
    for (const entry of workflow.steps as RawStepEntry[]) {
      if (typeof entry.call === 'string') calls.push(entry.call);
    }
  }
  return calls;
}

/** Structural checks that must hold for every seeded intent regardless of DSL level gate. */
function structuralErrors(intent: SeedIntent): string[] {
  const errors: string[] = [];
  if (intent.pattern !== null) {
    try {
      new RegExp(intent.pattern, 'i');
    } catch (e) {
      errors.push(`regex does not compile: ${String(e)}`);
    }
  }
  for (const call of collectToolCalls(intent.workflow)) {
    if (!RESERVED_CALLS[call] && !realToolNames.has(call)) {
      errors.push(`unknown tool "${call}"`);
    }
  }
  // validateWorkflowVariables only walks {{}} template strings recursively — it doesn't
  // care whether the workflow itself passes WorkflowSchema, so run it on the raw object.
  const varErrors = validateWorkflowVariables(intent.workflow as Workflow, intent.pattern);
  errors.push(...varErrors);
  return errors;
}

if (import.meta.main) {
  const db = new Database('data/calendar.db');

  function queryCount(sql: string): number {
    const row = db.query(sql).get() as { n: number } | null;
    return row?.n ?? 0;
  }

  // Canonical-name uniqueness within the combined new set (catches a copy-paste collision
  // across domain files). Collision against pre-existing DB rows is NOT checked here: this
  // script is an idempotent upsert (ON CONFLICT DO UPDATE), so re-running it after a prior
  // successful seed will always find its own previously-inserted rows already present — that
  // is the intended steady state, not a bug. The one-time check against the ORIGINAL 22-row
  // baseline (16 approved, 6 rejected) that predates any of these domain files was done
  // separately before this script first ran and confirmed zero collisions.
  const namesSeen = new Map<string, number>();
  for (const intent of allIntents) {
    namesSeen.set(intent.canonical_name, (namesSeen.get(intent.canonical_name) ?? 0) + 1);
  }
  const duplicatesWithinNewSet = [...namesSeen.entries()].filter(([, count]) => count > 1).map(([name]) => name);

  if (duplicatesWithinNewSet.length > 0) {
    console.error('FATAL: duplicate canonical_name within the combined seed set:', duplicatesWithinNewSet);
    process.exit(1);
  }

  // A workflow that fails WorkflowSchema is dead in production: both real callers
  // (src/bot/pipeline/intent-matcher-layer.ts and the SyntheticPipelineRunner wiring in
  // src/index.ts) parse the stored workflow through WorkflowSchema before ever calling
  // IntentExecutor.run(), so a match against one of these would always fall through to the
  // AI agent (logging an error every time) rather than ever taking the fast intent path.
  // ToolInputSchema (z.record(string, string)) can't express manage_settings's legitimately
  // object-shaped `updates` field — tracked as a deferred finding, not fixed here (out of
  // scope for this seeding pass). Skip inserting these rather than seed permanently-dead rows.
  const seedable: SeedIntent[] = [];
  const deadWorkflow: SeedIntent[] = [];
  let hadStructuralError = false;

  for (const intent of allIntents) {
    const errors = structuralErrors(intent);
    if (errors.length > 0) {
      console.error(`FATAL: ${intent.canonical_name} has structural errors:`, errors);
      hadStructuralError = true;
      continue;
    }
    if (WorkflowSchema.safeParse(intent.workflow).success) {
      seedable.push(intent);
    } else {
      deadWorkflow.push(intent);
    }
  }

  if (hadStructuralError) {
    process.exit(1);
  }

  if (deadWorkflow.length > 0) {
    console.log(
      `\nSkipping ${deadWorkflow.length} intent(s) whose workflow fails WorkflowSchema (would never fire as an intent — see comment above):`,
    );
    for (const intent of deadWorkflow) console.log(`  - ${intent.canonical_name}`);
  }

  // ── Seed ──────────────────────────────────────────────────────────────────

  const beforeApproved = queryCount("SELECT COUNT(*) as n FROM intents WHERE status = 'approved'");

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

  for (const intent of seedable) {
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

  const afterApproved = queryCount("SELECT COUNT(*) as n FROM intents WHERE status = 'approved'");

  console.log(`\nDone: ${added} added, ${updated} updated, ${deadWorkflow.length} skipped (dead workflow).`);
  console.log(`Approved intents before: ${beforeApproved}, after: ${afterApproved}`);
  const total = queryCount('SELECT COUNT(*) as n FROM intents');
  console.log(`Total intents in DB (all statuses): ${total}`);
}
