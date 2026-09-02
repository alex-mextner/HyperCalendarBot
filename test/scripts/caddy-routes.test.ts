// test/scripts/caddy-routes.test.ts
//
// The reverse proxy only forwards paths named in its @bot matcher; everything
// else gets a static 200 page. That made the watchdog blind the moment it was
// pointed at /ready: the endpoint was never reached, every poll came back 200,
// and no outage could ever raise an alert. Nothing in the code could catch it —
// the endpoint worked, the script worked, and the routing between them did not.
//
// These tests tie the three files together, so moving any one of them without
// the others fails here instead of in production.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WebServerDeps } from '../../src/web/server.ts';
import { READINESS_BODY, startWebServer } from '../../src/web/server.ts';

const ROOT = join(import.meta.dir, '../..');
const caddyfile = readFileSync(join(ROOT, 'Caddyfile'), 'utf8');
const watchdog = readFileSync(join(ROOT, 'scripts/healthcheck-alert.sh'), 'utf8');
const deployWorkflow = readFileSync(join(ROOT, '.github/workflows/deploy.yml'), 'utf8');

/** The paths the @bot matcher forwards to the bot. */
function proxiedPaths(): string[] {
  const matcher = caddyfile.match(/@bot\s+path\s+(.+)/)?.[1];
  if (!matcher) throw new Error('Caddyfile has no @bot path matcher');
  return matcher.trim().split(/\s+/);
}

/** The readiness URL the cron watchdog polls. */
function watchdogUrl(): string {
  const url = watchdog.match(/^HEALTH_URL="([^"]+)"/m)?.[1];
  if (!url) throw new Error('healthcheck-alert.sh has no HEALTH_URL');
  return url;
}

/** The path the cron watchdog polls, taken from its own HEALTH_URL. */
function watchdogPath(): string {
  return new URL(watchdogUrl()).pathname;
}

/** The bodies a shell `case` branch accepts, unquoted and sorted. */
function acceptedBodies(branch: string): string[] {
  return branch
    .split('|')
    .map((pattern) => pattern.trim().replace(/^"|"$/g, ''))
    .sort();
}

function matches(pattern: string, path: string): boolean {
  return pattern.endsWith('/*') ? path.startsWith(pattern.slice(0, -1)) : pattern === path;
}

/** How long the proxy holds a request while the container restarts, in seconds. */
function proxyRetryWindowSeconds(): number {
  const value = caddyfile.match(/lb_try_duration\s+(\d+)s/)?.[1];
  if (!value) throw new Error('Caddyfile has no lb_try_duration');
  return Number(value);
}

/** How long the deploy's own readiness probe waits, in seconds. */
function deployProbeTimeoutSeconds(): number {
  const value = deployWorkflow.match(/curl -s --max-time (\d+) https:\/\/\S*\/ready/)?.[1];
  if (!value) throw new Error('deploy.yml has no readiness probe');
  return Number(value);
}

/** How long the watchdog waits for a readiness answer, in seconds. */
function probeTimeoutSeconds(): number {
  const value = watchdog.match(/^PROBE_TIMEOUT=(\d+)/m)?.[1];
  if (!value) throw new Error('healthcheck-alert.sh has no PROBE_TIMEOUT');
  return Number(value);
}

describe('Caddy routing', () => {
  test('forwards the path the watchdog polls', () => {
    const path = watchdogPath();
    expect(proxiedPaths().some((pattern) => matches(pattern, path))).toBe(true);
  });

  // The server leg is asserted by asking the running server, not by searching
  // its source: a comment naming the path would satisfy a text search, and a
  // text search would break on a rename that changed nothing about the route.
  test('forwards both health endpoints the server answers', async () => {
    const proxied = proxiedPaths();
    const deps: WebServerDeps = {
      config: { OAUTH_SERVER_PORT: 0 } as WebServerDeps['config'],
      userRepo: {} as WebServerDeps['userRepo'],
      aiChainDown: () => false,
      aiChainVerified: () => true,
    };
    const { stop, port } = startWebServer(deps);
    try {
      for (const path of ['/health', '/ready']) {
        const res = await fetch(`http://localhost:${port}${path}`);
        expect(res.status).toBe(200);
        expect(proxied.some((pattern) => matches(pattern, path))).toBe(true);
      }
    } finally {
      stop();
    }
  });

  // Caddy evaluates handle blocks top to bottom, so the catch-all swallows
  // everything below it. Matching the right paths is worth nothing if the
  // static page is reached first — that is the shape the outage had.
  test('the bot handler is reached before the static page', () => {
    const botHandler = caddyfile.indexOf('handle @bot {');
    const staticHandler = caddyfile.indexOf('handle {');
    expect(botHandler).toBeGreaterThan(-1);
    expect(staticHandler).toBeGreaterThan(-1);
    expect(botHandler).toBeLessThan(staticHandler);
  });

  // The proxy holds a request while the container restarts; a probe that gives
  // up first turns every deploy into a timeout instead of a delayed answer.
  // Both probes of the readiness path are held to it, the watchdog's and the
  // deploy's — the invariant is the proxy's, not one script's.
  test('every readiness probe waits longer than the proxy retries', () => {
    expect(probeTimeoutSeconds()).toBeGreaterThan(proxyRetryWindowSeconds());
    expect(deployProbeTimeoutSeconds()).toBeGreaterThan(proxyRetryWindowSeconds());
  });

  // Routing is applied by a reload the deploy cannot fail on (shared server), so
  // the deploy checks the outcome against the very URL the watchdog will poll.
  test('the deploy verifies the URL the watchdog polls', () => {
    expect(deployWorkflow).toContain(watchdogUrl());
  });

  // The deploy decides "routed" by recognising the bodies the bot answers with.
  // That list is a copy of the server's, and a copy that drifts fails every
  // deploy for a routing problem that does not exist.
  test('the deploy accepts exactly the bodies the server answers with', () => {
    const branch = deployWorkflow.match(/^\s*(.+)\)\s*ROUTED="\$BODY"/m)?.[1];
    if (!branch) throw new Error('deploy.yml has no readiness case branch');
    expect(acceptedBodies(branch)).toEqual([...Object.values(READINESS_BODY)].sort());
  });

  // The watchdog holds the same list, for the same reason: a 200 from anything
  // but the bot is the blind state, not health. Three copies of one contract,
  // so all three are compared against the one the server actually sends.
  test('the watchdog accepts exactly the bodies the server answers with', () => {
    const branch = watchdog.match(/^\s*(.+)\)\s*return 0\s*;;/m)?.[1];
    if (!branch) throw new Error('healthcheck-alert.sh has no accepted-body case branch');
    expect(acceptedBodies(branch)).toEqual([...Object.values(READINESS_BODY)].sort());
  });

  // Everything not matched gets a static 200, which is why an unrouted health
  // path is worse than a missing one: it looks alive.
  test('an unrouted path would fall through to the static page', () => {
    expect(caddyfile).toContain('respond "HyperCalendarBot is running" 200');
    expect(proxiedPaths().some((pattern) => matches(pattern, '/not-a-bot-path'))).toBe(false);
  });
});
