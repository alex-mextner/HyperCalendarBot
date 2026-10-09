import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
        outputs: z.object({ archive_sha256: z.string(), config_digest: z.string() }),
        steps: z.array(stepSchema),
      }),
      deploy: z.object({
        needs: z.literal('build'),
        'runs-on': z.array(z.string()),
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

test('the build hands the exact release to deploy as one artifact', () => {
  const prepare = workflow.jobs.build.steps.find((step) => step.name === 'Prepare exact release artifact');
  expect(prepare?.run).toContain('release-artifact.py');
  expect(prepare?.run).toContain('GITHUB_OUTPUT');
  const upload = workflow.jobs.build.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  const download = workflow.jobs.deploy.steps.find((step) => step.uses?.startsWith('actions/download-artifact@'));
  expect(upload?.with?.path).toBe('release');
  expect(download?.with?.path).toBe('release');
  expect(download?.with?.name).toBe(upload?.with?.name);
  for (const step of [upload, download]) expect(step?.uses).toMatch(/@[0-9a-f]{40}\b/);
});

test('deployment runs on the odroid runner through the root activation wrapper only', () => {
  expect(workflow.jobs.deploy['runs-on']).toEqual(['self-hosted', 'odroid-hcb']);
  const activate = workflow.jobs.deploy.steps.find((step) => step.name === 'Activate verified prebuilt release');
  expect(activate?.run).toContain('sudo -n /usr/local/sbin/hypercal-activate-release "$PWD/release"');
  expect(activate?.run).toContain('"$ARCHIVE_SUM" "$CONFIG_ID"');
  const text = JSON.stringify(workflow.jobs.deploy);
  expect(text).not.toMatch(/secrets\.SSH_|appleboy\//);
});

test('hosted deployment never follows latest or changes unrelated shared services', () => {
  const text = JSON.stringify(workflow.jobs.deploy);
  expect(text).not.toContain(':latest');
  expect(text).not.toContain('docker image prune');
  expect(text).not.toContain('caddy reload');
  expect(text).toContain('Release still targets main');
});

// A self-hosted runner executes whatever a job gives it on the production box, so no
// workflow that a pull request can trigger may ever be scheduled onto it.
test('no pull-request-triggered workflow targets a self-hosted runner', () => {
  const triggerSchema = z.union([z.string(), z.array(z.string()), z.record(z.string(), z.unknown())]);
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
