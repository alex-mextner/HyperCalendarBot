import { expect, test } from 'bun:test';
import {
  Budget,
  BudgetExceededError,
  estimateRequestUsd,
  OUTPUT_RESERVE_TOKENS,
  TOTAL_BUDGET_CAP_USD,
} from '../../../scripts/model-quality/budget.ts';

const price = { inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.2, asOf: '2026-10-23', source: 'test' };

test('the run-wide cap is the owner-approved 3 USD and cannot be raised by an argument', () => {
  expect(TOTAL_BUDGET_CAP_USD).toBe(3);
  expect(() => new Budget(3.01)).toThrow('Invalid budget');
  expect(() => new Budget(0)).toThrow('Invalid budget');
  expect(() => new Budget(Number.NaN)).toThrow('Invalid budget');
  expect(() => new Budget(2, 1.5)).toThrow('exceeds the run-wide cap');
  expect(new Budget(1.5, 1.5).capUsd).toBe(1.5);
});

test('a reservation that would pass the cap is refused before any request is made', () => {
  const budget = new Budget(1);
  budget.reserve(0.6);
  expect(() => budget.reserve(0.5)).toThrow(BudgetExceededError);
  expect(budget.spentUsd).toBeCloseTo(0.6, 9);
});

test('settling with the real cost releases the unused reservation', () => {
  const budget = new Budget(1);
  const reservation = budget.reserve(0.6);
  budget.settle(reservation, 0.01);
  expect(budget.spentUsd).toBeCloseTo(0.01, 9);
  expect(budget.unknownReservations).toBe(0);
});

test('a call with unknown usage keeps its whole reservation: unknown is not free', () => {
  const budget = new Budget(1);
  const reservation = budget.reserve(0.4);
  budget.settle(reservation, null);
  expect(budget.spentUsd).toBeCloseTo(0.4, 9);
  expect(budget.unknownReservations).toBe(1);
});

test('settling twice is a bug, not a refund', () => {
  const budget = new Budget(1);
  const reservation = budget.reserve(0.4);
  budget.settle(reservation, 0.1);
  expect(() => budget.settle(reservation, 0)).toThrow('already settled');
});

test('the request estimate is an upper bound: bytes over two for input, a bounded output reserve', () => {
  const messages = [{ role: 'user' as const, content: 'x'.repeat(2000) }];
  const usd = estimateRequestUsd(price, messages, []);
  const inputBytes = new TextEncoder().encode(JSON.stringify(messages)).length + 2;
  expect(usd).toBeCloseTo(((inputBytes / 2) * 0.3 + OUTPUT_RESERVE_TOKENS * 1.2) / 1e6, 9);
});
