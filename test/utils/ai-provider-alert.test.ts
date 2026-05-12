// test/utils/ai-provider-alert.test.ts
import { describe, expect, test } from 'bun:test';
import { isBalanceExhausted } from '../../src/utils/ai-provider-alert.ts';

describe('isBalanceExhausted', () => {
  test('true for "insufficient balance"', () => {
    expect(isBalanceExhausted(new Error('Your account has insufficient balance for this request'))).toBe(true);
  });

  test('true for "exceeded your current quota"', () => {
    expect(isBalanceExhausted(new Error('You exceeded your current quota, please check your plan'))).toBe(true);
  });

  test('true for Anthropic "credit balance is too low"', () => {
    expect(isBalanceExhausted(new Error('Your credit balance is too low to access the Anthropic API'))).toBe(true);
  });

  test('true for "payment required"', () => {
    expect(isBalanceExhausted(new Error('402 payment required'))).toBe(true);
  });

  test('false for Groq 413 TPM rate-limit message (regression — used to false-positive on "/billing" URL)', () => {
    const msg =
      '413 Request too large for model `llama-3.3-70b-versatile` in organization `org_x` ' +
      'service tier `on_demand` on tokens per minute (TPM): Limit 12000, Requested 24355, ' +
      'please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier ' +
      'today at https://console.groq.com/settings/billing';
    expect(isBalanceExhausted(new Error(msg))).toBe(false);
  });

  test('false for plain "Request too large" without explicit balance keywords', () => {
    expect(isBalanceExhausted(new Error('Request too large for this model'))).toBe(false);
  });

  test('false for unrelated errors', () => {
    expect(isBalanceExhausted(new Error('socket hang up'))).toBe(false);
    expect(isBalanceExhausted(new Error('500 internal server error'))).toBe(false);
  });

  test('false for non-Error values', () => {
    expect(isBalanceExhausted('insufficient balance')).toBe(false);
    expect(isBalanceExhausted(null)).toBe(false);
    expect(isBalanceExhausted(undefined)).toBe(false);
  });
});
