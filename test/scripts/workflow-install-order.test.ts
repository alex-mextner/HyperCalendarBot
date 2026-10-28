import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');

// A plain `bun install` rewrites bun.lock in the runner, so a frozen check after it passes on a
// lockfile nobody committed (GH-870). The first dependency install must be the frozen one, and
// both workflows must run exactly the same single step. Every non-comment line that mentions
// `bun install` counts, so a multi-line `run: |` block cannot hide a plain install.
const WORKFLOWS = ['.github/workflows/deploy.yml', '.github/workflows/pr-ci.yml'];

for (const path of WORKFLOWS) {
  test(`${path} installs dependencies exactly once, with --frozen-lockfile`, () => {
    const installLines = readFileSync(join(ROOT, path), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => !line.startsWith('#') && /\bbun install\b/.test(line));
    expect(installLines).toEqual(['- run: bun install --frozen-lockfile']);
  });
}
