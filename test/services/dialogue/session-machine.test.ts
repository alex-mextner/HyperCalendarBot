// test/services/dialogue/session-machine.test.ts
import { describe, expect, test } from 'bun:test';
import { resolveWizardWallTime } from '../../../src/services/calendar/wall-time-adapters.ts';
import { parseWallTimeInput } from '../../../src/services/calendar/wall-time-parser.ts';
import {
  bareHourButtons,
  checkReadiness,
  nextQuestion,
  revalidateChosenTime,
  TIME_QUESTION_BUTTONS,
} from '../../../src/services/dialogue/session-machine.ts';
import { emptyDraft } from '../../../src/services/dialogue/v3-types.ts';

describe('nextQuestion — adaptive order, never a fixed sequence', () => {
  test('an empty draft asks for title first', () => {
    expect(nextQuestion(emptyDraft('personal'))?.field).toBe('title');
  });

  test('a draft with a title but no schedule asks for schedule next', () => {
    const draft = { ...emptyDraft('personal'), title: 'Meeting' };
    expect(nextQuestion(draft)?.field).toBe('schedule');
  });

  test('a fully specified title+schedule draft asks nothing — people is never forced', () => {
    const draft = {
      ...emptyDraft('personal'),
      title: 'Meeting',
      schedule: { kind: 'timed' as const, startAt: '2026-09-30T12:00:00.000Z' },
    };
    expect(nextQuestion(draft)).toBeNull();
  });
});

describe('the time-only prompt button contract — never Today/Tomorrow', () => {
  test('the schedule question offers exactly all_day/change_date/back/cancel', () => {
    const question = nextQuestion({ ...emptyDraft('personal'), title: 'Meeting' });
    expect(question?.buttons).toEqual(TIME_QUESTION_BUTTONS);
  });

  test('the button set never contains a date-answer label', () => {
    expect(TIME_QUESTION_BUTTONS).not.toContain('today');
    expect(TIME_QUESTION_BUTTONS).not.toContain('tomorrow');
  });

  test('the title question offers no buttons at all', () => {
    expect(nextQuestion(emptyDraft('personal'))?.buttons).toEqual([]);
  });
});

describe('checkReadiness — no redundant confirmation once every required/blocking field resolves', () => {
  test('an empty draft is never ready', () => {
    const check = checkReadiness(emptyDraft('personal'), {
      fuzzyPeople: [],
      negated: false,
      unresolvedPeopleNames: [],
    });
    expect(check.ready).toBe(false);
    expect(check.blockedBy).toEqual([{ kind: 'missing_title' }, { kind: 'missing_schedule' }]);
  });

  test('title+schedule with no pending fuzzy people is ready — executes once, no extra question', () => {
    const draft = {
      ...emptyDraft('personal'),
      title: 'Meeting',
      schedule: { kind: 'timed' as const, startAt: '2026-09-30T12:00:00.000Z' },
    };
    expect(checkReadiness(draft, { fuzzyPeople: [], negated: false, unresolvedPeopleNames: [] })).toEqual({
      ready: true,
      blockedBy: [],
    });
  });

  test('a single unconfirmed fuzzy person still blocks readiness even though it is optional', () => {
    const draft = {
      ...emptyDraft('personal'),
      title: 'Meeting',
      schedule: { kind: 'timed' as const, startAt: '2026-09-30T12:00:00.000Z' },
    };
    const check = checkReadiness(draft, {
      fuzzyPeople: [{ rawName: 'Kristin', candidates: [] }],
      negated: false,
      unresolvedPeopleNames: [],
    });
    expect(check.ready).toBe(false);
    expect(check.blockedBy).toEqual([{ kind: 'unconfirmed_person', rawName: 'Kristin' }]);
  });

  test('a negated turn blocks even a fully specified draft — never silently executes a "don\'t create" request', () => {
    const draft = {
      ...emptyDraft('personal'),
      title: 'Meeting',
      schedule: { kind: 'timed' as const, startAt: '2026-09-30T12:00:00.000Z' },
    };
    const check = checkReadiness(draft, { fuzzyPeople: [], negated: true, unresolvedPeopleNames: [] });
    expect(check.ready).toBe(false);
    expect(check.blockedBy).toContainEqual({ kind: 'negated' });
  });

  test('an explicit name that matched no contact at all blocks readiness — never silently created without them', () => {
    const draft = {
      ...emptyDraft('personal'),
      title: 'Meeting',
      schedule: { kind: 'timed' as const, startAt: '2026-09-30T12:00:00.000Z' },
    };
    const check = checkReadiness(draft, { fuzzyPeople: [], negated: false, unresolvedPeopleNames: ['Zorblax'] });
    expect(check.ready).toBe(false);
    expect(check.blockedBy).toContainEqual({ kind: 'unresolved_person', rawName: 'Zorblax' });
  });
});

describe('bareHourButtons — the "2" -> 02:00(night)/14:00(day) contract, no LLM involved', () => {
  test('bare "2" surfaces exactly the two candidates the shared parser itself produced', () => {
    const outcome = parseWallTimeInput('2', {
      selectedDate: '2026-09-29',
      timezone: 'Europe/Belgrade',
      pendingField: 'time',
    });
    expect(outcome.decision).toBe('ambiguous');
    if (outcome.decision !== 'ambiguous') throw new Error('unreachable');
    const buttons = bareHourButtons(outcome.candidates);
    expect(buttons).toEqual([
      { value: '02:00', label: '02:00 (night)' },
      { value: '14:00', label: '14:00 (day)' },
    ]);
  });
});

describe('revalidateChosenTime — a tapped candidate is re-parsed, never trusted as pre-resolved', () => {
  test('choosing "02:00" re-resolves through the shared parser and returns a complete schedule', () => {
    const ctx = { selectedDate: '2026-09-29', timezone: 'Europe/Belgrade' };
    const resolution = revalidateChosenTime('02:00', ctx, resolveWizardWallTime);
    expect(resolution).toEqual({
      kind: 'complete',
      schedule: { kind: 'timed', startAt: '2026-09-29T00:00:00.000Z' },
    });
  });

  test('a candidate landing in a DST gap is caught on revalidation, never silently accepted', () => {
    const ctx = { selectedDate: '2026-03-29', timezone: 'Europe/Belgrade' };
    const resolution = revalidateChosenTime('02:00', ctx, resolveWizardWallTime);
    expect(resolution.kind).toBe('invalid');
  });
});
