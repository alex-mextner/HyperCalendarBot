import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';

const WORKFLOWS = resolve(import.meta.dir, '../../.github/workflows');

const stepSchema = z
  .object({
    name: z.string().optional(),
    uses: z.string().optional(),
    run: z.string().optional(),
    with: z
      .object({
        labels: z.string().optional(),
        platforms: z.string().optional(),
        name: z.string().optional(),
        path: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
const workflow = z
  .object({
    jobs: z.object({
      build: z.object({
        needs: z.literal('test'),
        'runs-on': z.literal('ubuntu-24.04-arm'),
        steps: z.array(stepSchema),
      }),
      deploy: z.object({
        needs: z.literal('build'),
        'runs-on': z.array(z.string()),
        permissions: z.record(z.string(), z.string()),
        steps: z.array(stepSchema),
      }),
    }),
  })
  .parse(Bun.YAML.parse(readFileSync(resolve(WORKFLOWS, 'deploy.yml'), 'utf8')));

test('hosted image labels bind the tested source revision and target the arm64 host', () => {
  const build = workflow.jobs.build.steps.find((step) => step.uses?.startsWith('docker/build-push-action@'));
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression in the workflow contract
  expect(build?.with?.labels).toContain('org.opencontainers.image.revision=${{ github.sha }}');
  expect(build?.with?.platforms).toBe('linux/arm64');
});

test('the build uploads the checked release as one artifact named for the commit', () => {
  const prepare = workflow.jobs.build.steps.find((step) => step.name === 'Prepare exact release artifact');
  expect(prepare?.run).toContain('release-artifact.py');
  const upload = workflow.jobs.build.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  expect(upload?.uses).toMatch(/@[0-9a-f]{40}\b/);
  expect(upload?.with?.path).toBe('release');
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression in the workflow contract
  expect(upload?.with?.name).toBe('release-${{ github.sha }}');
});

// Root on the odroid fetches and verifies the artifact itself; the runner neither downloads
// release files nor gets more than read access to Actions metadata.
test('deployment runs on the odroid runner through the root activation wrapper only', () => {
  expect(workflow.jobs.deploy['runs-on']).toEqual(['self-hosted', 'odroid-hcb']);
  expect(workflow.jobs.deploy.permissions).toEqual({ actions: 'read', contents: 'read' });
  expect(workflow.jobs.deploy.steps.map((step) => step.uses).filter(Boolean)).toEqual([]);
  const text = JSON.stringify(workflow.jobs.deploy);
  expect(text).not.toMatch(/secrets\.SSH_|appleboy\/|download-artifact/);
});

test('hosted deployment never follows latest or changes unrelated shared services', () => {
  const text = JSON.stringify(workflow.jobs.deploy);
  expect(text).not.toContain(':latest');
  expect(text).not.toContain('docker image prune');
  expect(text).not.toContain('caddy reload');
});

// A self-hosted runner executes whatever a job gives it on the production box, so no
// workflow that a pull request can trigger may ever be scheduled onto it.
test('no pull-request-triggered workflow targets a self-hosted runner', () => {
  // Only the trigger names matter; their configs are null, an object, or (schedule) a list.
  const triggerConfig = z.union([z.null(), z.looseObject({}), z.array(z.looseObject({}))]);
  const triggerSchema = z.union([z.string(), z.array(z.string()), z.record(z.string(), triggerConfig)]);
  const jobSchema = z.object({ 'runs-on': z.union([z.string(), z.array(z.string())]).optional() }).passthrough();
  const fileSchema = z.object({ on: triggerSchema, jobs: z.record(z.string(), jobSchema) }).passthrough();
  const files = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));
  expect(files).toContain('deploy.yml');
  for (const file of files) {
    const parsed = fileSchema.parse(Bun.YAML.parse(readFileSync(resolve(WORKFLOWS, file), 'utf8')));
    const triggers =
      typeof parsed.on === 'string' ? [parsed.on] : Array.isArray(parsed.on) ? parsed.on : Object.keys(parsed.on);
    if (!triggers.some((trigger) => trigger.startsWith('pull_request'))) continue;
    for (const [name, job] of Object.entries(parsed.jobs)) {
      const labels = [job['runs-on'] ?? []].flat();
      expect({
        file,
        name,
        selfHosted: labels.some((label) => label === 'self-hosted' || label.startsWith('odroid')),
      }).toEqual({
        file,
        name,
        selfHosted: false,
      });
    }
  }
});

// The odroid is a shared multi-user box: any local user can read every process's argv in
// /proc/*/cmdline. The activate step hands root only the SHA as an argument; the token
// travels on stdin, and nothing on the box ever carries it in an argument list.
describe('the activate step on the self-hosted runner', () => {
  const step = workflow.jobs.deploy.steps.find((candidate) => candidate.name === 'Activate verified prebuilt release');
  const token = `FAKE-TOKEN-FOR-CONTRACT-TESTS-${'0'.repeat(12)}`;
  const sha = 'a'.repeat(40);

  test('passes the token to the root wrapper on stdin and only the SHA as an argument', async () => {
    const script = step?.run;
    if (!script) throw new Error('deploy.yml has no "Activate verified prebuilt release" step');
    const work = mkdtempSync(join(tmpdir(), 'hcb-activate-'));
    try {
      // A stand-in for sudo: records its argv and stdin, and while it holds the token looks
      // for it in every process's argv.
      writeFileSync(
        join(work, 'sudo'),
        [
          '#!/usr/bin/env python3',
          'import json, os, sys',
          'stdin = sys.stdin.read()',
          'secret = stdin.strip().encode()',
          'hits = []',
          'for pid in filter(str.isdigit, os.listdir("/proc")):',
          '    try:',
          '        if secret and secret in open(f"/proc/{pid}/cmdline", "rb").read(): hits.append(pid)',
          '    except OSError:',
          '        pass',
          `json.dump({"argv": sys.argv[1:], "stdin": stdin, "hits": hits}, open(${JSON.stringify(join(work, 'sudo.json'))}, "w"))`,
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      const child = Bun.spawn(['bash', '-e', '-c', script], {
        env: { PATH: `${work}:${process.env.PATH ?? '/usr/bin:/bin'}`, GH_TOKEN: token, RELEASE_SHA: sha },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await child.exited).toBe(0);
      const recorded = z
        .object({ argv: z.array(z.string()), stdin: z.string(), hits: z.array(z.string()) })
        .parse(JSON.parse(readFileSync(join(work, 'sudo.json'), 'utf8')));
      expect(recorded.argv).toEqual(['-n', '/usr/local/sbin/hypercal-activate-release', sha]);
      expect(recorded.stdin).toBe(`${token}\n`);
      expect(recorded.hits).toEqual([]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
