import { expect, test } from 'bun:test';
import { isExpectedServiceSession } from '../../src/services/telegram-session/service-session-identity.ts';

const success = JSON.stringify({ ok: true, user_id: 5000000001, username: 'synthetic_service' });
test('service credentials require an explicitly configured identity', () => {
  expect(isExpectedServiceSession(success, 0, undefined)).toBe(false);
  expect(isExpectedServiceSession(success, 0, 0)).toBe(false);
  expect(isExpectedServiceSession(success, 0, Number.NaN)).toBe(false);
});
test('a healthy session for another account cannot become the service sender', () => {
  expect(isExpectedServiceSession(success, 0, 5000000002)).toBe(false);
});
test('only a successful check for the expected user enables service delivery', () => {
  expect(isExpectedServiceSession(success, 0, 5000000001)).toBe(true);
  expect(isExpectedServiceSession(success, 1, 5000000001)).toBe(false);
  expect(isExpectedServiceSession('{"ok":false,"user_id":5000000001}', 0, 5000000001)).toBe(false);
});
test('malformed or incomplete probe output fails closed', () => {
  for (const value of ['OK', '{}', '{"ok":true}', 'null', '{"ok":true,"user_id":"5000000001"}']) {
    expect(isExpectedServiceSession(value, 0, 5000000001)).toBe(false);
  }
});
