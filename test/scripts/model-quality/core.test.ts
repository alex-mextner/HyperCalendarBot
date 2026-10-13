import { expect, test } from 'bun:test';
import { equivalent, evaluate, type Fixture, summarize, type Trace } from '../../../scripts/model-quality/core.ts';

const fixture: Fixture = {
  id: 'create',
  family: 'create',
  provenance: 'synthetic',
  user: 'Создай тест.',
  context: '',
  required: [{ name: 'create_event', args: { start_at: '2026-09-28T11:00:00Z' } }],
  allowedWrites: ['create_event'],
  maxWrites: 1,
};
const trace: Trace = {
  calls: [{ name: 'create_event', args: { start_at: '2026-09-28T11:00:00Z' }, success: true }],
  text: 'Создано.',
  durationMs: 200,
  error: null,
  inputTokens: null,
  outputTokens: null,
  incomplete: false,
};
test('correct complete trace passes', () => expect(evaluate(fixture, trace).pass).toBe(true));
test('wrong date is critical, not merely another valid tool argument', () =>
  expect(
    evaluate(fixture, {
      ...trace,
      calls: [{ name: 'create_event', args: { start_at: '2026-09-29T11:00:00Z' }, success: true }],
    }).critical,
  ).toBe(true));
test('duplicate mutation fails', () =>
  expect(evaluate(fixture, { ...trace, calls: [...trace.calls, ...trace.calls] }).critical).toBe(true));
test('read request must not create events', () =>
  expect(evaluate({ ...fixture, required: [], allowedWrites: [], maxWrites: 0 }, trace).critical).toBe(true));
test('equivalent time offsets compare by instant', () =>
  expect(equivalent('2026-09-28T13:00:00+02:00', '2026-09-28T11:00:00Z')).toBe(true));
test('missing property never equals omitted expectation value', () => expect(equivalent(undefined, 42)).toBe(false));
test('error cannot count as correct even after right first action', () =>
  expect(evaluate(fixture, { ...trace, error: 'TimeoutError' }).pass).toBe(false));
test('incomplete run cannot count as correct', () =>
  expect(evaluate(fixture, { ...trace, incomplete: true }).pass).toBe(false));
test('all failures stay in denominator and unknown usage stays unknown', () => {
  const x = summarize([
    { ...trace, pass: true, critical: false },
    { ...trace, error: 'Timeout', pass: false, critical: false },
  ]);
  expect(x.total).toBe(2);
  expect(x.passed).toBe(1);
  expect(x.failed).toBe(1);
  expect(x.inputTokens).toBe(null);
});
test('wrong recipient fails critically', () => {
  const f = {
    ...fixture,
    required: [{ name: 'send_invitation', args: { invitee_id: 201 } }],
    allowedWrites: ['send_invitation'],
  };
  expect(
    evaluate(f, { ...trace, calls: [{ name: 'send_invitation', args: { invitee_id: 202 }, success: true }] }).critical,
  ).toBe(true);
});
test('success claim without successful mutation fails when explicitly checked', () => {
  const f = { ...fixture, required: [], allowedWrites: [], maxWrites: 0, forbiddenText: ['приглашение отправлено'] };
  expect(evaluate(f, { ...trace, calls: [], text: 'Приглашение отправлено.' }).critical).toBe(true);
});
test('mixed SKIP token is not a valid final response', () =>
  expect(evaluate(fixture, { ...trace, text: 'Создано. [SKIP]' }).pass).toBe(false));
test('visible provider-internal channel leakage fails output protocol', () =>
  expect(
    evaluate(
      { ...fixture, required: [], allowedWrites: [], maxWrites: 0 },
      { ...trace, calls: [], text: 'analysisI will call a tool.assistantcommentary to=functions.calculate' },
    ).pass,
  ).toBe(false));
test('extra change in a rename is a critical wrong write', () => {
  const f = {
    ...fixture,
    events: [{ id: 101, title: 'Old', start_at: '2026-09-28T11:00:00Z' }],
    required: [{ name: 'update_event', args: { event_id: 101, title: 'New' } }],
    allowedWrites: ['update_event'],
  };
  expect(
    evaluate(f, {
      ...trace,
      calls: [
        {
          name: 'update_event',
          args: { event_id: 101, title: 'New', start_at: '2026-09-28T12:00:00Z' },
          success: true,
        },
      ],
    }).critical,
  ).toBe(true);
});
test('default owner explicitly123 is not another calendar', () =>
  expect(
    evaluate(fixture, { ...trace, calls: [{ ...trace.calls[0]!, args: { ...trace.calls[0]!.args, owner_id: 123 } }] })
      .critical,
  ).toBe(false));
test('Russian interface may not silently switch to English', () =>
  expect(evaluate(fixture, { ...trace, text: 'The event has been created.' }).pass).toBe(false));
test('group search cannot expose personal scope', () =>
  expect(
    evaluate(
      { ...fixture, group: true, required: [], allowedWrites: [], maxWrites: 0 },
      { ...trace, calls: [{ name: 'search_events', args: { scope: 'personal' }, success: true }] },
    ).critical,
  ).toBe(true));
test('partial usage after an API failure remains explicitly unknown', () => {
  const row = { ...trace, pass: false, critical: false, inputTokens: 200, outputTokens: 50, usageMissing: true };
  expect(summarize([row]).unknownUsageRows).toBe(1);
});
test('explicitly required owner cannot disappear and still pass', () => {
  const fx = {
    ...fixture,
    required: [{ name: 'create_event', args: { ...fixture.required[0]!.args, owner_id: 123 } }],
  };
  expect(evaluate(fx, trace).critical).toBe(true);
  expect(evaluate(fx, trace).pass).toBe(false);
});
test('a Russian answer with a URL is not an English-only response', () => {
  const fx = { ...fixture, required: [], allowedWrites: [], maxWrites: 0 };
  const v = evaluate(fx, { ...trace, calls: [], text: 'Ссылка: https://example.invalid' });
  expect(v.reasons).not.toContain('wrong_response_language');
});
test('required failed tool cannot satisfy an expected successful action', () =>
  expect(evaluate(fixture, { ...trace, calls: [{ ...trace.calls[0]!, success: false }] }).pass).toBe(false));
test('schema-rejected invitation is a task failure, not a valid wrong-recipient mutation', () => {
  const f = {
    ...fixture,
    required: [{ name: 'send_invitation', args: { event_id: 101, invitee_id: 201 } }],
    allowedWrites: ['send_invitation'],
  };
  const result = evaluate(f, {
    ...trace,
    calls: [
      {
        name: 'send_invitation',
        args: { event_id: 101, invitee_username: 'Олег' },
        success: false,
        error: 'SCHEMA_INVALID',
      },
    ],
  });
  expect(result.pass).toBe(false);
  expect(result.critical).toBe(false);
});
