// test/services/ai/provider-eligibility.test.ts
//
// The module decides which providers a request skips, so its edges are where a
// bug hides: a block that outlives its cause wastes capacity, and one that
// covers the wrong requests silently degrades a chain nobody is watching.
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  clearBlock,
  isBlocked,
  isQuotaExhausted,
  isRequestTooLarge,
  noteFailureForEligibility,
  resetEligibility,
} from '../../../src/services/ai/provider-eligibility.ts';

const NOW = Date.parse('2026-09-02T20:00:00Z');
const ZAI_QUOTA = 'Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-09-03 21:15:09';
const GROQ_TOO_LARGE =
  'Request too large for model `openai/gpt-oss-120b` in organization `org_x` service tier `on_demand` on tokens per minute (TPM): Limit 8000, Requested 18725';

function headersWith(retryAfter: string): Headers {
  return new Headers({ 'retry-after': retryAfter });
}

beforeEach(() => {
  resetEligibility();
});

describe('what a failure implies', () => {
  // The stated reset is a day away; trusting it literally would bench the
  // provider past any point where a stale memory is still evidence.
  test('a stated reset is trusted only up to an hour', () => {
    const block = noteFailureForEligibility('zai', 429, ZAI_QUOTA, undefined, NOW);
    expect(block?.scope).toBe('all');
    expect(block?.untilMs).toBe(NOW + 60 * 60 * 1000);
    expect(isBlocked('zai', false, NOW + 59 * 60 * 1000)).toBe(true);
    expect(isBlocked('zai', false, NOW + 61 * 60 * 1000)).toBe(false);
  });

  test('a Retry-After header wins over the prose', () => {
    const block = noteFailureForEligibility('zai', 429, ZAI_QUOTA, headersWith('90'), NOW);
    expect(block?.untilMs).toBe(NOW + 90_000);
  });

  // The SDK types these as fetch Headers, but the errors this repo logs from
  // production serialize as a plain object. Reading only one shape would drop
  // the provider's own answer and fall back to guessing.
  test('a Retry-After sent as a plain object is read too', () => {
    const block = noteFailureForEligibility('zai', 429, 'Rate limit reached', { 'retry-after': '45' }, NOW);
    expect(block?.untilMs).toBe(NOW + 45_000);
  });

  // Two blocks with different scopes coexist: the shorter one used to overwrite
  // the longer, and the size rejection came back a request later.
  test('a brief quota block does not cut a standing size block short', () => {
    noteFailureForEligibility('groq', 413, GROQ_TOO_LARGE, undefined, NOW);
    noteFailureForEligibility('groq', 429, 'Rate limit reached', undefined, NOW);

    expect(isBlocked('groq', false, NOW + 5 * 60 * 1000)).toBe(false);
    expect(isBlocked('groq', true, NOW + 5 * 60 * 1000)).toBe(true);
  });

  // A rate limit with no stated end gets the short block: guessing long is the
  // expensive mistake.
  test('a rate limit with no stated end gets two minutes', () => {
    const block = noteFailureForEligibility('gemini', 429, 'Rate limit reached for requests', undefined, NOW);
    expect(block?.untilMs).toBe(NOW + 2 * 60 * 1000);
  });

  // A reset time already in the past says nothing about the future.
  test('a stated reset in the past falls back to the short block', () => {
    const stale = 'Limit Exhausted. Your limit will reset at 2026-09-01 10:00:00';
    const block = noteFailureForEligibility('zai', 429, stale, undefined, NOW);
    expect(block?.untilMs).toBe(NOW + 2 * 60 * 1000);
  });

  // The tier cannot grow a request; the catalog cannot shrink without a deploy.
  test('a size rejection blocks only the requests that carry tools', () => {
    const block = noteFailureForEligibility('groq', 413, GROQ_TOO_LARGE, undefined, NOW);
    expect(block?.scope).toBe('with-tools');
    expect(isBlocked('groq', true, NOW + 60_000)).toBe(true);
    expect(isBlocked('groq', false, NOW + 60_000)).toBe(false);
  });

  // Everything else is worth retrying at once — benching on a 500 would turn a
  // blip into an outage of our own making.
  test('a transient failure benches nobody', () => {
    expect(noteFailureForEligibility('hf', 500, 'Internal Server Error', undefined, NOW)).toBeNull();
    expect(noteFailureForEligibility('hf', 404, 'model does not exist', undefined, NOW)).toBeNull();
    expect(isBlocked('hf', true, NOW)).toBe(false);
  });

  test('an answer ends the block', () => {
    noteFailureForEligibility('zai', 429, ZAI_QUOTA, undefined, NOW);
    clearBlock('zai');
    expect(isBlocked('zai', false, NOW + 1000)).toBe(false);
  });
});

describe('recognising the two failures', () => {
  test('reads the provider messages seen in production', () => {
    expect(isQuotaExhausted(429, ZAI_QUOTA)).toBe(true);
    expect(isRequestTooLarge(413, GROQ_TOO_LARGE)).toBe(true);
    expect(isQuotaExhausted(500, 'Internal Server Error')).toBe(false);
    expect(isRequestTooLarge(400, 'Bad Request')).toBe(false);
  });
});
