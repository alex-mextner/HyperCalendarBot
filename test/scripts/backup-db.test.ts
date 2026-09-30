// test/scripts/backup-db.test.ts
//
// The cron/deploy backup copies the whole calendar database — every user's chat
// history, calendars and Telegram sessions — onto a host shared with other
// services (GH-613). These tests run the real script with a stubbed `docker`
// that executes the script's own `bun -e` snippet the way the container does
// (as a process with the container's default umask 022), so they check the
// mode a real backup ends up with, not how the script is written.
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const SCRIPT = join(import.meta.dir, '../../scripts/backup-db.sh');

let work: string;
let dataDir: string;
let backupDir: string;

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

/** The script under test, pointed at this run's temp data dir instead of /opt/hypercal/data. */
function stagedScript(): string {
  const source = readFileSync(SCRIPT, 'utf8');
  expect(source).toContain('DATA_DIR="/opt/hypercal/data"');
  const path = join(work, 'backup-db.sh');
  writeFileSync(path, source.replace('DATA_DIR="/opt/hypercal/data"', `DATA_DIR="${dataDir}"`));
  return path;
}

/**
 * A `docker` that runs the `bun -e` snippet it is given like the bot container
 * does: umask 022, with the container's /app/data mapped to the temp data dir.
 * AFTER_EXEC runs afterwards to model a container that ignores the snippet's umask.
 */
function stubDocker(afterExec = ''): void {
  writeFileSync(
    join(work, 'bin', 'docker'),
    `#!/bin/bash
set -euo pipefail
umask 022
code="\${@: -1}"
code="\${code//\\/app\\/data/$FAKE_DATA_DIR}"
bun -e "$code"
${afterExec}
`,
    { mode: 0o755 },
  );
}

async function runBackup(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bash', stagedScript()], {
    env: { ...process.env, PATH: `${join(work, 'bin')}:${process.env.PATH}`, FAKE_DATA_DIR: dataDir },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function backups(): string[] {
  return readdirSync(backupDir).filter((name) => name.startsWith('calendar_'));
}

describe('backup-db.sh', () => {
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'backup-db-test-'));
    dataDir = join(work, 'data');
    backupDir = join(dataDir, 'backups');
    mkdirSync(join(work, 'bin'));
    mkdirSync(dataDir);
    const db = new Database(join(dataDir, 'calendar.db'));
    db.exec(
      "CREATE TABLE events (id INTEGER PRIMARY KEY, title TEXT); INSERT INTO events (title) VALUES ('synthetic');",
    );
    db.close();
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  test('a new backup is 0600 in a 0700 directory, although the container umask is 022', async () => {
    stubDocker();
    mkdirSync(backupDir, { mode: 0o755 });
    chmodSync(backupDir, 0o755);

    const result = await runBackup();

    expect(result).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('Backup OK') });
    const [file] = backups();
    expect(file).toMatch(/^calendar_.*\.db\.gz$/);
    expect(mode(join(backupDir, file!))).toBe(0o600);
    expect(mode(backupDir)).toBe(0o700);
    // It is a real compressed SQLite copy, not an empty placeholder.
    expect(
      gunzipSync(readFileSync(join(backupDir, file!)))
        .subarray(0, 15)
        .toString(),
    ).toBe('SQLite format 3');
  });

  test('a missing backup directory is created 0700', async () => {
    stubDocker();

    const result = await runBackup();

    expect(result.exitCode).toBe(0);
    expect(mode(backupDir)).toBe(0o700);
    expect(backups().map((name) => mode(join(backupDir, name)))).toEqual([0o600]);
  });

  test('a backup the container leaves world-readable is still stored 0600', async () => {
    stubDocker('chmod 644 "$FAKE_DATA_DIR"/backups/calendar_*.db');

    const result = await runBackup();

    expect(result.exitCode).toBe(0);
    expect(backups().map((name) => mode(join(backupDir, name)))).toEqual([0o600]);
  });

  test('older world-readable copies are restricted and expired ones rotated out', async () => {
    stubDocker();
    mkdirSync(backupDir, { mode: 0o700 });
    const recent = join(backupDir, 'calendar_2026-09-28_03-00-00.db.gz');
    const botCopy = join(backupDir, 'calendar-2026-09-28.db');
    const expired = join(backupDir, 'calendar_2020-01-01_03-00-00.db.gz');
    const expiredOrphan = join(backupDir, 'calendar_2020-01-02_03-00-00.db');
    const unrelated = join(backupDir, 'notes.txt');
    for (const path of [recent, botCopy, expired, expiredOrphan, unrelated]) {
      writeFileSync(path, 'synthetic');
      chmodSync(path, 0o644);
    }
    for (const path of [expired, expiredOrphan]) {
      utimesSync(path, new Date('2020-01-01T03:00:00Z'), new Date('2020-01-01T03:00:00Z'));
    }

    const result = await runBackup();

    expect(result.exitCode).toBe(0);
    expect([existsSync(expired), existsSync(expiredOrphan)]).toEqual([false, false]);
    expect([mode(recent), mode(botCopy), mode(unrelated)]).toEqual([0o600, 0o600, 0o644]);
  });

  test('fails when the container produced no backup', async () => {
    writeFileSync(join(work, 'bin', 'docker'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    mkdirSync(backupDir, { mode: 0o700 });

    const result = await runBackup();

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain('Backup OK');
    expect(backups()).toEqual([]);
  });

  test('fails closed and removes the copy when its mode cannot be restricted', async () => {
    // The container's own chmod is not the host's stubbed one below. The 0755 directory makes
    // the check fail regardless of whether this platform's gzip copies the input file's mode.
    stubDocker('/bin/chmod 755 "$FAKE_DATA_DIR/backups"; /bin/chmod 644 "$FAKE_DATA_DIR"/backups/calendar_*.db');
    // A chmod that reports success without changing anything (e.g. a filesystem ignoring modes).
    writeFileSync(join(work, 'bin', 'chmod'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });

    const result = await runBackup();

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain('Backup OK');
    expect(backups()).toEqual([]);
  });
});
