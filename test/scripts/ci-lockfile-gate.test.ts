import { expect, test } from 'bun:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

// #870: a plain `bun install` before the frozen one rewrites bun.lock in place, so the frozen
// check then validates the file the first install just wrote and can never see a stale lock.
const ROOT = join(import.meta.dir, '../..');
const WORKFLOWS = ['deploy.yml', 'pr-ci.yml'] as const;

const workflowSchema = z.object({
  jobs: z.object({
    test: z.object({ steps: z.array(z.object({ run: z.string().optional() }).passthrough()) }).passthrough(),
  }),
});

function testJobRuns(file: string): string[] {
  const parsed = workflowSchema.parse(Bun.YAML.parse(readFileSync(join(ROOT, '.github/workflows', file), 'utf8')));
  return parsed.jobs.test.steps.flatMap((step) => (step.run === undefined ? [] : [step.run.trim()]));
}

test.each(WORKFLOWS)('%s installs once, frozen, before Playwright and the suite run', (file) => {
  const runs = testJobRuns(file);
  const installs = runs.filter((run) => /\bbun install\b/.test(run));
  expect(installs).toEqual(['bun install --frozen-lockfile']);
  const installAt = runs.indexOf('bun install --frozen-lockfile');
  const firstConsumer = runs.findIndex((run) => /^(bunx playwright|bun test|bun run lint|\.\/node_modules)/.test(run));
  expect(firstConsumer).toBeGreaterThan(installAt);
});

test('deploy.yml and pr-ci.yml run the same lockfile gate before the same checks', () => {
  const [deploy, prCi] = WORKFLOWS.map((file) => testJobRuns(file));
  // pr-ci.yml is the pre-merge copy of deploy.yml's `test` job (docs/reference/deploy-runbook.md):
  // every `run` step, install order included, is the same.
  expect(prCi).toEqual(deploy);
});

test('the frozen install rejects a manifest the committed lock does not match and never rewrites the lock', () => {
  const box = mkdtempSync(join(tmpdir(), 'hcb-lock-gate-'));
  try {
    for (const file of ['package.json', 'bun.lock']) cpSync(join(ROOT, file), join(box, file));
    const committedLock = readFileSync(join(box, 'bun.lock'), 'utf8');
    // `--dry-run --ignore-scripts` keeps the real command's lockfile check and drops the install.
    // The registry is unreachable on purpose: a lock that matches its manifest, and one that
    // visibly does not, are both decided without any download, so the test needs no network.
    const frozen = () =>
      Bun.spawnSync([process.execPath, 'install', '--frozen-lockfile', '--dry-run', '--ignore-scripts'], {
        cwd: box,
        env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(box, 'cache'), BUN_CONFIG_REGISTRY: 'http://127.0.0.1:9/' },
      });

    const committed = frozen();
    expect({ code: committed.exitCode, stderr: committed.exitCode === 0 ? '' : committed.stderr.toString() }).toEqual({
      code: 0,
      stderr: '',
    });

    // Dropping a dependency is a package.json change without the matching bun.lock change.
    const manifest = z
      .object({ dependencies: z.record(z.string(), z.string()) })
      .passthrough()
      .parse(JSON.parse(readFileSync(join(box, 'package.json'), 'utf8')));
    const dropped = Object.keys(manifest.dependencies)[0];
    expect(dropped).toBeDefined();
    if (dropped === undefined) return;
    delete manifest.dependencies[dropped];
    writeFileSync(join(box, 'package.json'), JSON.stringify(manifest, null, 2));

    const stale = frozen();
    expect(stale.exitCode).not.toBe(0);
    expect(stale.stderr.toString()).toContain('lockfile had changes, but lockfile is frozen');
    expect(readFileSync(join(box, 'bun.lock'), 'utf8')).toBe(committedLock);
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
});
