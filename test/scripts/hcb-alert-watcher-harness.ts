// test/scripts/hcb-alert-watcher-harness.ts
//
// Shared fixtures of the hcb-alert-watcher suites: a fake production server (Bun.serve), fake launcher,
// tmux, ctmux, tg and systemd-run executables that record their argv, an injected clock and a real
// state directory per test. Call useWatcherHarness() once at the top of a test file.

import { afterEach, beforeEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realDeps, type WatcherConfig, type WatcherDeps } from '../../scripts/hcb-alert-watcher.ts';

/** Obviously fake; what matters is that it is never printed, logged, briefed or passed on. */
export const BEARER = 'FAKE_VALUE_FOR_TESTS';
export const SCRIPT = join(import.meta.dir, '../../scripts/hcb-alert-watcher.ts');
export const START = Date.UTC(2026, 9, 24, 21, 0, 0);
export const MINUTE = 60_000;

interface FakeAlert {
  id: number;
  text: string;
  source: string;
  created_at: string;
}

interface FakeProd {
  queue: FakeAlert[];
  readyStatus: number;
  readyBody: string;
  /** /ready never answers (until the test ends): a host that thrashes swap answers late, not wrongly. */
  readyHeld: boolean;
  queueStatus: number;
  /** Server-side record of every request: path and whether the bearer value was right. */
  requests: Array<{ path: string; authorized: boolean }>;
  /** Every popped alert is recorded so a test can re-deliver it, as a crash between pop and ack would. */
  popped: FakeAlert[];
}

export let work: string;
export let server: Bun.Server<undefined>;
export let prod: FakeProd;
export let releaseReady: () => void;
export let readyGate: Promise<void>;
export let clock: { now: number };
export let logs: string[];

/** `created_at` the way the alerts table stores it: UTC, space-separated, no zone. */
export function alert(id: number, text: string, source: string, createdMs: number = START - 5 * MINUTE): FakeAlert {
  return { id, text, source, created_at: new Date(createdMs).toISOString().slice(0, 19).replace('T', ' ') };
}

function executable(name: string, body: string): void {
  writeFileSync(join(work, 'bin', name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
}

export function config(overrides: Partial<WatcherConfig> = {}): WatcherConfig {
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    token: BEARER,
    stateDir: join(work, 'state'),
    repoDir: join(work, 'repo'),
    pollSeconds: 30,
    rateLimitSeconds: 1800,
    downProbes: 3,
    staleSeconds: 12 * 3600,
    probeTimeoutSeconds: 5,
    commandTimeoutSeconds: 20,
    launcher: join(work, 'bin', 'rig-detached-omp'),
    tmuxBin: join(work, 'bin', 'tmux'),
    ctmuxBin: join(work, 'bin', 'ctmux'),
    tgBin: join(work, 'bin', 'tg'),
    scopeBin: join(work, 'bin', 'systemd-run'),
    tmuxSession: 'main',
    agentLogDir: join(work, 'agent-logs'),
    ...overrides,
  };
}

/** A fresh set of dependencies over the same state directory: what a service restart looks like. */
export function deps(cfg: WatcherConfig): WatcherDeps {
  return { ...realDeps(cfg), now: () => clock.now, log: (line) => logs.push(line) };
}

export function launches(): string[][] {
  const path = join(work, 'launches.log');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('|'));
}

export function briefOf(launchIndex = 0): string {
  const briefPath = launches()[launchIndex]?.[1];
  if (!briefPath) throw new Error(`no launch ${launchIndex}`);
  return readFileSync(briefPath, 'utf8');
}

export function recorded(file: string): string[] {
  const path = join(work, file);
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
}

/** Registers the per-test fake production server, fake executables and state directory. */
export function useWatcherHarness(): void {
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), 'hcb-alert-watcher-'));
    mkdirSync(join(work, 'bin'));
    mkdirSync(join(work, 'repo'));
    clock = { now: START };
    logs = [];
    prod = {
      queue: [],
      readyStatus: 200,
      readyBody: 'ok',
      readyHeld: false,
      queueStatus: 200,
      requests: [],
      popped: [],
    };
    ({ promise: readyGate, resolve: releaseReady } = Promise.withResolvers<void>());
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        const authorized = req.headers.get('Authorization') === `Bearer ${BEARER}`;
        prod.requests.push({ path, authorized });
        if (path === '/ready') {
          if (prod.readyHeld) await readyGate;
          return new Response(prod.readyBody, { status: prod.readyStatus });
        }
        if (path === '/admin/alerts/next') {
          if (prod.queueStatus !== 200) return new Response('nope', { status: prod.queueStatus });
          if (!authorized) return new Response('Unauthorized', { status: 401 });
          const next = prod.queue.shift();
          if (!next) return new Response(null, { status: 204 });
          prod.popped.push(next);
          return Response.json(next);
        }
        return new Response('Not Found', { status: 404 });
      },
    });
    // The sanctioned launcher prints one line with the child pid and log path, then returns.
    // It records its argv, the brief it was handed and whether the alert secret leaked into its env.
    executable(
      'rig-detached-omp',
      `if [[ -e "${work}/launcher-fails" ]]; then echo "rig-detached-omp: boom" >&2; exit 2; fi
if [[ -e "${work}/launcher-slow-leaves-child" ]]; then
  sleep 30 &
  echo "detached agent '$1' launched (pid 4242, log ${work}/agent.log, workdir $3)"
  printf '%s|%s|%s\\n' "$1" "$2" "$3" >> "${work}/launches.log"
  sleep 1.6
  exit 0
fi
if [[ -e "${work}/launcher-leaves-child-on-stdout" ]]; then
  sleep 30 &
  echo "detached agent '$1' launched (pid 4242, log ${work}/agent.log, workdir $3)"
  printf '%s|%s|%s\\n' "$1" "$2" "$3" >> "${work}/launches.log"
  exit 0
fi
if [[ -e "${work}/launcher-killed" ]]; then kill -KILL $$; fi
if [[ -e "${work}/launcher-hangs" ]]; then echo attempt >> "${work}/launcher-attempts.log"; exec sleep 30; fi
if [[ -e "${work}/launcher-starts-then-hangs" ]]; then
  printf '%s|%s|%s\\n' "$1" "$2" "$3" >> "${work}/launches.log"
  sleep 30 &
  exec sleep 30
fi
printf '%s|%s|%s\\n' "$1" "$2" "$3" >> "${work}/launches.log"
if [[ -n "\${ADMIN_ALERT_TOKEN:-}" ]]; then echo launcher >> "${work}/env-leak.log"; fi
echo "detached agent '$1' launched (pid 4242, log ${work}/agent.log, workdir $3)"`,
    );
    // Every helper the watcher spawns records whether the alert secret reached it: tmux would keep it
    // in the server's global environment and hand it to every later shell and omp session.
    const leakCheck = (name: string) =>
      `if [[ -n "\${ADMIN_ALERT_TOKEN:-}" ]]; then echo ${name} >> "${work}/env-leak.log"; fi`;
    executable('tmux', `${leakCheck('tmux')}\nprintf '%s\\n' "$*" >> "${work}/tmux.log"`);
    executable('ctmux', `${leakCheck('ctmux')}\nprintf '%s\\n' "$*" >> "${work}/ctmux.log"`);
    executable(
      'tg',
      `${leakCheck('tg')}\nif [[ -e "${work}/tg-fails" ]]; then echo "tg: cannot reach api.telegram.org" >&2; exit 1; fi\nprintf '%s\\n' "$*" >> "${work}/tg.log"`,
    );
    // A tmux server that `ctmux ensure` forks must not live in the service's cgroup, where a restart
    // of the unit would kill the owner's whole tmux: the watcher puts both tmux calls in a scope.
    executable(
      'systemd-run',
      `printf '%s\\n' "$*" >> "${work}/scope.log"\nwhile [[ "$1" != "--" ]]; do shift; done\nshift\nexec "$@"`,
    );
  });

  afterEach(() => {
    releaseReady();
    server.stop(true);
    rmSync(work, { recursive: true, force: true });
  });
}

/** A test that points the watcher at its own fake server swaps it in here so the hooks stop the right one. */
export function replaceServer(next: Bun.Server<undefined>): void {
  server = next;
}
