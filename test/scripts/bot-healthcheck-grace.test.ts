// test/scripts/bot-healthcheck-grace.test.ts
//
// The odroid runs willfarrell/autoheal with AUTOHEAL_CONTAINER_LABEL=all: it restarts any
// container whose Docker health status turns `unhealthy`. The bot answers /health with 503
// "bot not started" until its Telegram start finishes, so a cold start slower than the
// healthcheck grace is killed and starts again from zero. Measured cold starts on the loaded
// host: ~95 s and 100-170 s on 2026-11-11 (restart loops, #980), and 440 s on 2026-11-14 right
// after the host's hard reset (container start 17:18:30 UTC, "Bot started" 17:25:50 UTC, killed
// at 17:25:59, 17:27:43 and 17:29:38 UTC). These tests keep the grace above the slowest
// measured start while a bot that hangs after it has started is still restarted within minutes.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const COMPOSE_FILE = join(import.meta.dir, '../../docker-compose.yml');

const SLOWEST_MEASURED_COLD_START_S = 440;
/** A hung bot that had started must not stay up longer than this before autoheal acts. */
const STEADY_STATE_DETECTION_LIMIT_S = 120;

const healthcheckSchema = z.object({
  test: z.array(z.string()),
  interval: z.string(),
  timeout: z.string(),
  retries: z.number().int().positive(),
  start_period: z.string(),
  start_interval: z.string().optional(),
});

const composeSchema = z.object({
  services: z.object({ bot: z.object({ healthcheck: healthcheckSchema }) }),
});

/** Compose duration ("30s", "10m", "1m30s") in seconds. */
function seconds(duration: string): number {
  const parts = [...duration.matchAll(/(\d+)(h|m|s)/g)];
  const consumed = parts.map((p) => p[0]).join('');
  if (parts.length === 0 || consumed !== duration) throw new Error(`unsupported duration: ${duration}`);
  const unit = { h: 3600, m: 60, s: 1 } as const;
  return parts.reduce((total, [, value, u]) => total + Number(value) * unit[u as keyof typeof unit], 0);
}

function botHealthcheck() {
  return composeSchema.parse(Bun.YAML.parse(readFileSync(COMPOSE_FILE, 'utf8'))).services.bot.healthcheck;
}

describe('bot healthcheck grace under autoheal (#980)', () => {
  test('a cold start as slow as the slowest measured one never turns the container unhealthy', () => {
    const hc = botHealthcheck();
    // Failures inside start_period do not count; after it, `retries` failures `interval` apart do.
    const grace = seconds(hc.start_period) + hc.retries * seconds(hc.interval);
    expect(grace).toBeGreaterThan(SLOWEST_MEASURED_COLD_START_S);
    // Margin over the measurement itself: a slower host must not loop again at the first excess.
    expect(seconds(hc.start_period)).toBeGreaterThanOrEqual(SLOWEST_MEASURED_COLD_START_S);
  });

  test('a started bot that hangs is still marked unhealthy within the steady-state limit', () => {
    const hc = botHealthcheck();
    // A hanging probe runs until `timeout`, and Docker waits `interval` after each probe ends.
    const worstDetection = hc.retries * (seconds(hc.interval) + seconds(hc.timeout));
    expect(worstDetection).toBeLessThanOrEqual(STEADY_STATE_DETECTION_LIMIT_S);
  });

  test('a long grace does not delay a fast start: the start-period probe runs often', () => {
    const hc = botHealthcheck();
    // Without start_interval Docker probes the starting container only every `interval`.
    expect(hc.start_interval).toBeDefined();
    expect(seconds(hc.start_interval ?? hc.interval)).toBeLessThanOrEqual(10);
  });
});
