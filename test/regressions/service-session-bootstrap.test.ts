// Exercises service-session decisions and filesystem bootstrap using only synthetic local data.
import { Database } from 'bun:sqlite';
import { expect, mock, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { closeSync, fstatSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { migrations } from '../../src/database/migrations.ts';
import { TelegramSessionRepository } from '../../src/database/repositories/telegram-session.repository.ts';
import { UserRepository } from '../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';
import {
  bootstrapServiceSession,
  decideServiceSession,
} from '../../src/services/telegram-session/service-session-bootstrap.ts';

const expectedId = 5000000001;
const configured = { MTPROTO_API_ID: 123, MTPROTO_API_HASH: 'synthetic', MTPROTO_SERVICE_USER_ID: expectedId };
const success = { stdout: JSON.stringify({ ok: true, user_id: expectedId }), exitCode: 0 };

// Bytes and timestamps come from one open descriptor, so they describe the same file.
function snapshot(path: string): { bytes: Buffer; mtimeMs: number; ctimeMs: number } {
  const fd = openSync(path, 'r');
  try {
    const { mtimeMs, ctimeMs } = fstatSync(fd);
    return { bytes: readFileSync(fd), mtimeMs, ctimeMs };
  } finally {
    closeSync(fd);
  }
}

for (const settings of [
  {},
  { ...configured, MTPROTO_API_ID: undefined },
  { ...configured, MTPROTO_API_HASH: '' },
  ...[undefined, 0, -1, Number.NaN, 1.5].map((id) => ({ ...configured, MTPROTO_SERVICE_USER_ID: id })),
]) {
  test(`missing/invalid service configuration returns disabled: ${JSON.stringify(settings)}`, async () => {
    const sessionExists = mock(() => true);
    const probe = mock(async () => success);
    expect(await decideServiceSession(settings, { sessionExists, probe })).toBe(false);
    expect(sessionExists).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });
}

test('directory bootstrap leaves an active ordinary-user database untouched when the service file is absent', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'service-bootstrap-'));
  const userFile = join(directory, 'calendar.db');
  const serviceFile = join(directory, 'voice_caller.session');
  const probe = mock(async () => success);
  try {
    const db = new Database(userFile);
    try {
      runMigrations(db, migrations);
      new UserRepository(db).create({ telegram_id: expectedId + 1 });
      const sessions = new TelegramSessionRepository(db);
      sessions.upsert(
        expectedId + 1,
        Buffer.from('synthetic ordinary-user authorization'),
        '+0 synthetic',
        'synthetic',
      );
      expect(sessions.getMostRecentActive()?.user_id).toBe(expectedId + 1);
    } finally {
      db.close();
    }
    const before = snapshot(userFile);
    const files = readdirSync(directory);
    const reads = spyOn(fs, 'readFileSync');
    const queries = spyOn(Database.prototype, 'query');
    const prepares = spyOn(Database.prototype, 'prepare');
    const writes = spyOn(fs, 'writeFileSync');
    try {
      expect(await bootstrapServiceSession(configured, { dataDirectory: directory, probe })).toBe(false);
      expect(probe).not.toHaveBeenCalled();
      expect(reads).not.toHaveBeenCalled();
      expect(queries).not.toHaveBeenCalled();
      expect(prepares).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
    } finally {
      reads.mockRestore();
      queries.mockRestore();
      prepares.mockRestore();
      writes.mockRestore();
    }
    const after = readdirSync(directory);
    expect(after).toEqual(files);
    expect(after).not.toContain(basename(serviceFile));
    expect(snapshot(userFile)).toEqual(before);

    // Only the service filename in the supplied directory permits a probe.
    writeFileSync(join(directory, 'other.session'), 'synthetic unrelated session');
    expect(await bootstrapServiceSession(configured, { dataDirectory: directory, probe })).toBe(false);
    expect(probe).not.toHaveBeenCalled();
    writeFileSync(serviceFile, 'synthetic service session');
    for (const result of [
      { stdout: JSON.stringify({ ok: true, user_id: expectedId + 1 }), exitCode: 0 },
      { ...success, exitCode: 1 },
      { stdout: '{bad', exitCode: 0 },
      success,
    ]) {
      const serviceProbe = mock(async () => result);
      expect(await bootstrapServiceSession(configured, { dataDirectory: directory, probe: serviceProbe })).toBe(
        result === success,
      );
      expect(serviceProbe).toHaveBeenCalledTimes(1);
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});

for (const result of [
  { ...success, exitCode: 1 },
  { stdout: '{bad', exitCode: 0 },
  { stdout: JSON.stringify({ ok: true, user_id: expectedId + 1 }), exitCode: 0 },
]) {
  test(`failed/malformed/wrong-account probe returns disabled: ${result.stdout}/${result.exitCode}`, async () => {
    expect(await decideServiceSession(configured, { sessionExists: () => true, probe: async () => result })).toBe(
      false,
    );
  });
}

test('decision returns disabled when the probe throws', async () => {
  expect(
    await decideServiceSession(configured, {
      sessionExists: () => true,
      probe: async () => {
        throw new Error('synthetic probe failure');
      },
    }),
  ).toBe(false);
});

test('decision accepts a matching successful service probe', async () => {
  const probe = mock(async () => success);
  expect(await decideServiceSession(configured, { sessionExists: () => true, probe })).toBe(true);
  expect(probe).toHaveBeenCalledTimes(1);
});
