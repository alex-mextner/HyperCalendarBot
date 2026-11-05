// The simulator runs rules through the real matcher layer, executor and tool handlers on a
// migrated in-memory SQLite database inside a child bun process whose preload freezes the clock
// at each case's own time. These tests drive that child exactly as the coverage harness does.
import { beforeAll, describe, expect, test } from 'bun:test';
import { seedIntents } from '../../../../src/services/intent/seed-catalog.ts';
import type { CanonicalSeed } from '../../../../src/services/intent/seed-replacement.ts';
import { runSimulationChild } from '../../../../src/services/intent/simulation/child.ts';
import { type CoverageCase, measureCoverage } from '../../../../src/services/intent/simulation/coverage.ts';
import {
  type SimulationCase,
  type SimulationOutcome,
  YES_ANSWERS,
} from '../../../../src/services/intent/simulation/simulator.ts';

const AT = '2026-09-10T07:00:00.000Z';
const ZONE = 'Europe/Berlin';
const planning = { title: 'Planning sync', start: '2026-09-10T09:00:00.000Z', end: '2026-09-10T10:00:00.000Z' };

/** A write with no confirmation step: the simulator must report it, never count it. */
const unconfirmedWrite: CanonicalSeed = {
  canonical_name: 'synthetic.unconfirmed_write',
  pattern: '',
  workflow: {
    version: 2,
    steps: [{ call: 'create_event', input: { title: 'Synthetic note', start_at: '2026-09-11T10:00:00Z' } }],
  },
  phrases: ['synthetic quick note'],
  trigger_words: [],
  source_message: 'synthetic quick note',
};

/** A rule whose response template names an unknown filter: the executor throws while running it. */
const brokenFilter: CanonicalSeed = {
  canonical_name: 'synthetic.broken_filter',
  pattern: '',
  workflow: { version: 2, steps: [{ respond: '{{env.scope|no_such_filter}}' }] },
  phrases: ['synthetic broken reply'],
  trigger_words: [],
  source_message: 'synthetic broken reply',
};

function coverageCase(overrides: Partial<CoverageCase> & Pick<CoverageCase, 'caseId' | 'request'>): CoverageCase {
  return {
    at: AT,
    timezone: ZONE,
    language: 'ru',
    calendar: [planning],
    label: { class: 'direct', family: 'agenda', expectedTools: ['get_events'], idealResponse: null },
    sensitive: false,
    historicalAnswer: null,
    labelProvenance: 'verified',
    ...overrides,
  };
}

const cases: CoverageCase[] = [
  coverageCase({ caseId: 'read', request: 'что у меня на сегодня' }),
  coverageCase({
    caseId: 'write',
    request: 'добавь разбор почты завтра в 10:30',
    label: { class: 'direct', family: 'create', expectedTools: ['create_event'], idealResponse: null },
  }),
  coverageCase({
    caseId: 'unconfirmed',
    request: 'synthetic quick note',
    language: 'en',
    label: { class: 'direct', family: 'create', expectedTools: ['create_event'], idealResponse: null },
  }),
  coverageCase({
    caseId: 'invite',
    request: 'пригласи @synthetic_guest на событие #1',
    label: { class: 'direct', family: 'invite', expectedTools: ['send_invitation'], idealResponse: null },
  }),
  coverageCase({
    caseId: 'contextual',
    request: 'что у меня на сегодня',
    label: { class: 'contextual', family: 'agenda', expectedTools: ['get_events'], idealResponse: null },
  }),
  coverageCase({
    caseId: 'broken',
    request: 'synthetic broken reply',
    language: 'en',
    label: { class: 'direct', family: 'agenda', expectedTools: [], idealResponse: null },
  }),
  coverageCase({
    caseId: 'sensitive',
    request: 'synthetic quick note',
    sensitive: true,
    label: { class: 'sensitive', family: 'credentials', expectedTools: [], idealResponse: null },
  }),
];

describe('simulator buckets on synthetic cases', () => {
  let report: Awaited<ReturnType<typeof measureCoverage>>;
  const bucketOf = (caseId: string) => report.cases.find((row) => row.caseId === caseId)?.bucket;
  const outcomeOf = (caseId: string) => report.outcomes.find((row) => row.caseId === caseId);
  beforeAll(async () => {
    report = await measureCoverage([...seedIntents, unconfirmedWrite, brokenFilter], cases);
  }, 120_000);

  test('every confirmation option the source seed offers is one the harness answers', () => {
    for (const seed of seedIntents) {
      const i18n = 'i18n' in seed.workflow ? seed.workflow.i18n : undefined;
      if (!i18n || typeof i18n !== 'object') continue;
      for (const strings of Object.values(i18n))
        if (strings && typeof strings === 'object' && 'ok' in strings && typeof strings.ok === 'string')
          expect(YES_ANSWERS.has(strings.ok.toLowerCase())).toBe(true);
    }
  });

  test('a direct read runs its tool and answers from the calendar at the case time and zone', () => {
    expect(bucketOf('read')).toBe('covered');
    const outcome = outcomeOf('read')!;
    expect(outcome.tools.map((tool) => [tool.name, tool.success, tool.write])).toEqual([['get_events', true, false]]);
    expect(outcome.writeOutcome).toBe('none');
    expect(outcome.reply).toContain('Planning sync');
    expect(outcome.reply).toContain('11:00');
  });

  test('a write is covered only through the confirmation the harness answers once', () => {
    expect(bucketOf('write')).toBe('covered');
    const outcome = outcomeOf('write')!;
    expect(outcome.askedConfirmation).toBe(true);
    const write = outcome.tools.find((tool) => tool.name === 'create_event');
    expect(write).toEqual({ name: 'create_event', success: true, afterConfirmation: true, write: true });
    expect(outcome.writeOutcome).toBe('applied');
  });

  test('a write without confirmation is unsafe even though it succeeded', () => {
    expect(bucketOf('unconfirmed')).toBe('unsafe');
    expect(outcomeOf('unconfirmed')!.tools).toEqual([
      { name: 'create_event', success: true, afterConfirmation: false, write: true },
    ]);
  });

  test('an invitation send is blocked and makes the case unsafe', () => {
    expect(bucketOf('invite')).toBe('unsafe');
    const outcome = outcomeOf('invite')!;
    expect(outcome.blockedExternal).toEqual(['send_invitation']);
    expect(outcome.writeOutcome).not.toBe('applied');
  });

  test('a contextual case without references is missing context and is not simulated', () => {
    expect(bucketOf('contextual')).toBe('missing_context');
    expect(outcomeOf('contextual')).toBeUndefined();
  });

  test('a sensitive case is excluded and never simulated', () => {
    expect(bucketOf('sensitive')).toBe('excluded_sensitive');
    expect(outcomeOf('sensitive')).toBeUndefined();
  });

  test('a case whose run throws is recorded as wrong behavior and the other cases still run', () => {
    expect(bucketOf('broken')).toBe('wrong_behavior');
    expect(outcomeOf('broken')!.error).toContain('Unknown filter');
    expect(outcomeOf('read')!.error).toBeNull();
  });

  test('the matcher-only column counts routing independently of behavior', () => {
    expect(report.summary.matcherOnly.matched).toBe(7);
    expect(report.summary.buckets.covered).toBe(2);
  });
});

describe('per-case clock in the child process', () => {
  // The event date is in the past for the real host clock (after 2026-09) and for the later fake
  // host clock, so only the case clock lets the confirmed create pass the past-date gate.
  const clockCases: SimulationCase[] = [
    {
      caseId: 'upcoming',
      request: 'что дальше',
      at: AT,
      timezone: ZONE,
      language: 'ru',
      calendar: [planning, { title: 'Budget review', start: '2026-09-12T08:00:00.000Z' }],
    },
    {
      caseId: 'create',
      request: 'добавь разбор почты завтра в 10:30',
      at: AT,
      timezone: ZONE,
      language: 'ru',
      calendar: [],
    },
  ];
  const run = (hostNow: string) =>
    runSimulationChild({ rules: seedIntents, cases: clockCases }, { hostNow, timeoutMs: 120_000 });
  let early: SimulationOutcome[];
  let late: SimulationOutcome[];
  let parentBefore: number;
  beforeAll(async () => {
    parentBefore = performance.timeOrigin + performance.now();
    early = await run('2025-01-15T12:00:00.000Z');
    late = await run('2027-06-01T12:00:00.000Z');
  }, 240_000);

  test('the same cases give identical outcomes under two different host clocks', () => {
    expect(late).toEqual(early);
  });

  test('the case clock, not the host clock, dates the read and the confirmed write', () => {
    const upcoming = early.find((row) => row.caseId === 'upcoming')!;
    expect(upcoming.reply).toContain('Planning sync');
    const create = early.find((row) => row.caseId === 'create')!;
    expect(create.writeOutcome).toBe('applied');
    expect(create.reply).toContain('разбор почты');
  });

  test('the parent process clock is untouched', () => {
    const wall = performance.timeOrigin + performance.now();
    expect(Math.abs(Date.now() - wall)).toBeLessThan(5_000);
    expect(Date.now()).toBeGreaterThanOrEqual(parentBefore);
  });
});
