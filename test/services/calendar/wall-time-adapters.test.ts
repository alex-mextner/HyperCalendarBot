// test/services/calendar/wall-time-adapters.test.ts
//
// GH-650 acceptance criterion: "Bare hour 1 to 12 gives the same ambiguous or accepted
// result on the add command and on the intent path for the same input and pending
// field." resolveWizardWallTime and resolveIntentWallTime are both thin transforms of one
// shared resolve() call inside wall-time-adapters.ts, so these tests confirm the two
// surface envelopes stay in lockstep by construction, not just that the underlying engine
// agrees with itself.

import { describe, expect, test } from 'bun:test';
import {
  resolveIntentWallTime,
  resolveWizardWallTime,
  type WallTimeResolutionContext,
} from '../../../src/services/calendar/wall-time-adapters.ts';

const ctx: WallTimeResolutionContext = { selectedDate: '2026-09-29', timezone: 'Europe/Belgrade' };

const SAME_SHAPE_INPUTS = [
  '1',
  '01',
  'в 1',
  '2',
  '12',
  '13',
  '18',
  '0',
  '00:00',
  '0:15',
  '14:00',
  '2pm',
  '2 дня',
  'полдень',
  'полночь',
  '24:00',
  '25:00',
  '14:75',
  '13pm',
  'вечером',
  'весь день',
  'на весь день',
  'all day',
  'время пока не знаю',
  'не 2',
  'not 2',
];

describe('the wizard and intent adapters agree for every pending-time input (GH-650 acceptance)', () => {
  test.each(SAME_SHAPE_INPUTS)('%s', (raw) => {
    const wizard = resolveWizardWallTime(raw, ctx);
    const intent = resolveIntentWallTime(raw, ctx);
    expect(intent).toEqual(
      wizard.kind === 'complete' ? { ok: true, schedule: wizard.schedule } : { ok: false, resolution: wizard },
    );
  });
});

describe('the shape unification GH-650 actually fixes: bare 1-12', () => {
  // Documents the exact bug from PR562: before this slice, the wizard asked to
  // disambiguate while the intent path threw WorkflowInputError outright for the
  // identical input. Both adapters now report the same ambiguity, with the reason kept.
  test.each(['3', '10', '12'])('%s is ambiguous on both surfaces, neither guesses nor rejects it', (raw) => {
    const wizard = resolveWizardWallTime(raw, ctx);
    const intent = resolveIntentWallTime(raw, ctx);
    if (wizard.kind !== 'ambiguous_number') throw new Error(`expected ambiguous_number for ${raw}`);
    expect(intent).toEqual({ ok: false, resolution: wizard });
  });
});

describe('resolveWizardWallTime shape', () => {
  test('accepted time becomes { kind: "complete", schedule }', () => {
    const result = resolveWizardWallTime('14:00', ctx);
    expect(result).toEqual({ kind: 'complete', schedule: { kind: 'timed', startAt: '2026-09-29T12:00:00.000Z' } });
  });

  test('all-day becomes a complete Schedule of kind all_day, not a fabricated 00:00 Timed event', () => {
    const result = resolveWizardWallTime('весь день', ctx);
    expect(result).toEqual({
      kind: 'complete',
      schedule: { kind: 'all_day', startDate: '2026-09-29', endDateExclusive: '2026-09-30' },
    });
  });

  test('"time unknown" becomes clarify with its reason, distinct from invalid and from all-day', () => {
    expect(resolveWizardWallTime('время пока не знаю', ctx)).toEqual({
      kind: 'clarify',
      reason: 'unknown_time_is_not_all_day',
    });
  });

  test('invalid input carries its specific reason, not a generic invalid tag', () => {
    expect(resolveWizardWallTime('25:00', ctx)).toEqual({ kind: 'invalid', reason: 'explicit_date_or_time_repair' });
  });
});

describe('resolveIntentWallTime shape', () => {
  test('accepted time becomes { ok: true, schedule }', () => {
    const result = resolveIntentWallTime('14:00', ctx);
    expect(result).toEqual({ ok: true, schedule: { kind: 'timed', startAt: '2026-09-29T12:00:00.000Z' } });
  });

  test('a DST fold becomes { ok: false, resolution: { kind: "ambiguous_instant", candidates } } instead of throwing', () => {
    const result = resolveIntentWallTime('02:00', { selectedDate: '2026-10-25', timezone: 'Europe/Belgrade' });
    expect(result).toEqual({
      ok: false,
      resolution: {
        kind: 'ambiguous_instant',
        candidates: ['2026-10-25T02:00:00+02:00', '2026-10-25T02:00:00+01:00'],
      },
    });
  });

  test('a DST gap surfaces its specific reason instead of throwing', () => {
    const result = resolveIntentWallTime('02:00', { selectedDate: '2026-03-29', timezone: 'Europe/Belgrade' });
    expect(result).toEqual({ ok: false, resolution: { kind: 'invalid', reason: 'nonexistent_local_time' } });
  });

  test('invalid input becomes { ok: false, resolution: { kind: "invalid", reason } } instead of throwing', () => {
    expect(resolveIntentWallTime('25:00', ctx)).toEqual({
      ok: false,
      resolution: { kind: 'invalid', reason: 'explicit_date_or_time_repair' },
    });
  });
});
