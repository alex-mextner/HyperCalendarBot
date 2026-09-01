// test/scripts/healthcheck-alert.test.ts
//
// The cron watchdog is production alerting: it decides what reaches the admin
// and what stays quiet. Its state machine grew real branches — verified versus
// unverified recovery, a bounded wait, a reason relayed into the message — and
// none of that was covered, so a broken branch would only show up as silence
// during an outage.
//
// These tests run the real script with a stubbed `curl`, so the assertions are
// about what the admin receives, not about how the script is written.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '../../scripts/healthcheck-alert.sh');

let work: string;

/** The script under test, pointed at this run's temp files instead of /tmp and /opt. */
function stagedScript(): string {
  const source = readFileSync(SCRIPT, 'utf8')
    .replace('ENV_FILE="/opt/hypercal/.env"', `ENV_FILE="${join(work, 'env')}"`)
    .replace('STATE_FILE="/tmp/hypercal-down"', `STATE_FILE="${join(work, 'down')}"`)
    .replace('UNVERIFIED_FILE="/tmp/hypercal-unverified-since"', `UNVERIFIED_FILE="${join(work, 'unverified')}"`)
    .replace('RETRY_DELAY=15', 'RETRY_DELAY=0');
  const path = join(work, 'healthcheck.sh');
  writeFileSync(path, source);
  return path;
}

/** A curl that answers with the given status and body, and records what would be sent. */
function stubCurl(): void {
  writeFileSync(
    join(work, 'bin', 'curl'),
    `#!/bin/bash
out=""
args=("$@")
for ((i=0;i<\${#args[@]};i++)); do
  if [[ "\${args[$i]}" == "-o" ]]; then out="\${args[$((i+1))]}"; fi
done
if printf '%s\\n' "$@" | grep -q "api.telegram.org"; then
  printf '%s\\n' "$@" | tr '\\n' ' ' >> "$SENT_LOG"; echo >> "$SENT_LOG"; exit 0
fi
if printf '%s\\n' "$@" | grep -q "/admin/alerts"; then exit 0; fi
[[ -n "$out" ]] && printf '%s' "$PROBE_BODY" > "$out"
printf '%s' "$PROBE_CODE"
`,
    { mode: 0o755 },
  );
}

async function poll(status: string, body: string): Promise<string> {
  const proc = Bun.spawn(['bash', stagedScript()], {
    env: {
      ...process.env,
      PATH: `${join(work, 'bin')}:${process.env.PATH}`,
      PROBE_CODE: status,
      PROBE_BODY: body,
      SENT_LOG: join(work, 'sent.log'),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  await proc.exited;
  return readFileSync(join(work, 'sent.log'), 'utf8');
}

function consideredDown(): boolean {
  return existsSync(join(work, 'down'));
}

function ageUnverified(seconds: number): void {
  writeFileSync(join(work, 'unverified'), String(Math.floor(Date.now() / 1000) - seconds));
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'hypercal-watchdog-'));
  writeFileSync(join(work, 'env'), 'BOT_TOKEN=t\nBOT_ADMIN_ID=1\nADMIN_ALERT_TOKEN=x\n');
  writeFileSync(join(work, 'sent.log'), '');
  Bun.spawnSync(['mkdir', '-p', join(work, 'bin')]);
  stubCurl();
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('healthcheck watchdog', () => {
  // The admin's reaction to a DOWN alert differs by cause, and getting it wrong
  // is expensive: restarting brings back a process that failed to start, but it
  // does nothing for a dead provider chain except throw away the record of it.
  test('a chain outage alert says so and warns against restarting', async () => {
    const sent = await poll('503', 'ai chain down');
    expect(sent).toContain('DOWN');
    expect(sent).toContain('ai chain down');
    expect(sent).toContain('restart will not fix this');
    expect(consideredDown()).toBe(true);
  });

  test('one alert per outage, not one per poll', async () => {
    await poll('503', 'ai chain down');
    const before = readFileSync(join(work, 'sent.log'), 'utf8').split('\n').length;
    await poll('503', 'ai chain down');
    const after = readFileSync(join(work, 'sent.log'), 'utf8').split('\n').length;
    expect(after).toBe(before);
  });

  // The likeliest reaction to the alert is a restart, and a restarted process
  // has no evidence about the providers. Announcing a recovery there would be
  // announcing one nobody verified.
  test('a restart that cannot vouch for the chain announces nothing', async () => {
    await poll('503', 'ai chain down');
    writeFileSync(join(work, 'sent.log'), '');
    const sent = await poll('200', 'ok (unverified)');
    expect(sent.trim()).toBe('');
    expect(consideredDown()).toBe(true);
  });

  test('a real answer after that announces the recovery', async () => {
    await poll('503', 'ai chain down');
    await poll('200', 'ok (unverified)');
    writeFileSync(join(work, 'sent.log'), '');
    const sent = await poll('200', 'ok');
    expect(sent).toContain('recovered');
    expect(consideredDown()).toBe(false);
  });

  // While the down-state exists the alert branch stays silent, so waiting for
  // proof forever would swallow the alert for a different outage starting
  // later. The wait is bounded, and expiring it announces nothing — there is
  // still no proof to announce.
  test('the unverified wait is bounded, and expiring it stays silent', async () => {
    await poll('503', 'ai chain down');
    await poll('200', 'ok (unverified)');
    expect(consideredDown()).toBe(true);

    ageUnverified(3600);
    writeFileSync(join(work, 'sent.log'), '');
    const sent = await poll('200', 'ok (unverified)');
    expect(sent.trim()).toBe('');
    expect(consideredDown()).toBe(false);
  });

  // Regression: the wait used to be measured from the start of the outage, so
  // an outage older than the window expired it on the very first unverified
  // answer — no waiting at all, in exactly the long outage it was built for.
  test('the wait starts when the bot came back, not when the outage did', async () => {
    await poll('503', 'ai chain down');
    writeFileSync(join(work, 'down'), '');
    Bun.spawnSync(['touch', '-t', '202001010000', join(work, 'down')]);

    await poll('200', 'ok (unverified)');
    expect(consideredDown()).toBe(true);
  });

  test('a later outage re-arms alerting after the wait expired', async () => {
    await poll('503', 'ai chain down');
    await poll('200', 'ok (unverified)');
    ageUnverified(3600);
    await poll('200', 'ok (unverified)');
    writeFileSync(join(work, 'sent.log'), '');

    const sent = await poll('503', 'bot not started');
    expect(sent).toContain('DOWN');
    expect(sent).toContain('bot not started');
  });
});
