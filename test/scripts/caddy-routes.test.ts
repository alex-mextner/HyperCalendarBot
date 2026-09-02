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

const ROOT = join(import.meta.dir, '../..');
const caddyfile = readFileSync(join(ROOT, 'Caddyfile'), 'utf8');
const watchdog = readFileSync(join(ROOT, 'scripts/healthcheck-alert.sh'), 'utf8');
const server = readFileSync(join(ROOT, 'src/web/server.ts'), 'utf8');

/** The paths the @bot matcher forwards to the bot. */
function proxiedPaths(): string[] {
  const matcher = caddyfile.match(/@bot\s+path\s+(.+)/)?.[1];
  if (!matcher) throw new Error('Caddyfile has no @bot path matcher');
  return matcher.trim().split(/\s+/);
}

/** The path the cron watchdog polls, taken from its own HEALTH_URL. */
function watchdogPath(): string {
  const url = watchdog.match(/^HEALTH_URL="([^"]+)"/m)?.[1];
  if (!url) throw new Error('healthcheck-alert.sh has no HEALTH_URL');
  return new URL(url).pathname;
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

  // Asserted against the route expression, not a bare quoted string: a comment
  // or a leftover constant naming the path must not stand in for a live route.
  test('forwards both health endpoints the server answers', () => {
    const proxied = proxiedPaths();
    for (const path of ['/health', '/ready']) {
      expect(server).toContain(`url.pathname === '${path}'`);
      expect(proxied.some((pattern) => matches(pattern, path))).toBe(true);
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
  test('the watchdog waits longer than the proxy retries', () => {
    expect(probeTimeoutSeconds()).toBeGreaterThan(proxyRetryWindowSeconds());
  });

  // Everything not matched gets a static 200, which is why an unrouted health
  // path is worse than a missing one: it looks alive.
  test('an unrouted path would fall through to the static page', () => {
    expect(caddyfile).toContain('respond "HyperCalendarBot is running" 200');
    expect(proxiedPaths().some((pattern) => matches(pattern, '/not-a-bot-path'))).toBe(false);
  });
});
