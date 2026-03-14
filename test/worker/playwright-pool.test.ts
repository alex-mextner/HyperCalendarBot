import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PlaywrightPool } from '../../src/worker/playwright-pool.ts';

describe('PlaywrightPool', () => {
  let pool: PlaywrightPool;

  beforeAll(async () => {
    // Low values for testing — production defaults: maxPages=4, maxUseCount=50, maxAgeMs=300_000
    pool = new PlaywrightPool({ maxPages: 2, maxUseCount: 5, maxAgeMs: 60_000 });
    await pool.initialize();
  });

  afterAll(async () => {
    await pool.shutdown();
  });

  test('acquire returns a functional page', async () => {
    const page = await pool.acquire();
    expect(page).toBeDefined();
    expect(typeof page.setContent).toBe('function');
    await pool.release(page);
  });

  test('page can render HTML and screenshot', async () => {
    const page = await pool.acquire();
    await page.setContent(
      '<html><body><div id="__root" style="width:200px;height:100px;background:#f00;">Test</div></body></html>',
    );
    const height = await page.evaluate(() => document.getElementById('__root')?.scrollHeight ?? 100);
    expect(height).toBeGreaterThan(0);
    const buf = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 200, height } });
    expect(buf.byteLength).toBeGreaterThan(100); // valid PNG
    await pool.release(page);
  });

  test('respects maxPages limit (timeout on third acquire)', async () => {
    const p1 = await pool.acquire();
    const p2 = await pool.acquire();
    await expect(pool.acquire(300)).rejects.toThrow('timeout');
    await pool.release(p1);
    await pool.release(p2);
  });

  test('reuses released pages', async () => {
    const p1 = await pool.acquire();
    await pool.release(p1);
    const p2 = await pool.acquire();
    expect(p2).toBe(p1);
    await pool.release(p2);
  });
});
