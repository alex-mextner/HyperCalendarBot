import { expect, test } from 'bun:test';
import { checkSecretaryAccess } from '../../../../src/services/ai/tool-handlers/secretary-access.ts';

const makeRepo = (record: unknown) =>
  ({
    findByOwnerAndSecretary: () => record,
  }) as never;

test('no owner_id → returns caller telegram_id', () => {
  const result = checkSecretaryAccess(1, undefined, null, 'read');
  expect(result).toEqual({ ok: true, effectiveUserId: 1 });
});

test('owner_id present, no active record → denied', () => {
  const result = checkSecretaryAccess(1, 99, makeRepo(null), 'read');
  expect(result.ok).toBe(false);
  expect((result as { ok: false; error: string }).error).toContain('SECRETARY_ACCESS_DENIED');
});

test('owner_id present, active read record → ok for read op', () => {
  const record = { status: 'active', permission: 'read' };
  const result = checkSecretaryAccess(1, 99, makeRepo(record), 'read');
  expect(result).toEqual({ ok: true, effectiveUserId: 99 });
});

test('owner_id present, active read record → denied for write op', () => {
  const record = { status: 'active', permission: 'read' };
  const result = checkSecretaryAccess(1, 99, makeRepo(record), 'write');
  expect(result.ok).toBe(false);
  expect((result as { ok: false; error: string }).error).toContain('SECRETARY_ACCESS_DENIED');
});

test('owner_id present, active write record → ok for write op', () => {
  const record = { status: 'active', permission: 'write' };
  const result = checkSecretaryAccess(1, 99, makeRepo(record), 'write');
  expect(result).toEqual({ ok: true, effectiveUserId: 99 });
});
