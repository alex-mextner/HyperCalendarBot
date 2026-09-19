import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

test('post-ship orchestration validates release ownership and invokes exact merged code', () => {
  const result = spawnSync('python3', ['-B', 'test/python/test_post_ship_deploy.py'], {
    cwd: resolve(import.meta.dir, '../..'),
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect({ status: result.status, stderr: result.stderr }).toEqual({
    status: 0,
    stderr: expect.stringContaining('OK'),
  });
}, 30_000);
