import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeGeminiQuotaStores, reserveGeminiBudget } from '../../../src/services/ai/gemini-quota.ts';

const dirs: string[] = [];
afterEach(() => {
  closeGeminiQuotaStores();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function path() {
  const dir = mkdtempSync(join(tmpdir(), 'hcb-budget-'));
  dirs.push(dir);
  return join(dir, 'quota.sqlite');
}
const budget = { scope: 'one-project', rpm: 2, tpm: 100, rpd: 3 };
const start = Date.parse('2026-09-26T12:00:00Z');
test('reopens persisted reservations and applies all three dimensions', () => {
  const db = path();
  reserveGeminiBudget(db, budget, 50, start);
  closeGeminiQuotaStores();
  reserveGeminiBudget(db, budget, 50, start + 1);
  expect(() => reserveGeminiBudget(db, budget, 1, start + 2)).toThrow('rpm');
  reserveGeminiBudget(db, budget, 20, start + 60002);
  expect(() => reserveGeminiBudget(db, budget, 1, start + 120005)).toThrow('rpd');
});
test('TPM rejects before reserving and does not drain unrelated scopes', () => {
  const db = path();
  reserveGeminiBudget(db, budget, 80, start);
  expect(() => reserveGeminiBudget(db, budget, 21, start + 1)).toThrow('tpm');
  reserveGeminiBudget(db, { ...budget, scope: 'other-project' }, 100, start + 2);
  reserveGeminiBudget(db, budget, 20, start + 3);
});
test('day resets at Pacific midnight while the last-minute budget remains', () => {
  const db = path();
  const before = Date.parse('2026-09-26T06:59:50Z');
  reserveGeminiBudget(db, { ...budget, rpd: 1 }, 40, before);
  expect(() => reserveGeminiBudget(db, { ...budget, rpd: 1 }, 1, before + 1000)).toThrow('rpd');
  reserveGeminiBudget(db, { ...budget, rpd: 1 }, 40, before + 11000);
  expect(() => reserveGeminiBudget(db, budget, 1, before + 12000)).toThrow('rpm');
});
