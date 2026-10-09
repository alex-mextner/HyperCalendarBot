import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
// /proc/*/cmdline. The main-ref check must authenticate with the token without ever putting
// it on a command line, and must fail the deploy when main has moved.
describe('the "Release still targets main" step on the self-hosted runner', () => {
  const step = workflow.jobs.deploy.steps.find((candidate) => candidate.name === 'Release still targets main');
  const script = step?.run;
  const token = `ghs_synthetic${'0'.repeat(30)}`;
  const expected = 'a'.repeat(40);

  async function runCheck(mainSha: string) {
    if (!script) throw new Error('deploy.yml has no "Release still targets main" step');
    const seen: { authorization: string | null; path: string; tokenInArgv: string[] } = {
      authorization: null,
      path: '',
      tokenInArgv: [],
    };
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        seen.authorization = request.headers.get('authorization');
        seen.path = new URL(request.url).pathname;
        // While the step's request is in flight, look for the token in every process's argv.
        if (existsSync('/proc/self/cmdline')) {
          for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
            try {
              const argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
              if (argv.includes(token)) seen.tokenInArgv.push(argv.replaceAll('\0', ' '));
            } catch {
              // The process exited between listing and reading.
            }
          }
        }
        return Response.json({ object: { sha: mainSha } });
      },
    });
    try {
      const child = Bun.spawn(['bash', '-e', '-c', script], {
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          GH_TOKEN: token,
          EXPECTED_SHA: expected,
          GITHUB_API_URL: `http://127.0.0.1:${server.port}`,
          GITHUB_REPOSITORY: 'owner/repo',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await child.exited;
      return { exitCode, stderr: await new Response(child.stderr).text(), seen };
    } finally {
      server.stop(true);
    }
  }

  test('passes when main is the release commit, with the token only in a header', async () => {
    const { exitCode, stderr, seen } = await runCheck(expected);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
    expect(seen.path).toBe('/repos/owner/repo/git/ref/heads/main');
    expect(seen.authorization).toBe(`Bearer ${token}`);
    expect(seen.tokenInArgv).toEqual([]);
  });

  test('fails when main has moved on', async () => {
    const { exitCode, stderr } = await runCheck('b'.repeat(40));
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain(`main moved to ${'b'.repeat(40)}`);
  });
});
