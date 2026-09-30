/**
 * The calculate forms production models actually send (anonymized from the
 * 2026-07..09 logs of one user in Europe/Belgrade), plus the DST, zone and
 * weekday boundaries around them. Every call goes through executeTool, the
 * path the model reaches, so schema validation and dispatch are included.
 *
 * A refusal only counts as self-correcting when every concrete example it
 * quotes executes successfully: a hint whose own example fails sends the model
 * into another failed round.
 */
import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import { z } from 'zod';
import { migrations } from '../../../src/database/migrations.ts';
import { UserRepository } from '../../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { executeTool } from '../../../src/services/ai/tool-executor.ts';
import { getToolDefinitions } from '../../../src/services/ai/tools.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';

const USER_ID = 716_000_001;

/** calculate reads nothing from the context beyond chat/user identity. */
function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  const userRepo = new UserRepository(db);
  const user = userRepo.create({
    telegram_id: USER_ID,
    first_name: 'Test',
    timezone: 'Europe/Belgrade',
    language: 'ru',
  });
  return { user, chatId: USER_ID, messageText: '', isGroup: false, userRepo, ...overrides } as unknown as AgentContext;
}

let ctx: AgentContext;

beforeAll(() => {
  // Sunday 2026-09-27 21:00Z: none of these forms may depend on "now".
  setSystemTime(new Date('2026-09-27T21:00:00Z'));
  ctx = makeCtx();
});

afterAll(() => {
  setSystemTime();
});

async function calc(expression: string) {
  return executeTool(ctx, 'calculate', { expression });
}

/** Concrete examples quoted in a text: double-quoted strings containing a digit (templates like "YYYY-MM-DD …" have none). */
function quotedExamples(text: string): string[] {
  return [...text.matchAll(/"([^"\n]+)"/g)].map(([, example]) => example!).filter((example) => /\d/.test(example));
}

async function expectSelfCorrectingRefusal(expression: string, ...mustContain: string[]): Promise<string> {
  const result = await calc(expression);
  expect(result.success).toBe(false);
  const error = result.error ?? '';
  for (const fragment of mustContain) expect(error).toContain(fragment);
  const examples = quotedExamples(error);
  expect(examples.length).toBeGreaterThan(0);
  for (const example of examples) {
    const followed = await calc(example);
    expect({ example, success: followed.success, error: followed.error }).toEqual({
      example,
      success: true,
      error: undefined,
    });
  }
  return error;
}

describe('calculate: forms from production logs', () => {
  test.each([
    ['2026-07-11 11:00 UTC+3 to UTC', '2026-07-11T08:00:00.000Z'],
    ['2026-07-16 00:00 UTC+3 to UTC', '2026-07-15T21:00:00.000Z'],
    ['2026-09-11T03:35:00+02:00 to UTC', '2026-09-11T01:35:00.000Z'],
    ['2026-09-11T04:55:00+02:00 to UTC', '2026-09-11T02:55:00.000Z'],
    ['13:30 UTC+2 to UTC', '11:30'],
    ['2026-09-08 13:30 UTC+2 to UTC', '2026-09-08T11:30:00.000Z'],
    ['2026-09-07 12:00 UTC+2 to UTC', '2026-09-07T10:00:00.000Z'],
    ['2026-09-23 13:30 UTC+2 to UTC', '2026-09-23T11:30:00.000Z'],
    ['2026-09-16 14:00 UTC+2 to UTC', '2026-09-16T12:00:00.000Z'],
    ['23:59 UTC+2 to UTC', '21:59'],
    ['2026-09-23T22:00:00+02:00 to UTC', '2026-09-23T20:00:00.000Z'],
    ['2026-09-24T13:00:00+02:00 to UTC', '2026-09-24T11:00:00.000Z'],
    ['2026-09-24T13:00:00+02:00', '2026-09-24T11:00:00.000Z'],
    ['2026-09-28T12:30:00+02:00', '2026-09-28T10:30:00.000Z'],
    ['2026-09-27T12:30:00+02:00', '2026-09-27T10:30:00.000Z'],
    ['2026-03-30 11:30 UTC to Europe/Belgrade', '2026-03-30T13:30:00+02:00'],
    ['2026-09-27 10:30 UTC to Europe/Belgrade', '2026-09-27T12:30:00+02:00'],
    ['2026-09-23 11:30 UTC to Europe/Belgrade', '2026-09-23T13:30:00+02:00'],
    ['2026-09-28 10:30 UTC to Europe/Belgrade', '2026-09-28T12:30:00+02:00'],
    ['2026-09-28 day_of_week', 'Monday'],
  ])('%s → %s', async (expression, expected) => {
    expect(await calc(expression)).toMatchObject({ success: true, output: expected });
  });

  test.each([
    ['12:00 Europe/Belgrade to UTC', '"2026-09-23 12:00 Europe/Belgrade to UTC"'],
    ['16:00 Europe/Belgrade to UTC', '"2026-09-23 16:00 Europe/Belgrade to UTC"'],
  ])('date-less IANA conversion asks for the calendar date: %s', async (expression, example) => {
    await expectSelfCorrectingRefusal(expression, 'calendar date', 'DST', example);
  });

  test('offset-free local datetime arithmetic stays refused with the accepted forms named', async () => {
    const error = await expectSelfCorrectingRefusal(
      '2026-09-17 18:30 - 2 hours',
      'explicit Z/offset',
      'Local-to-UTC conversion accepts',
    );
    expect(error).toContain('"2026-09-27 10:30 UTC to Europe/Belgrade"');
    expect(error).toContain('"2026-09-28 day_of_week"');
  });

  test('a bare calendar date is not numeric arithmetic', async () => {
    const result = await calc('2026-09-24');
    expect(result.output).not.toBe('1993');
    await expectSelfCorrectingRefusal('2026-09-24', 'YYYY-MM-DD');
  });

  test.each([
    '2026-9-24',
    '2026-09-24 * 2',
    '(2026-09-24)',
    '2026-13-01',
    '2026-00-10',
    '2026-09-32',
  ])('date-shaped operand is refused: %s', async (expression) => {
    await expectSelfCorrectingRefusal(expression, 'YYYY-MM-DD');
  });

  test.each([
    '2026-02-31 - 2026-02-28',
    '2026-02-28 - 2026-02-31',
    '2026-02-31 + 1day',
    '2026-02-29 + 1month',
  ])('an impossible calendar date is refused, not rolled over: %s', async (expression) => {
    expect(await calc(expression)).toMatchObject({ success: false, error: expect.stringContaining('Invalid date') });
  });

  test('an impossible date is refused in a datetime difference too, not rolled over', async () => {
    const result = await calc('2026-02-31T18:00:00Z - 2026-02-21T17:00:00Z');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot parse datetime');
    expect((await calc('2026-03-21T18:00:00Z - 2026-03-21T17:00:00+01:00')).output).toBe('2h');
  });
});

describe('calculate: double conversion of an offset-bearing operand', () => {
  test('explains that the offset is already applied and names both correct forms', async () => {
    const error = await expectSelfCorrectingRefusal('2026-09-19T13:00:00+02:00 - 2hours');
    expect(error).toBe(
      'The +02:00 offset is already applied: 2026-09-19T13:00:00+02:00 is 2026-09-19T11:00:00.000Z. ' +
        'Subtracting 2 hours again would give 2026-09-19T09:00:00.000Z (11:00 local) — a double conversion. ' +
        'To convert local time to UTC send "2026-09-19T13:00:00+02:00" alone. ' +
        'If you really need 2 hours earlier, restate in UTC: "2026-09-19T11:00:00Z - 2hours".',
    );
  });

  test.each([
    ['2026-09-19T13:00:00+02:00 - 2hours', '2026-09-19T11:00:00.000Z'],
    ['2026-09-19T15:30:00+02:00 - 2hours', '2026-09-19T13:30:00.000Z'],
    ['2026-09-19T23:59:00+02:00 - 2hours', '2026-09-19T21:59:00.000Z'],
    ['2026-09-23T15:00:00+02:00 - 2hours', '2026-09-23T13:00:00.000Z'],
    ['2026-09-23T22:00:00+02:00 - 2hours', '2026-09-23T20:00:00.000Z'],
    ['2026-09-24T13:00:00+02:00 - 2hours', '2026-09-24T11:00:00.000Z'],
    ['2026-09-19T13:00:00+02:00 - 2 hours', '2026-09-19T11:00:00.000Z'],
    ['2026-09-19T13:00:00+02:00 - 2h', '2026-09-19T11:00:00.000Z'],
    ['2026-09-19T13:00:00+02:00 - 120min', '2026-09-19T11:00:00.000Z'],
    ['2026-09-19T13:00:00+0200 - 2hours', '2026-09-19T11:00:00.000Z'],
    ['2026-09-19T13:00:00+05:30 - 330min', '2026-09-19T07:30:00.000Z'],
    ['2026-09-19T08:00:00-05:00 + 5hours', '2026-09-19T13:00:00.000Z'],
  ])('refuses %s and names the conversion result %s', async (expression, utc) => {
    await expectSelfCorrectingRefusal(expression, 'offset is already applied', utc, 'double conversion');
  });

  test('the restated-UTC form computes the shift the model asked for', async () => {
    expect(await calc('2026-09-19T11:00:00Z - 2hours')).toMatchObject({
      success: true,
      output: '2026-09-19T09:00:00.000Z',
    });
    expect(await calc('2026-09-19T13:00:00Z + 5hours')).toMatchObject({
      success: true,
      output: '2026-09-19T18:00:00.000Z',
    });
  });

  test.each([
    ['2026-09-19T13:00:00+02:00 + 0hours', '2026-09-19T11:00:00.000Z'],
    ['2026-09-17T10:49:00+02:00 + 2hours', '2026-09-17T10:49:00.000Z'],
    ['2026-09-19T13:00:00+02:00 - 3hours', '2026-09-19T08:00:00.000Z'],
    ['2026-09-19T13:00:00+02:00 - 2days', '2026-09-17T11:00:00.000Z'],
    ['2026-09-19T13:00:00Z - 2hours', '2026-09-19T11:00:00.000Z'],
    ['2026-09-19T13:00:00+00:00 - 2hours', '2026-09-19T11:00:00.000Z'],
    ['2026-09-19T13:00:00Z + 0hours', '2026-09-19T13:00:00.000Z'],
    ['2026-09-19T13:00:00+00:00 - 0min', '2026-09-19T13:00:00.000Z'],
    ['2026-09-19T08:00:00-05:00 - 5hours', '2026-09-19T08:00:00.000Z'],
  ])('still computes %s → %s', async (expression, expected) => {
    expect(await calc(expression)).toMatchObject({ success: true, output: expected });
  });
});

describe('calculate: instant to zone', () => {
  test.each([
    // Belgrade DST starts 2026-03-29 01:00Z and ends 2026-10-25 01:00Z.
    ['2026-03-29 00:59 UTC to Europe/Belgrade', '2026-03-29T01:59:00+01:00'],
    ['2026-03-29 01:00 UTC to Europe/Belgrade', '2026-03-29T03:00:00+02:00'],
    ['2026-01-15 11:30 UTC to Europe/Belgrade', '2026-01-15T12:30:00+01:00'],
    ['2026-10-25 00:30 UTC to Europe/Belgrade', '2026-10-25T02:30:00+02:00'],
    ['2026-10-25 01:30 UTC to Europe/Belgrade', '2026-10-25T02:30:00+01:00'],
    ['2026-09-27T10:30:00Z to Europe/Belgrade', '2026-09-27T12:30:00+02:00'],
    ['2026-09-27T22:30:00Z to Europe/Belgrade', '2026-09-28T00:30:00+02:00'],
    ['2026-09-27T12:30:00+02:00 to Europe/Belgrade', '2026-09-27T12:30:00+02:00'],
    ['2026-09-28 12:30 Europe/Moscow to Europe/Belgrade', '2026-09-28T11:30:00+02:00'],
    ['2026-09-27 12:30 UTC+2 to America/New_York', '2026-09-27T06:30:00-04:00'],
    ['2026-09-27 10:30 UTC to America/New_York', '2026-09-27T06:30:00-04:00'],
    ['2026-01-15 10:30 UTC to America/New_York', '2026-01-15T05:30:00-05:00'],
    ['2026-09-27T10:30:00Z to Asia/Kolkata', '2026-09-27T16:00:00+05:30'],
    ['2026-09-27 10:30:15 UTC to Europe/Belgrade', '2026-09-27T12:30:15+02:00'],
    ['2026-09-27 10:30 utc TO Europe/Belgrade', '2026-09-27T12:30:00+02:00'],
    ['2026-09-28 12:30 europe/moscow to europe/belgrade', '2026-09-28T11:30:00+02:00'],
  ])('%s → %s', async (expression, expected) => {
    expect(await calc(expression)).toMatchObject({ success: true, output: expected });
  });

  test.each([
    ['2026-09-27T12:30:00+02:00 to Etc/UTC', '2026-09-27T10:30:00.000Z'],
    ['2026-09-27T12:30:00+02:00 to utc', '2026-09-27T10:30:00.000Z'],
    ['2026-07-15 12:00 America/New_York to UTC', '2026-07-15T16:00:00.000Z'],
    ['2026-01-15 12:00 America/New_York to UTC', '2026-01-15T17:00:00.000Z'],
    ['2026-09-27 10:30 UTC to UTC', '2026-09-27T10:30:00.000Z'],
    ['2026-09-23 12:30 europe/belgrade to UTC', '2026-09-23T10:30:00.000Z'],
  ])('UTC target keeps the ISO Z contract: %s → %s', async (expression, expected) => {
    expect(await calc(expression)).toMatchObject({ success: true, output: expected });
  });

  test('source wall clock in a DST gap or fold is still refused', async () => {
    const gap = await calc('2026-03-29 02:30 Europe/Belgrade to Europe/Moscow');
    expect(gap.success).toBe(false);
    expect(gap.error).toContain('does not exist');
    const fold = await calc('2026-10-25 02:30 Europe/Belgrade to Europe/Moscow');
    expect(fold.success).toBe(false);
    expect(fold.error).toContain('ambiguous');
  });

  test.each([
    ['2026-09-27 10:30 UTC to Europe/Nowhere', 'Invalid timezone: Europe/Nowhere'],
    ['2026-09-27 10:30 Europe/Nowhere to Europe/Belgrade', 'Invalid timezone: Europe/Nowhere'],
    ['2026-09-27T10:30:00Z to Mars/Olympus', 'Invalid timezone: Mars/Olympus'],
    ['2026-09-27 10:30 Etc/GMT+99 to UTC', 'Invalid timezone: Etc/GMT+99'],
    ['2026-09-27 10:30 A/B to Europe/Belgrade', 'Invalid timezone: A/B'],
  ])('unknown zone %s', async (expression, error) => {
    expect(await calc(expression)).toMatchObject({ success: false, error });
  });

  test.each([
    ['10:30 UTC to Europe/Belgrade', '"2026-09-23 10:30 UTC to Europe/Belgrade"'],
    ['13:30 UTC+2 to Europe/Belgrade', '"2026-09-23 13:30 UTC+2 to Europe/Belgrade"'],
    ['12:00 Europe/Belgrade to Europe/Moscow', '"2026-09-23 12:00 Europe/Belgrade to Europe/Moscow"'],
    ['12:00 America/New_York to UTC', '"2026-09-23 12:00 America/New_York to UTC"'],
  ])('date-less conversion keeps its zones and asks only for the date: %s', async (expression, example) => {
    await expectSelfCorrectingRefusal(expression, 'calendar date', example);
  });

  test('a date-less UTC to UTC conversion is not blamed on DST', async () => {
    const result = await calc('10:30 UTC to UTC');
    expect(result.success).toBe(false);
    expect(result.error).not.toContain('DST');
  });

  test.each([
    '2026-02-31T10:00:00+02:00',
    '2026-09-28T24:00:00+02:00',
    '2026-09-28T12:60:00+02:00',
    '2026-09-28T12:30:00+15:00',
    '2026-02-31T10:00:00Z to Europe/Belgrade',
    '2026-02-31 10:00 UTC to Europe/Belgrade',
  ])('invalid instant is refused: %s', async (expression) => {
    expect((await calc(expression)).success).toBe(false);
  });
});

describe('calculate: weekday of a calendar date', () => {
  test.each([
    ['2026-09-28 day_of_week', 'Monday'],
    ['day_of_week 2026-09-28', 'Monday'],
    ['day_of_week(2026-09-28)', 'Monday'],
    ['2026-09-28 weekday', 'Monday'],
    ['weekday 2026-09-28', 'Monday'],
    ['day of week 2026-09-28', 'Monday'],
    ['Weekday 2026-09-27', 'Sunday'],
    ['DAY_OF_WEEK( 2026-10-01 )', 'Thursday'],
    ['2028-02-29 weekday', 'Tuesday'],
  ])('%s → %s', async (expression, expected) => {
    expect(await calc(expression)).toMatchObject({ success: true, output: expected });
  });

  test.each([
    '2026-02-30 day_of_week',
    'weekday 2027-02-29',
    'day_of_week(2026-13-01)',
  ])('invalid calendar date is refused: %s', async (expression) => {
    expect(await calc(expression)).toMatchObject({ success: false, error: expect.stringContaining('Invalid date') });
  });

  test.each([
    '2026-09-27T22:30:00Z day_of_week',
    'weekday 2026-09-28 12:30',
    'day_of_week(2026-09-28T00:30:00+02:00)',
  ])('a datetime needs its local calendar date first: %s', async (expression) => {
    const error = await expectSelfCorrectingRefusal(expression, 'local calendar date');
    // The user's zone is unknown here; a fixed example zone would pick the wrong local date.
    expect(error).not.toContain('Europe/Belgrade');
  });
});

const calculateToolSchema = z.object({
  function: z.object({
    name: z.literal('calculate'),
    description: z.string(),
    parameters: z.object({ properties: z.object({ expression: z.object({ description: z.string() }) }) }),
  }),
});

describe('calculate: tool schema examples are executable contracts', () => {
  const tool = getToolDefinitions('text').find(
    (candidate) => candidate.type === 'function' && candidate.function.name === 'calculate',
  );
  const schema = calculateToolSchema.parse(tool);

  test.each([
    ['tool description', schema.function.description],
    ['expression parameter', schema.function.parameters.properties.expression.description],
  ])('every concrete example in the %s executes', async (_source, text) => {
    const examples = quotedExamples(text);
    expect(examples.length).toBeGreaterThan(0);
    for (const expression of examples) {
      const result = await calc(expression);
      expect({ expression, success: result.success, error: result.error }).toEqual({
        expression,
        success: true,
        error: undefined,
      });
    }
  });

  test.each([
    { time: '16:00', timezone: 'Europe/Belgrade' },
    { date: '2026-09-13', time: '16:00', timezone: 'Europe/Belgrade' },
  ])('a call without expression is told the field and an example: %j', async (input) => {
    const result = await executeTool(ctx, 'calculate', input);
    expect(result.success).toBe(false);
    expect(result.error).toContain('expression');
    expect(result.error).toContain('"2026-09-23 12:30 Europe/Belgrade to UTC"');
  });
});
