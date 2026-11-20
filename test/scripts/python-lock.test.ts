import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');

// Preserve the historical title; the universal requirements lock now records this stamp.
test('uv.lock records the project version from pyproject.toml (run `uv lock` after a version bump)', () => {
  const declared = readFileSync(join(ROOT, 'pyproject.toml'), 'utf8').match(/^version = "([^"]+)"$/m)?.[1];
  const locked = readFileSync(join(ROOT, 'requirements.lock'), 'utf8').match(
    /^# {4}python3 scripts\/compile-python-lock\.py --project-version (\d+\.\d+\.\d+)$/m,
  )?.[1];
  expect(declared).toMatch(/^\d+\.\d+\.\d+$/);
  expect({ locked }).toEqual({ locked: declared });
});
