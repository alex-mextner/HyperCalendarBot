/**
 * The write receipt reads create_event's idempotent "already exists" result as the same event, not as a
 * second creation and never as a failure (#929, #520). Built on the real create_event handler and the
 * real WriteOutcomes ledger with synthetic data: the shape of the repeat is the handler's, not a fixture.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { _resetToolThrottleForTest, executeTool, WRITE_TOOLS } from '../../../src/services/ai/tool-executor.ts';
import type { AgentContext } from '../../../src/services/ai/types.ts';
import { WriteOutcomes } from '../../../src/services/ai/write-outcomes.ts';
import { receiptView } from '../../../src/services/ai/write-receipt.ts';
import { createEventToolFixture } from './tool-handlers/events-fixtures.ts';

const STANDUP = { title: 'Synthetic Standup', start_at: '2030-03-05T10:00:00Z', end_at: '2030-03-05T10:30:00Z' };
const LUNCH = { title: 'Synthetic Lunch', start_at: '2030-03-06T12:00:00Z', end_at: '2030-03-06T13:00:00Z' };
const rejected = { success: false, disposition: 'failed', mutationState: 'not_applied', error: 'bad end_at' } as const;
const unknown = { success: false, disposition: 'failed', mutationState: 'uncertain', error: 'timeout' } as const;

const inLanguage = (ctx: AgentContext, language: 'en' | 'ru'): AgentContext => ({
  ...ctx,
  user: { ...ctx.user, language },
});

describe.each([
  [
    'en',
    { created: 'Created', notCreated: 'Not created', existing: 'Already in the calendar', duplicate: 'duplicate' },
  ],
  ['ru', { created: 'Создано', notCreated: 'Не создано', existing: 'Уже есть в календаре', duplicate: 'дубль' }],
] as const)('create_event repeat in the receipt (%s)', (language, words) => {
  let ctx: AgentContext;
  let ledger: WriteOutcomes;
  let otherRun: AgentContext;

  beforeEach(() => {
    _resetToolThrottleForTest();
    ctx = inLanguage(createEventToolFixture().ctx, language);
    otherRun = { ...ctx, createdEventIds: undefined };
    ledger = new WriteOutcomes(WRITE_TOOLS);
  });

  /** One create_event call of the run under test: executed for real, then recorded as the agent loop does. */
  async function create(input: object): Promise<void> {
    _resetToolThrottleForTest();
    ledger.record('create_event', input, await executeTool(ctx, 'create_event', input), false, 'UTC');
  }

  /** Another run of the chat saves the event: it is in the calendar, but this run's ledger never saw it. */
  async function saveInAnotherRun(input: object): Promise<void> {
    _resetToolThrottleForTest();
    await executeTool(otherRun, 'create_event', input);
  }

  const lines = (): string[] => ledger.summary(receiptView(ctx))?.split('\n') ?? [];

  test('a creation and its repeat read as one created event, with nothing to guard', async () => {
    await create(STANDUP);
    await create(STANDUP);

    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toStartWith(`${words.created}: `);
    expect(lines()[0]).toContain('Synthetic Standup');
    expect(ledger.finalNotice(receiptView(ctx))).toBeNull();
  });

  test('a repeat spelled differently is the same event and still one line', async () => {
    await create(STANDUP);
    await create({ ...STANDUP, title: '  synthetic   STANDUP ' });
    await create(STANDUP);

    expect(lines()).toHaveLength(1);
    expect(ledger.finalNotice(receiptView(ctx))).toBeNull();
  });

  test('a refused first attempt followed by the repeat result is no failure', async () => {
    await saveInAnotherRun(STANDUP); // another run saved it; this run only sees the repeat
    ledger.record('create_event', STANDUP, rejected, false, 'UTC');
    await create(STANDUP);

    expect(ledger.finalNotice(receiptView(ctx))).toBeNull();
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toStartWith(`${words.existing}: `);
    expect(lines().join('\n')).not.toContain(words.notCreated);
  });

  test('an earlier try of unknown result keeps its duplicate warning next to the repeat result', async () => {
    await saveInAnotherRun(STANDUP);
    // A deliberate second copy this run never saw the result of: finding the first row cannot settle it.
    await saveInAnotherRun({ ...STANDUP, allow_duplicate: true });
    ledger.record('create_event', { ...STANDUP, allow_duplicate: true }, unknown, false, 'UTC');
    await create(STANDUP);

    const notice = ledger.finalNotice(receiptView(ctx)) ?? '';
    expect(notice).toStartWith(`${words.existing}: `);
    expect(notice).toContain(words.duplicate);
  });

  test('a refused try with other details is settled by the repeat of the original request', async () => {
    await create(STANDUP);
    await create({ ...STANDUP, end_at: '2030-03-05T11:00:00Z' }); // same title and day, other end: refused
    expect(ledger.finalNotice(receiptView(ctx))).toContain(words.notCreated);
    await create(STANDUP);

    expect(ledger.finalNotice(receiptView(ctx))).toBeNull();
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toStartWith(`${words.created}: `);
  });

  test('a throttled repeat of a request an earlier repeat answered is not a skipped create of its own', async () => {
    const saved = { ...STANDUP, description: 'saved description' };
    await saveInAnotherRun(saved);
    await create(STANDUP); // answered "already exists" with the saved event, which has a description
    await create({ ...saved, force: true }); // the same event again, asking for the saved description
    const again = { ...saved, force: 'true' }; // the same call spelled differently: throttled after normalization
    const throttled = await executeTool(ctx, 'create_event', again);
    expect(throttled.disposition).toBe('skipped');
    ledger.record('create_event', again, throttled, false, 'UTC');

    expect(ledger.finalNotice(receiptView(ctx))).toBeNull();
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toStartWith(`${words.existing}: `);
  });

  test('a repeat of an event this run did not create is told as already there, once', async () => {
    await saveInAnotherRun(STANDUP);
    await create(STANDUP);
    await create(STANDUP);

    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toStartWith(`${words.existing}: `);
    expect(lines()[0]).toContain('Synthetic Standup');
    expect(lines()[0]).not.toStartWith(words.created);
  });

  test('a different event of the same run stays a separate line', async () => {
    await create(STANDUP);
    await create(LUNCH);
    await create(STANDUP);
    await create(LUNCH);

    expect(lines()).toHaveLength(2);
    expect(lines().every((line) => line.startsWith(`${words.created}: `))).toBe(true);
    expect(lines()[0]).toContain('Synthetic Standup');
    expect(lines()[1]).toContain('Synthetic Lunch');
    expect(ledger.finalNotice(receiptView(ctx))).toBeNull();
  });

  test('a deliberate second copy (allow_duplicate) is a second created event', async () => {
    await create(STANDUP);
    await create({ ...STANDUP, allow_duplicate: true });

    expect(lines()).toHaveLength(2);
    expect(lines().every((line) => line.startsWith(`${words.created}: `))).toBe(true);
  });

  test('a group chat still names no event in the repeat line', async () => {
    await saveInAnotherRun(STANDUP);
    await create(STANDUP);
    const hidden = { ...receiptView(ctx), hideTargets: true };

    const receipt = ledger.summary(hidden) ?? '';
    expect(receipt).toStartWith(`${words.existing}: `);
    expect(receipt).not.toContain('Synthetic');
    expect(receipt.split('\n')).toHaveLength(1);
  });
});
