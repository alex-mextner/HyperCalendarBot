import { describe, expect, test } from 'bun:test';
import { type MasterKeyCheckDeps, verifyMasterKeyOrExit } from '../../src/bootstrap/core.ts';
import type { TelegramSessionRepository } from '../../src/database/repositories/telegram-session.repository.ts';
import type { VerifyMasterKeyResult } from '../../src/services/crypto/master-key-check.ts';

// verifyMasterKeyOrExit only forwards the repository to the injected verifier.
const sessions = Object.create(null) as TelegramSessionRepository;

function harness(result: VerifyMasterKeyResult) {
  const exits: number[] = [];
  const fatals: string[] = [];
  const verifiedKeys: string[] = [];
  const deps: MasterKeyCheckDeps = {
    logger: { fatal: (_obj: unknown, message: string) => fatals.push(message) },
    exit: (code) => exits.push(code),
    verify: (_sessions, key) => {
      verifiedKeys.push(key.toString('hex'));
      return result;
    },
  };
  return { deps, exits, fatals, verifiedKeys };
}

describe('verifyMasterKeyOrExit', () => {
  test('no configured key means nothing to verify', async () => {
    const { deps, exits, verifiedKeys } = harness({ ok: true, reason: 'verified' });
    expect(await verifyMasterKeyOrExit(undefined, sessions, deps)).toBe(true);
    expect(verifiedKeys).toEqual([]);
    expect(exits).toEqual([]);
  });

  test('a key that matches the stored sessions lets startup continue', async () => {
    const { deps, exits, verifiedKeys } = harness({ ok: true, reason: 'verified' });
    expect(await verifyMasterKeyOrExit('abcd', sessions, deps)).toBe(true);
    expect(verifiedKeys).toEqual(['abcd']);
    expect(exits).toEqual([]);
  });

  test('a key that cannot decrypt the stored sessions logs fatal and exits 1', async () => {
    const { deps, exits, fatals } = harness({ ok: false, reason: 'mismatch', err: new Error('bad key') });
    expect(await verifyMasterKeyOrExit('abcd', sessions, deps)).toBe(false);
    expect(fatals).toEqual(['TELEGRAM_SESSION_MASTER_KEY does not match existing sessions — refusing to start']);
    expect(exits).toEqual([1]);
  });
});
