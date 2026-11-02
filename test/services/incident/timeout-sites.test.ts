// Guard: the owner asked that every timeout the bot hits reaches the repair flow (reportTimeout ->
// alerts queue). Every callable in src that arms a deadline must report through reportTimeout, or sit
// on the reviewed list below with a reason, so a new deadline cannot slip in unnoticed. The check is
// per callable (test/helpers/timeout-site-scan.ts), not per file: a file whose first deadline reports
// does not cover a second one in another function. It scans source on purpose: it protects an
// invariant no behaviour test can. There is no "pending" category: a real deadline reports now, or
// this test fails.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Glob } from 'bun';
import { scanDeadlineSites, unreportedUnits } from '../../helpers/timeout-site-scan.ts';

interface Exemption {
  reason: string;
  /** `file#unit` that reports on this unit's behalf; the test checks that it really does. */
  reportedBy?: string;
}

/** Keyed `file#unit`; the unit is `Class.method`, a function name, or `<module>`. */
const EXEMPT: { [site: string]: Exemption } = {
  // The deadline is armed here, another callable reports it.
  'src/services/ai/provider-deadline.ts#waitForAbort': {
    reason: 'per-attempt provider deadline; streaming.ts reports it per round',
    reportedBy: 'src/services/ai/streaming.ts#reportProviderTimeouts',
  },
  'src/services/ai/provider-deadline.ts#withinProviderDeadline': {
    reason: 'per-attempt provider deadline; streaming.ts reports it per round',
    reportedBy: 'src/services/ai/streaming.ts#reportProviderTimeouts',
  },
  'src/services/ai/clients.ts#claudeClient': {
    reason: 'provider HTTP client timeout; an attempt that hits it is reported per round by streaming.ts',
    reportedBy: 'src/services/ai/streaming.ts#reportProviderTimeouts',
  },
  'src/services/ai/clients.ts#hfClient': {
    reason: 'provider HTTP client timeout; an attempt that hits it is reported per round by streaming.ts',
    reportedBy: 'src/services/ai/streaming.ts#reportProviderTimeouts',
  },
  'src/services/ai/provider-circuit.ts#openProviderCircuitStore': {
    reason: 'sets the sidecar SQLite busy timeout; guarded() forwards the locked-database error it swallows',
    reportedBy: 'src/services/ai/provider-circuit.ts#guarded',
  },
  'src/services/ai/clients.ts#openrouterClient': {
    reason: 'provider HTTP client timeout; an attempt that hits it is reported per round by streaming.ts',
    reportedBy: 'src/services/ai/streaming.ts#reportProviderTimeouts',
  },
  'src/services/ai/clients.ts#zaiClient': {
    reason: 'provider HTTP client timeout; an attempt that hits it is reported per round by streaming.ts',
    reportedBy: 'src/services/ai/streaming.ts#reportProviderTimeouts',
  },
  'src/database/index.ts#DatabaseService.constructor': {
    reason: 'sets the SQLite busy timeout, which surfaces as a thrown error the central handlers forward',
    reportedBy: 'src/bot/index.ts#createBot',
  },
  'src/worker/playwright-pool.ts#PlaywrightPool.acquire': {
    reason: 'a 50 ms poll sleep inside the acquire loop; the loop deadline is reported by reportAcquireTimeout',
    reportedBy: 'src/worker/playwright-pool.ts#PlaywrightPool.reportAcquireTimeout',
  },
  // Timers that are not deadlines: nothing is cut off or abandoned when they fire.
  'src/services/ai/telegram-stream.ts#sleep': { reason: 'edit throttle and flood-wait sleep' },
  'src/services/voice/thinking-phrase-player.ts#ThinkingPhrasePlayer.start': {
    reason: 'UI timers for filler phrases',
  },
  'src/worker/session-keepalive.ts#processSessionKeepalive': {
    reason: 'pause between two keepalive checks, a rate limit',
  },
  'src/services/voice/call-session.ts#CallSession.resetInactivityTimer': {
    reason: 'asks a quiet caller whether they are still there; no operation is cut',
  },
  'src/services/voice/call-session-manager.ts#CallSessionManager.onWebSocketOpen': {
    reason: 'a 30 min cap that reaps long or leaked live-call sessions; it gives up on no operation in flight',
  },
};

const files = [...new Glob('src/**/*.ts').scanSync('.')].filter(
  (file) => file !== 'src/services/incident/timeout-reporter.ts',
);
const sources = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]));
const scans = new Map(files.map((file) => [file, scanDeadlineSites(file, sources.get(file) ?? '')]));

function reports(site: string): boolean {
  const [file = '', unit = ''] = site.split('#');
  return scans.get(file)?.reporting.has(unit) ?? false;
}

describe('every deadline reports through reportTimeout or is a reviewed exemption', () => {
  test('no callable arms a deadline without a report or an exemption', () => {
    const unaccounted = files
      .flatMap((file) => unreportedUnits(file, sources.get(file) ?? ''))
      .filter((site) => !(site in EXEMPT));
    expect(unaccounted).toEqual([]);
  });

  test('every exemption still names a callable that arms a deadline and does not already report', () => {
    for (const site of Object.keys(EXEMPT)) {
      const [file = '', unit = ''] = site.split('#');
      const scan = scans.get(file);
      expect(scan, `${file} exists`).toBeDefined();
      expect(
        scan?.sites.some((found) => found.unit === unit),
        `${site} arms a deadline`,
      ).toBe(true);
      expect(reports(site), `${site} reports, so it needs no exemption`).toBe(false);
    }
  });

  test('an exemption that is reported elsewhere names a callable that really reports', () => {
    for (const [site, exemption] of Object.entries(EXEMPT)) {
      if (exemption.reportedBy === undefined) continue;
      expect(reports(exemption.reportedBy), `${site} is reported by ${exemption.reportedBy}`).toBe(true);
    }
  });

  test('no exemption is a deadline that merely does not report yet', () => {
    for (const [site, exemption] of Object.entries(EXEMPT)) {
      expect(exemption.reason, `${site}: an exemption names why it is not a deadline, or who reports it`).not.toMatch(
        /pending|not yet|todo|follow-?up|tracked by/i,
      );
    }
  });
});

describe('the scanner tells one callable from the next', () => {
  const file = 'src/example.ts';

  test('a file with a reported deadline and an unreported second one fails on the second', () => {
    const source = `
      import { reportTimeout } from './incident/timeout-reporter.ts';
      export async function reported(): Promise<void> {
        const signal = AbortSignal.timeout(1000);
        try { await fetch('https://example.test', { signal }); }
        catch { reportTimeout({ kind: 'http', elapsedMs: 1, limitMs: 1000, recovered: false }); }
      }
      export async function unreported(): Promise<void> {
        await fetch('https://example.test', { signal: AbortSignal.timeout(2000) });
      }
    `;
    expect(unreportedUnits(file, source)).toEqual([`${file}#unreported`]);
  });

  test('a timer callback and a nested closure belong to the function that armed them', () => {
    const source = `
      export function arm(): void {
        const timer = setTimeout(() => { reportTimeout({ kind: 'x', elapsedMs: 1, limitMs: 1, recovered: false }); }, 5);
        timer.unref();
      }
    `;
    expect(unreportedUnits(file, source)).toEqual([]);
  });

  test('class methods are separate units and constructors count as one', () => {
    const source = `
      class Pool {
        constructor() { setTimeout(() => {}, 1); }
        async acquire(): Promise<void> { await Promise.race([a(), b()]); }
        report(): void { reportTimeout({ kind: 'pool', elapsedMs: 1, limitMs: 1, recovered: false }); }
      }
    `;
    expect(unreportedUnits(file, source)).toEqual([`${file}#Pool.constructor`, `${file}#Pool.acquire`]);
  });

  test('client timeout options, DOMException timeouts and SQLite busy timeouts are deadline sites', () => {
    const source = `
      export const client = () => new Client({ timeout: 30_000 });
      export function cut(): never { throw new DOMException('too slow', 'TimeoutError'); }
      export function open(db: Db): void { db.exec('PRAGMA busy_timeout = 3000'); }
      export function sleepy(): void { const timeout = 5; use({ timeoutMs: timeout }); }
    `;
    expect(unreportedUnits(file, source)).toEqual([`${file}#client`, `${file}#cut`, `${file}#open`]);
  });

  test('forwarding a caught database error counts as a report', () => {
    const source = `
      export function guarded(run: () => void): void {
        try { run(); } catch (err) { reportIfDatabaseBusy(err, 3000); }
      }
      export function open(db: Db): void { db.exec('PRAGMA busy_timeout = 3000'); guarded(() => {}); }
    `;
    expect(unreportedUnits(file, source)).toEqual([`${file}#open`]);
  });

  test('two deadlines in one callable with one report between them are not told apart (known limit)', () => {
    const source = `
      export async function both(): Promise<void> {
        await a(AbortSignal.timeout(1));
        await b(AbortSignal.timeout(2));
        reportTimeout({ kind: 'x', elapsedMs: 1, limitMs: 1, recovered: false });
      }
    `;
    expect(unreportedUnits(file, source)).toEqual([]);
  });
});
