import { describe, expect, test } from 'bun:test';
import { domainIntents, inlineIntents, type SeedIntent } from '../../scripts/seed-intents.ts';
import { contactsIntents } from '../../scripts/seed-intents-contacts.ts';
import { eventDeletionIntents } from '../../scripts/seed-intents-event-deletion.ts';
import { eventEditingIntents } from '../../scripts/seed-intents-event-editing.ts';
import { eventQueryingIntents } from '../../scripts/seed-intents-event-querying.ts';
import { freeBusyIntents } from '../../scripts/seed-intents-free-busy.ts';
import { googleCalendarIntents } from '../../scripts/seed-intents-google-calendar.ts';
import { holidaysAndInfoIntents } from '../../scripts/seed-intents-holidays-and-info.ts';
import { remindersIntents } from '../../scripts/seed-intents-reminders.ts';
import { reschedulingIntents } from '../../scripts/seed-intents-rescheduling.ts';
import { settingsIntents } from '../../scripts/seed-intents-settings.ts';
import { sharingSecretaryIntents } from '../../scripts/seed-intents-sharing-secretary.ts';
import { timezoneIntents } from '../../scripts/seed-intents-timezone.ts';
import type { Intent } from '../../src/database/types.ts';
import { getToolDefinitions } from '../../src/services/ai/tools.ts';
import type { ToolResult } from '../../src/services/ai/types.ts';
import { IntentExecutor } from '../../src/services/intent/intent-executor.ts';
import { IntentMatcher } from '../../src/services/intent/intent-matcher.ts';
import type { Workflow } from '../../src/services/intent/workflow-schema.ts';
import { WorkflowSchema } from '../../src/services/intent/workflow-schema.ts';
import { validateWorkflowVariables } from '../../src/services/intent/workflow-validator.ts';

const domains: Record<string, SeedIntent[]> = {
  eventDeletion: eventDeletionIntents,
  eventQuerying: eventQueryingIntents,
  rescheduling: reschedulingIntents,
  reminders: remindersIntents,
  holidaysAndInfo: holidaysAndInfoIntents,
  googleCalendar: googleCalendarIntents,
  sharingSecretary: sharingSecretaryIntents,
  timezone: timezoneIntents,
  settings: settingsIntents,
  contacts: contactsIntents,
  freeBusy: freeBusyIntents,
  eventEditing: eventEditingIntents,
};

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

// The 6 runner-inline intents plus every domain file, merged exactly like scripts/seed-intents.ts.
const allIntents: SeedIntent[] = [...inlineIntents, ...domainIntents];

// Intents whose workflow fails WorkflowSchema are never seeded by scripts/seed-intents.ts (they
// would be dead in production — see the comment above the equivalent gate in seed-intents.ts).
// Routing/execution tests below only cover the intents that actually get inserted.
const seedableIntents = allIntents.filter((intent) => WorkflowSchema.safeParse(intent.workflow).success);

describe('seed-intents: structural validation', () => {
  test('every domain file exports the expected intent count', () => {
    expect(Object.values(domains).reduce((sum, arr) => sum + arr.length, 0)).toBe(98);
    expect(inlineIntents.length).toBe(6);
  });

  test('zero duplicate canonical_name across the combined inline + 12 domain set', () => {
    const names = allIntents.map((i) => i.canonical_name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });

  test('zero duplicate canonical_name against the pre-existing DB rows', () => {
    // The exact canonical_name list of every row that existed before any of these domain
    // files were seeded (16 approved + 6 rejected — rejected rows still occupy the UNIQUE
    // canonical_name namespace). The 6 runner-inline intents are themselves 6 of these rows
    // (already-approved, re-upserted in place) and are excluded from the collision check.
    const preExisting = new Set([
      'invite_user_to_event',
      'create_event_today_at_time',
      'create_meeting_date_only',
      'make_calendar_call',
      'create_meeting_on_date_unambiguous',
      'show_today',
      'show_tomorrow',
      'show_week',
      'free_slots_today',
      'search_events_by_query',
      'create_event_named_tomorrow',
      'schedule_reminder_tomorrow',
      'set_timezone_belgrade',
      'change_language_to_russian',
      'change_language_to_english',
      'toggle_language',
      'show_conversation_history',
      'create_meeting_at_time',
      'update_event_time',
      'show_day_plan',
      'show_next_tuesday',
      'show_next_week',
    ]);
    const collisions = domainIntents.map((i) => i.canonical_name).filter((name) => preExisting.has(name));
    expect(collisions).toEqual([]);
  });

  for (const [domain, intents] of Object.entries(domains)) {
    describe(domain, () => {
      for (const intent of intents) {
        test(`${intent.canonical_name}: regex compiles, tool names are real, no dangling variables`, () => {
          if (intent.pattern !== null) {
            expect(() => new RegExp(intent.pattern as string, 'i')).not.toThrow();
          }
          for (const call of collectToolCalls(intent.workflow)) {
            if (!RESERVED_CALLS[call]) {
              expect(realToolNames.has(call)).toBe(true);
            }
          }
          const varErrors = validateWorkflowVariables(intent.workflow as Workflow, intent.pattern);
          expect(varErrors).toEqual([]);
        });
      }
    });
  }
});

describe('seed-intents: WorkflowSchema gate (production execution gate)', () => {
  test('the 11 settings.ts "update" intents fail WorkflowSchema — manage_settings.updates is a nested object, and ToolInputSchema only allows string values', () => {
    const failing = settingsIntents.filter((i) => !WorkflowSchema.safeParse(i.workflow).success);
    expect(failing.map((i) => i.canonical_name).sort()).toEqual(
      [
        'enable_morning_agenda',
        'disable_morning_agenda',
        'enable_evening_review',
        'disable_evening_review',
        'set_quiet_hours_night',
        'disable_quiet_hours',
        'set_default_duration_15',
        'set_default_duration_30',
        'enable_voice_responses',
        'disable_voice_responses',
        'reset_settings_to_default',
      ].sort(),
    );
  });

  test('view_settings_summary (a "get" action, no nested updates) passes WorkflowSchema', () => {
    const intent = settingsIntents.find((i) => i.canonical_name === 'view_settings_summary');
    expect(intent).toBeDefined();
    expect(WorkflowSchema.safeParse(intent?.workflow).success).toBe(true);
  });

  test('every non-settings domain intent passes WorkflowSchema', () => {
    const settingsNames = new Set(settingsIntents.map((i) => i.canonical_name));
    const nonSettings = domainIntents.filter((i) => !settingsNames.has(i.canonical_name));
    const failing = nonSettings.filter((i) => !WorkflowSchema.safeParse(i.workflow).success);
    expect(failing).toEqual([]);
  });
});

function buildFakeIntents(intents: SeedIntent[]): Intent[] {
  return intents.map((it, i) => ({
    id: i + 1,
    canonical_name: it.canonical_name,
    phrases: JSON.stringify(it.phrases),
    trigger_words: JSON.stringify(it.trigger_words),
    pattern: it.pattern,
    workflow: JSON.stringify(it.workflow),
    format: 'text',
    status: 'approved',
    source_message: it.source_message,
    created_at: new Date().toISOString(),
  }));
}

describe('seed-intents: IntentMatcher routing', () => {
  const fakeIntents = buildFakeIntents(seedableIntents);
  const matcher = new IntentMatcher();
  matcher.load(fakeIntents);

  function routedName(text: string): string | null {
    const m = matcher.match(text);
    if (!m) return null;
    return fakeIntents.find((i) => i.id === m.intentId)?.canonical_name ?? null;
  }

  test("every seedable intent's own source_message routes back to itself", () => {
    const failures: string[] = [];
    for (const intent of seedableIntents) {
      const got = routedName(intent.source_message);
      if (got !== intent.canonical_name) {
        failures.push(`"${intent.source_message}" (${intent.canonical_name}) -> ${got ?? 'NOTHING'}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("every seedable intent's own phrases route back to itself (no cross-intent ambiguity)", () => {
    const failures: string[] = [];
    for (const intent of seedableIntents) {
      for (const phrase of intent.phrases) {
        const got = routedName(phrase);
        if (got !== intent.canonical_name) {
          failures.push(`"${phrase}" (${intent.canonical_name}) -> ${got ?? 'NOTHING'}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  // At least one real sample phrase per domain, routed end-to-end through the matcher.
  for (const [domain, intents] of Object.entries(domains)) {
    const seedableInDomain = intents.filter((i) => WorkflowSchema.safeParse(i.workflow).success);
    if (seedableInDomain.length === 0) continue;
    test(`${domain}: a representative source_message routes to the right intent`, () => {
      const sample = seedableInDomain[0]!;
      expect(routedName(sample.source_message)).toBe(sample.canonical_name);
    });
  }

  test('an unrelated message matches nothing', () => {
    expect(routedName('совершенно случайный текст без триггеров')).toBeNull();
  });
});

describe('seed-intents: IntentExecutor stubbed execution (one representative case per domain)', () => {
  const executor = new IntentExecutor();
  const userCtx = {
    timezone: 'Europe/Belgrade',
    language: 'ru' as const,
    username: 'ultra',
    firstName: 'Ultra',
    userId: 1,
    groupIsGroup: false,
  };

  function stubExecuteTool(response: ToolResult) {
    return async (): Promise<ToolResult> => response;
  }

  const genericStub: ToolResult = { success: true, output: 'stubbed tool output', data: [] };

  for (const [domain, intents] of Object.entries(domains)) {
    const sample = intents.find((i) => WorkflowSchema.safeParse(i.workflow).success);
    if (!sample) continue;
    test(`${domain}: ${sample.canonical_name} runs to completion against a stubbed tool executor`, async () => {
      const execTool = stubExecuteTool(genericStub);
      const result = await executor.run(sample.workflow as Workflow, {}, userCtx, execTool);
      expect(result.success || result.suspended).toBe(true);
    });
  }
});
