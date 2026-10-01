// The shared MTProto service tier is fail-closed: it turns on only for a configured, present and
// identity-verified service account, and it can look people up but never send (#753).
// Synthetic IDs and temp directories only.
import { Database } from 'bun:sqlite';
import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { closeSync, fstatSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrations } from '../../src/database/migrations.ts';
import { TelegramSessionRepository } from '../../src/database/repositories/telegram-session.repository.ts';
import { UserRepository } from '../../src/database/repositories/user.repository.ts';
import { runMigrations } from '../../src/database/schema.ts';
import {
  createServiceTier,
  type ScriptResult,
  SERVICE_SCRIPTS,
  ServiceLookupUnavailableError,
  type ServiceScript,
  type ServiceScriptRunner,
  type ServiceTierDisabledReason,
} from '../../src/services/telegram-session/service-tier.ts';

const expectedId = 5_000_000_001;
const configured = { MTPROTO_API_ID: 123, MTPROTO_API_HASH: 'synthetic', MTPROTO_SERVICE_USER_ID: expectedId };
const probeOk: ScriptResult = { stdout: JSON.stringify({ ok: true, user_id: expectedId }), stderr: '', exitCode: 0 };

interface Call {
  script: ServiceScript;
  args: readonly string[];
  stdin?: string;
}

function fakeRunner(respond: (script: ServiceScript, args: readonly string[]) => ScriptResult) {
  const calls: Call[] = [];
  const run: ServiceScriptRunner = async (script, args, options) => {
    calls.push({ script, args, stdin: options.stdin });
    return respond(script, args);
  };
  return { run, calls };
}

async function enabledTier(respond: (script: ServiceScript, args: readonly string[]) => ScriptResult) {
  const runner = fakeRunner((script, args) => (script === SERVICE_SCRIPTS.probe ? probeOk : respond(script, args)));
  const tier = await createServiceTier(configured, {
    dataDirectory: '/synthetic',
    sessionExists: () => true,
    run: runner.run,
  });
  if (!tier.enabled) throw new Error(`expected an enabled tier, got ${tier.reason}`);
  return { tier, calls: runner.calls };
}

const ok = (value: unknown): ScriptResult => ({ stdout: JSON.stringify(value), stderr: '', exitCode: 0 });
const failed: ScriptResult = { stdout: '', stderr: 'synthetic failure', exitCode: 1 };

afterEach(() => mock.restore());

interface DisabledCase {
  settings: Parameters<typeof createServiceTier>[0];
  reason: ServiceTierDisabledReason;
}

const disabledCases: DisabledCase[] = [
  { settings: {}, reason: 'service_user_id_unset' },
  { settings: { ...configured, MTPROTO_SERVICE_USER_ID: undefined }, reason: 'service_user_id_unset' },
  ...[0, -1, Number.NaN, 1.5].map(
    (id): DisabledCase => ({
      settings: { ...configured, MTPROTO_SERVICE_USER_ID: id },
      reason: 'service_user_id_invalid',
    }),
  ),
  { settings: { ...configured, MTPROTO_API_ID: undefined }, reason: 'api_credentials_missing' },
  { settings: { ...configured, MTPROTO_API_HASH: '' }, reason: 'api_credentials_missing' },
];

for (const { settings, reason } of disabledCases) {
  test(`configuration ${JSON.stringify(settings)} keeps the tier off (${reason}) without probing`, async () => {
    const sessionExists = mock(() => true);
    const runner = fakeRunner(() => probeOk);
    const tier = await createServiceTier(settings, { dataDirectory: '/synthetic', sessionExists, run: runner.run });
    expect(tier).toEqual({ enabled: false, reason });
    expect(sessionExists).not.toHaveBeenCalled();
    expect(runner.calls).toEqual([]);
  });
}

test('with MTPROTO_SERVICE_USER_ID unset the real runner spawns no Python at all', async () => {
  const spawn = spyOn(Bun, 'spawn');
  const tier = await createServiceTier(
    { MTPROTO_API_ID: 123, MTPROTO_API_HASH: 'synthetic' },
    { dataDirectory: '/synthetic', sessionExists: () => true },
  );
  expect(tier).toEqual({ enabled: false, reason: 'service_user_id_unset' });
  expect(spawn).not.toHaveBeenCalled();
});

const probeFailures: { result: ScriptResult; reason: ServiceTierDisabledReason }[] = [
  { result: { ...probeOk, exitCode: 1 }, reason: 'probe_failed' },
  { result: { stdout: '{bad', stderr: '', exitCode: 0 }, reason: 'probe_failed' },
  { result: ok({ ok: false, user_id: expectedId }), reason: 'probe_failed' },
  { result: ok({ ok: true, user_id: expectedId + 1 }), reason: 'identity_mismatch' },
];

for (const { result, reason } of probeFailures) {
  test(`a probe answering ${result.stdout || '(nothing)'} / exit ${result.exitCode} fails closed (${reason})`, async () => {
    const runner = fakeRunner(() => result);
    const tier = await createServiceTier(configured, {
      dataDirectory: '/synthetic',
      sessionExists: () => true,
      run: runner.run,
    });
    expect(tier).toEqual({ enabled: false, reason });
    expect(runner.calls.map((call) => call.script)).toEqual([SERVICE_SCRIPTS.probe]);
  });
}

test('a probe that throws fails closed', async () => {
  const tier = await createServiceTier(configured, {
    dataDirectory: '/synthetic',
    sessionExists: () => true,
    run: async () => {
      throw new Error('synthetic spawn failure');
    },
  });
  expect(tier).toEqual({ enabled: false, reason: 'probe_failed' });
});

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

test('only the service session file in the data directory permits a probe; user sessions stay untouched', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'service-tier-'));
  const userFile = join(directory, 'calendar.db');
  try {
    const db = new Database(userFile);
    try {
      runMigrations(db, migrations);
      new UserRepository(db).create({ telegram_id: expectedId + 1 });
      new TelegramSessionRepository(db).upsert(
        expectedId + 1,
        Buffer.from('synthetic ordinary-user authorization'),
        '+0 synthetic',
        'synthetic',
      );
    } finally {
      db.close();
    }
    const before = snapshot(userFile);
    const files = readdirSync(directory);
    const reads = spyOn(fs, 'readFileSync');
    const writes = spyOn(fs, 'writeFileSync');
    const queries = spyOn(Database.prototype, 'query');
    const prepares = spyOn(Database.prototype, 'prepare');
    const runner = fakeRunner(() => probeOk);
    expect(await createServiceTier(configured, { dataDirectory: directory, run: runner.run })).toEqual({
      enabled: false,
      reason: 'session_missing',
    });
    expect(runner.calls).toEqual([]);
    expect(reads).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
    expect(queries).not.toHaveBeenCalled();
    expect(prepares).not.toHaveBeenCalled();
    mock.restore();
    expect(readdirSync(directory)).toEqual(files);
    expect(snapshot(userFile)).toEqual(before);

    writeFileSync(join(directory, 'other.session'), 'synthetic unrelated session');
    expect(await createServiceTier(configured, { dataDirectory: directory, run: runner.run })).toMatchObject({
      enabled: false,
      reason: 'session_missing',
    });
    expect(runner.calls).toEqual([]);

    writeFileSync(join(directory, 'voice_caller.session'), 'synthetic service session');
    const tier = await createServiceTier(configured, { dataDirectory: directory, run: runner.run });
    expect(tier).toMatchObject({ enabled: true, accountId: expectedId });
    expect(runner.calls.map((call) => call.script)).toEqual([SERVICE_SCRIPTS.probe]);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('the enabled tier offers lookups, member lists, birthdays and the voice bridge — and nothing that sends', async () => {
  const { tier } = await enabledTier(() => failed);
  const operations = Object.keys(tier).sort();
  expect(operations).toEqual([
    'accountId',
    'enabled',
    'fetchBirthdays',
    'getChatMembers',
    'lookupUser',
    'resolveUsername',
    'voiceBridgeScript',
  ]);
  expect(operations.filter((name) => /send|message|forward|invite|deliver/i.test(name))).toEqual([]);
  expect(Object.values(SERVICE_SCRIPTS).filter((script) => /send/i.test(script))).toEqual([]);
});

test('resolveUsername tells "no such username" apart from "could not check"', async () => {
  const { tier, calls } = await enabledTier((_script, args) =>
    args[0] === 'known_person'
      ? ok({ id: 5_000_000_300, firstName: 'Known', username: 'known_person' })
      : args[0] === 'nobody_here'
        ? { stdout: '', stderr: 'ERROR:UsernameNotOccupied', exitCode: 2 }
        : args[0] === 'zero_id'
          ? ok({ id: 0, username: 'zero_id' })
          : failed,
  );
  expect(await tier.resolveUsername('@known_person')).toEqual({
    id: 5_000_000_300,
    firstName: 'Known',
    username: 'known_person',
  });
  expect(await tier.resolveUsername('nobody_here')).toBeNull();
  await expect(tier.resolveUsername('flood_waited')).rejects.toBeInstanceOf(ServiceLookupUnavailableError);
  await expect(tier.resolveUsername('zero_id')).rejects.toBeInstanceOf(ServiceLookupUnavailableError);
  expect(calls.filter((call) => call.script === SERVICE_SCRIPTS.resolveUsername).map((call) => call.args)).toEqual([
    ['known_person'],
    ['nobody_here'],
    ['flood_waited'],
    ['zero_id'],
  ]);
});

test('resolveUsername rejects when the script cannot even start', async () => {
  const runner = fakeRunner(() => probeOk);
  const tier = await createServiceTier(configured, {
    dataDirectory: '/synthetic',
    sessionExists: () => true,
    run: async (script, args, options) => {
      if (script === SERVICE_SCRIPTS.probe) return runner.run(script, args, options);
      throw new Error('synthetic spawn failure');
    },
  });
  if (!tier.enabled) throw new Error('expected an enabled tier');
  await expect(tier.resolveUsername('someone')).rejects.toBeInstanceOf(ServiceLookupUnavailableError);
});

test('resolveUsername answers repeated lookups of one username from memory, but retries a failed one', async () => {
  let failing = true;
  const { tier, calls } = await enabledTier((_script, args) =>
    args[0] === 'known_person'
      ? ok({ id: 5_000_000_300, username: 'known_person' })
      : args[0] === 'nobody_here'
        ? { stdout: '', stderr: '', exitCode: 2 }
        : failing
          ? failed
          : ok({ id: 5_000_000_301, username: 'flaky' }),
  );
  for (const handle of ['known_person', '@Known_Person', 'KNOWN_PERSON']) {
    expect(await tier.resolveUsername(handle)).toMatchObject({ id: 5_000_000_300 });
  }
  expect(await tier.resolveUsername('nobody_here')).toBeNull();
  expect(await tier.resolveUsername('@nobody_here')).toBeNull();
  await expect(tier.resolveUsername('flaky')).rejects.toBeInstanceOf(ServiceLookupUnavailableError);
  failing = false;
  expect(await tier.resolveUsername('flaky')).toMatchObject({ id: 5_000_000_301 });
  expect(calls.filter((call) => call.script === SERVICE_SCRIPTS.resolveUsername).map((call) => call.args)).toEqual([
    ['known_person'],
    ['nobody_here'],
    ['flaky'],
    ['flaky'],
  ]);
});

test('resolveUsername refuses a handle that is not a Telegram username without spawning', async () => {
  const { tier, calls } = await enabledTier(() => failed);
  for (const bad of ['', '@', '--help', 'two words', 'x'.repeat(65)]) {
    expect(await tier.resolveUsername(bad)).toBeNull();
  }
  expect(calls.filter((call) => call.script !== SERVICE_SCRIPTS.probe)).toEqual([]);
});

test('lookupUser rejects a profile for a different ID and never spawns for an invalid ID', async () => {
  const { tier, calls } = await enabledTier((_script, args) =>
    args[0] === '5000000400'
      ? ok({ id: 5_000_000_400, firstName: 'Fresh', deleted: false })
      : ok({ id: 5_000_000_999, firstName: 'Someone else' }),
  );
  expect(await tier.lookupUser(5_000_000_400)).toEqual({ id: 5_000_000_400, firstName: 'Fresh', deleted: false });
  expect(await tier.lookupUser(5_000_000_401)).toBeNull();
  for (const bad of [0, -7, 1.5, Number.NaN]) expect(await tier.lookupUser(bad)).toBeNull();
  expect(calls.filter((call) => call.script === SERVICE_SCRIPTS.lookupUser)).toHaveLength(2);
});

test('getChatMembers returns member IDs, or null when the listing fails', async () => {
  const listing = await enabledTier(() => ok([{ id: 5_000_000_501 }, { id: 5_000_000_502 }]));
  expect(await listing.tier.getChatMembers(-1_001_234)).toEqual([5_000_000_501, 5_000_000_502]);
  expect(listing.calls.at(-1)).toEqual({ script: SERVICE_SCRIPTS.chatMembers, args: ['-1001234'], stdin: undefined });
  const broken = await enabledTier(() => failed);
  expect(await broken.tier.getChatMembers(-1_001_234)).toBeNull();
});

test('fetchBirthdays keeps checked-without-birthday (null) apart from IDs the script could not check (absent)', async () => {
  const { tier, calls } = await enabledTier(() =>
    ok({ '5000000601': { day: 4, month: 7, year: 1990 }, '5000000602': null, '5000000699': null }),
  );
  const birthdays = await tier.fetchBirthdays([5_000_000_601, 5_000_000_602, 5_000_000_603, -3]);
  expect(birthdays && [...birthdays]).toEqual([
    [5_000_000_601, { day: 4, month: 7, year: 1990 }],
    [5_000_000_602, null],
  ]);
  expect(birthdays?.has(5_000_000_603)).toBe(false);
  expect(calls.at(-1)).toEqual({
    script: SERVICE_SCRIPTS.birthdays,
    args: [],
    stdin: '[5000000601,5000000602,5000000603]',
  });
  const broken = await enabledTier(() => ({ stdout: 'not json', stderr: '', exitCode: 0 }));
  expect(await broken.tier.fetchBirthdays([5_000_000_601])).toBeNull();
});
