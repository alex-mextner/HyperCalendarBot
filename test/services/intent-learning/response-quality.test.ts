import { afterEach, beforeEach, expect, test } from 'bun:test';
import { responseQualityFindings } from '../../../src/services/intent-learning/response-quality.ts';
import { type Fixture, freshSession, generation, interaction, makeFixture, review } from './helpers.ts';

let fx: Fixture;
beforeEach(() => {
  fx = makeFixture();
});
afterEach(() => fx.cleanup());
const good = {
  friendliness: 2,
  informativeness: 2,
  relevance: 2,
  grounding: 2,
  notes: ['Natural, scoped and supported by the recorded tool result.'],
};

test('emoji cannot repair generic or uninformative wording', () => {
  expect(
    responseQualityFindings([{ sampleId: 1, intentResponse: 'Событий в этом диапазоне не найдено 🙂', quality: good }]),
  ).not.toEqual([]);
});
test.each([
  'friendliness',
  'informativeness',
  'relevance',
  'grounding',
] as const)('server requests a new round when %s fails despite reviewer pass', (dimension) => {
  const service = fx.open();
  service.enqueue(interaction(101));
  const first = service.claim('worker')!;
  const made = service.submitResult({
    ...first,
    sessionId: freshSession(),
    artifact: generation(first.payload.requiredSampleIds),
  });
  if (made.outcome !== 'verify_queued') throw new Error('Expected verify');
  const second = service.claim('worker')!;
  const checked = review(made.proposalHash, second.payload.requiredSampleIds);
  checked.comparisons = checked.comparisons.map((item) => ({ ...item, quality: { ...good, [dimension]: 1 } }));
  const result = service.submitResult({
    jobId: second.jobId,
    leaseToken: second.leaseToken,
    sessionId: freshSession(),
    artifact: checked,
  });
  expect(result.outcome).toBe('revision_queued');
  expect(service.status().awaitingAdmin).toEqual([]);
  service.close();
});
test('unassessed human-facing quality cannot be silently approved', () => {
  const service = fx.open();
  service.enqueue(interaction(101));
  const first = service.claim('worker')!;
  const made = service.submitResult({
    jobId: first.jobId,
    leaseToken: first.leaseToken,
    sessionId: freshSession(),
    artifact: generation(first.payload.requiredSampleIds),
  });
  if (made.outcome !== 'verify_queued') throw new Error('Expected verify');
  const second = service.claim('worker')!;
  const checked = review(made.proposalHash, second.payload.requiredSampleIds);
  checked.comparisons = checked.comparisons.map(({ quality: _, ...item }) => item);
  expect(
    service.submitResult({
      jobId: second.jobId,
      leaseToken: second.leaseToken,
      sessionId: freshSession(),
      artifact: checked,
    }).outcome,
  ).toBe('revision_queued');
  service.close();
});
