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
  'src/services/ai/claude-credential-pool.ts#requestWithinBudget': {
    reason:
      'per-key request budget; run() counts every attempt that timed out before the request ended, except the one thrown at the streaming round, which reports it',
    reportedBy: 'src/services/ai/claude-credential-pool.ts#reportKeyTimeouts',
  },
  'src/services/ai/model-registry.ts#resolveModelOverride': {
    reason: 'arms the catalogue probe budget; probeAndCache counts a listing that ran out of it',
    reportedBy: 'src/services/ai/model-registry.ts#reportListingTimeout',
  },
  'src/services/ai/model-registry.ts#listLiveModels': {
    reason: 'the listing request budget; a listing that timed out is counted by the shared reportListingTimeout',
    reportedBy: 'src/services/ai/model-registry.ts#reportListingTimeout',
  },
  'src/services/ai/model-registry.ts#waitForCatalog': {
    reason:
      "a joiner's wait for the shared listing; its expiry before the probe's own is counted by reportListingTimeout",
    reportedBy: 'src/services/ai/model-registry.ts#reportListingTimeout',
  },
  'src/services/ai/chat-run-gate.ts#scheduleWithTimeout': {
    reason: 'the lease and reservation timers of the chat line; a lease that ran out is reported by waitFor',
    reportedBy: 'src/services/ai/chat-run-gate.ts#ChatRunGate.waitFor',
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
  'src/services/image/render-service.ts#RenderService.renderDirect': {
    reason:
      "the worker wait of a picture's render; it throws a typed RenderTimeoutError and ImageDelivery.failTimedOut reports it once, with the user's note, so a second report here would count one slow render twice",
    reportedBy: 'src/services/image/image-delivery.ts#ImageDelivery.failTimedOut',
  },
  'src/services/image/image-delivery.ts#deadlineAfter': {
    reason:
      'the shared timer of the render and upload bounds of a picture (renderOnce and run; ImageDelivery.failTimedOut reports the one that fired, renderFresh the one that cut a rebuild) and of the two waits of close(), which are accounted for on that entry',
    reportedBy: 'src/services/image/image-delivery.ts#ImageDelivery.failTimedOut',
  },
  'src/services/image/image-delivery.ts#ImageDelivery.renderOnce': {
    reason:
      'the picture render bound; a render cut by it is reported by ImageDelivery.failTimedOut, and a rebuild cut by it (the earlier picture is sent instead) by ImageDelivery.renderFresh as recovered',
    reportedBy: 'src/services/image/image-delivery.ts#ImageDelivery.failTimedOut',
  },
  'src/services/image/image-delivery.ts#ImageDelivery.tell': {
    reason:
      "the bound on the one failure note of a picture, so a Telegram call that hangs or sleeps through a flood wait does not hold the delivery. Deliberately NOT reported: the delivery's own end (failed, timed out) is already reported once, and a note that does not go out only logs 'the failure note could not be sent'",
  },
  'src/services/image/image-delivery.ts#ImageDelivery.run': {
    reason: 'the picture upload bound; an upload cut by it is reported by ImageDelivery.failTimedOut',
    reportedBy: 'src/services/image/image-delivery.ts#ImageDelivery.failTimedOut',
  },
  'src/services/image/image-delivery.ts#ImageDelivery.close': {
    reason:
      "two waits at shutdown. The upload grace: a picture whose upload is still running ends unknown and raises the UncertainSend alert (reportUncertain). The shutdown note budget: deliberately NOT reported, it is best effort at exit (a stuck Telegram call only logs 'shutdown note not sent'); the whole shutdown deadline is already bounded and reported in bootstrap/shutdown.ts",
  },
  // Timers that are not deadlines: nothing is cut off or abandoned when they fire.
  'src/bootstrap/launch.ts#launchBot': {
    reason:
      'the backoff pause between two Telegram start attempts after a transient network failure; nothing is cut off or abandoned when it fires, and giving up is a fatal log plus the crash alert',
  },
  'src/services/image/render-failure-reporter.ts#defaultSchedule': {
    reason: 'the end of the 10 min aggregation window of the render-failure alert; it sends what was held back',
  },
  'src/services/image/image-delivery.ts#ImageDelivery.schedule': {
    reason:
      'the pause before the store is asked again to write a delivery outcome it refused (a locked database); nothing is cut off or abandoned when it fires',
  },
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
