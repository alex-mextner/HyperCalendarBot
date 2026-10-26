// Contract of the per-PR stage QA check (#840): PR code is built on a GitHub-hosted runner and only a
// workflow_run workflow from the default branch reaches the odroid, carrying a SHA and never code.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';

const ROOT = resolve(import.meta.dir, '../..');
const WORKFLOWS = resolve(ROOT, '.github/workflows');
const REPO = 'alex-mextner/HyperCalendarBot';
const SHA = 'a'.repeat(40);

const step = z
  .object({
    id: z.string().optional(),
    name: z.string().optional(),
    uses: z.string().optional(),
    run: z.string().optional(),
    if: z.string().optional(),
    env: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    with: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
const job = z
  .object({
    name: z.string().optional(),
    if: z.string().optional(),
    needs: z.union([z.string(), z.array(z.string())]).optional(),
    'runs-on': z.union([z.string(), z.array(z.string())]),
    permissions: z.record(z.string(), z.string()).optional(),
    'timeout-minutes': z.number().optional(),
    outputs: z.record(z.string(), z.string()).optional(),
    steps: z.array(step),
  })
  .passthrough();
const workflowSchema = z
  .object({
    name: z.string(),
    on: z.record(z.string(), z.unknown()),
    concurrency: z.object({ group: z.string(), 'cancel-in-progress': z.boolean() }).optional(),
    permissions: z.record(z.string(), z.string()).optional(),
    jobs: z.record(z.string(), job),
  })
  .passthrough();

function load(file: string) {
  return workflowSchema.parse(Bun.YAML.parse(readFileSync(resolve(WORKFLOWS, file), 'utf8')));
}

function getJob(file: string, id: string) {
  const found = load(file).jobs[id];
  if (!found) throw new Error(`${file} has no job ${id}`);
  return found;
}

function getStep(file: string, id: string, name: string) {
  const found = getJob(file, id).steps.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`${file} job ${id} has no step "${name}"`);
  return found;
}

describe('Stage build: the pull request image is built on GitHub, never on the odroid', () => {
  const build = load('stage-build.yml');
  const buildJob = getJob('stage-build.yml', 'build');

  test('is triggered only by pull_request, not by pull_request_target or push', () => {
    expect(Object.keys(build.on)).toEqual(['pull_request']);
    const types = z.object({ types: z.array(z.string()) }).parse(build.on.pull_request).types;
    expect(types).toEqual(expect.arrayContaining(['opened', 'synchronize', 'reopened', 'ready_for_review']));
  });

  test('runs on the GitHub-hosted arm64 runner only', () => {
    expect(buildJob['runs-on']).toBe('ubuntu-24.04-arm');
    const labels = JSON.stringify(build);
    expect(labels).not.toContain('self-hosted');
    expect(labels).not.toContain('odroid');
  });

  test('skips forks, drafts and bot-authored pull requests', () => {
    expect(buildJob.if).toContain('github.event.pull_request.head.repo.full_name == github.repository');
    expect(buildJob.if).toContain('github.event.pull_request.draft == false');
    expect(buildJob.if).toContain("github.event.pull_request.user.type != 'Bot'");
    expect(buildJob.if).toContain("github.event.sender.type != 'Bot'");
  });

  test('has read access plus the stage-qa status write, and no package or secret access', () => {
    expect(buildJob.permissions).toEqual({ contents: 'read', statuses: 'write' });
    expect(build.permissions).toEqual({ contents: 'read' });
    const text = JSON.stringify(build);
    expect([...text.matchAll(/\bsecrets\.([A-Za-z_]+)/g)].map((match) => match[1])).toEqual(['GITHUB_TOKEN']);
  });

  test('builds the exact PR head, pushes nothing and logs in to no registry', () => {
    const checkout = buildJob.steps.find((candidate) => candidate.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.ref).toBe('${{ github.event.pull_request.head.sha }}');
    expect(checkout?.with?.['persist-credentials']).toBe(false);
    const docker = buildJob.steps.find((candidate) => candidate.uses?.startsWith('docker/build-push-action@'));
    expect(docker?.with?.push).toBe(false);
    expect(docker?.with?.load).toBe(true);
    expect(docker?.with?.platforms).toBe('linux/arm64');
    expect(String(docker?.with?.tags).trim()).toBe('hypercalendarbot-stage:${{ github.event.pull_request.head.sha }}');
    expect(String(docker?.with?.labels)).toContain(
      'org.opencontainers.image.revision=${{ github.event.pull_request.head.sha }}',
    );
    expect(buildJob.steps.some((candidate) => candidate.uses?.startsWith('docker/login-action@'))).toBe(false);
    expect(JSON.stringify(build)).not.toContain('ghcr.io/');
  });

  test('uploads one artifact named for the head SHA holding the image and the case list', () => {
    const prepare = buildJob.steps.find((candidate) => candidate.name === 'Prepare the stage artifact');
    expect(prepare?.run).toContain('docker save');
    expect(prepare?.run).toContain('release-artifact.py');
    expect(prepare?.run).toContain('scripts/stage-smoke-cases.json');
    expect(prepare?.run).toContain('scripts/stage-smoke-cases.replay.json');
    const upload = buildJob.steps.find((candidate) => candidate.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.uses).toMatch(/@[0-9a-f]{40}\b/);
    expect(upload?.with?.name).toBe('stage-${{ github.event.pull_request.head.sha }}');
    expect(upload?.with?.['if-no-files-found']).toBe('error');
    expect(upload?.with?.overwrite).toBe(true);
  });

  test('serializes per pull request and drops a superseded build', () => {
    expect(build.concurrency).toEqual({
      group: 'stage-build-${{ github.event.pull_request.number }}',
      'cancel-in-progress': true,
    });
  });

  test('marks stage-qa pending before it builds, and puts no expression inside a run script', () => {
    const names = buildJob.steps.map((candidate) => candidate.name);
    expect(names.indexOf('Mark stage-qa pending')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('Mark stage-qa pending')).toBeLessThan(
      buildJob.steps.findIndex((candidate) => candidate.uses?.startsWith('docker/build-push-action@')),
    );
    for (const candidate of buildJob.steps) expect(candidate.run ?? '').not.toContain('${{');
  });
});

describe('Stage QA: the trusted workflow_run workflow is the only way onto the self-hosted QA runner', () => {
  const qaWorkflow = load('stage-qa.yml');
  const qa = getJob('stage-qa.yml', 'qa');
  const report = getJob('stage-qa.yml', 'report');

  test('is triggered only by the completion of Stage build', () => {
    expect(Object.keys(qaWorkflow.on)).toEqual(['workflow_run']);
    expect(qaWorkflow.on.workflow_run).toEqual({ workflows: [load('stage-build.yml').name], types: ['completed'] });
    expect(qaWorkflow.permissions).toEqual({});
  });

  // The qa-cli Telegram Web session lives on the owner's PC, so the qa job runs on a runner there. It is its own
  // label: the production deploy runner (odroid-hcb) must never receive a stage job or the reverse.
  test('qa runs on the PC runner label, never on the deploy runner label', () => {
    expect(qa['runs-on']).toEqual(['self-hosted', 'qa-pc']);
    expect(JSON.stringify(qaWorkflow)).not.toContain('odroid-hcb');
    expect(JSON.stringify(load('deploy.yml').jobs.deploy?.['runs-on'])).not.toContain('qa-pc');
  });

  test('qa only starts for a successful, same-repository pull_request run of Stage build', () => {
    for (const needle of [
      "github.event.workflow_run.conclusion == 'success'",
      "github.event.workflow_run.event == 'pull_request'",
      'github.event.workflow_run.head_repository.full_name == github.repository',
      "github.event.workflow_run.path == '.github/workflows/stage-build.yml'",
    ]) {
      expect(qa.if).toContain(needle);
    }
  });

  test('qa has read-only permissions and sees no secret but GITHUB_TOKEN', () => {
    expect(qa.permissions).toEqual({ actions: 'read', contents: 'read', 'pull-requests': 'read', statuses: 'read' });
    const secrets = [...JSON.stringify(qa).matchAll(/\bsecrets\.([A-Za-z_]+)/g)].map((match) => match[1]);
    expect(new Set(secrets)).toEqual(new Set(['GITHUB_TOKEN']));
  });

  test('no job of the workflow fetches code or artifacts, and no run script holds an expression', () => {
    const text = JSON.stringify(qaWorkflow);
    for (const forbidden of ['actions/checkout', 'download-artifact', 'upload-artifact', 'git clone', 'git fetch']) {
      expect(text).not.toContain(forbidden);
    }
    for (const entry of [...qa.steps, ...report.steps]) expect(entry.run ?? '').not.toContain('${{');
  });

  test('qa hands the installed PC driver the head SHA as its only argument and the token on stdin', () => {
    const run = getStep('stage-qa.yml', 'qa', 'Run the stage QA through qa-cli');
    expect(run.env?.HEAD_SHA).toBe('${{ github.event.workflow_run.head_sha }}');
    expect(run.run).toContain('printf \'%s\\n\' "$GH_TOKEN" | "$HOME/.local/bin/hypercal-stage-qa-pc" "$HEAD_SHA"');
    expect(run.run).not.toContain('sudo');
    expect(qa.name).toBe('Stage QA run');
    expect(qa.outputs).toEqual({
      rc: '${{ steps.run.outputs.rc }}',
      cases: '${{ steps.run.outputs.cases }}',
    });
    expect(run.id).toBe('run');
  });

  test('qa waits behind other stage runs and the other repository, so its limit is generous but bounded', () => {
    // PC lock 45 min + the wrapper's stage and host lock waits and health (up to 2 h) + smoke 25 min + teardown 10 min:
    // a shorter job limit would cancel a legitimate queued run and leave stage-qa pending.
    expect(qa['timeout-minutes']).toBeGreaterThanOrEqual(200);
    expect(qa['timeout-minutes']).toBeLessThanOrEqual(240);
    expect(qaWorkflow.concurrency).toEqual({
      group: 'stage-qa-${{ github.event.workflow_run.head_branch }}',
      'cancel-in-progress': true,
    });
  });

  test('report runs on a hosted runner, after qa even when it fails, and is the only job that writes statuses', () => {
    expect(report['runs-on']).toBe('ubuntu-latest');
    expect(report.needs).toBe('qa');
    expect(report.if).toContain('always()');
    expect(report.if).toContain("github.event.workflow_run.event == 'pull_request'");
    expect(report.if).toContain('github.event.workflow_run.head_repository.full_name == github.repository');
    // A same-repo PR can add a workflow named "Stage build" that triggers this one: only the real file counts.
    expect(report.if).toContain("github.event.workflow_run.path == '.github/workflows/stage-build.yml'");
    expect(report.permissions).toEqual({ statuses: 'write' });
  });
});

describe('the self-hosted stage job is the only extra self-hosted job and no workflow_run job fetches code there', () => {
  test('every workflow_run workflow keeps checkout and artifact actions off self-hosted jobs', () => {
    for (const file of readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name))) {
      const parsed = z
        .object({
          on: z.union([z.string(), z.array(z.string()), z.record(z.string(), z.unknown())]),
          jobs: z.record(
            z.string(),
            z.object({ 'runs-on': z.unknown(), steps: z.array(step).optional() }).passthrough(),
          ),
        })
        .passthrough()
        .parse(Bun.YAML.parse(readFileSync(resolve(WORKFLOWS, file), 'utf8')));
      const triggers =
        typeof parsed.on === 'string' ? [parsed.on] : Array.isArray(parsed.on) ? parsed.on : Object.keys(parsed.on);
      if (!triggers.includes('workflow_run')) continue;
      for (const [id, entry] of Object.entries(parsed.jobs)) {
        const labels = [entry['runs-on']].flat().map(String);
        if (!labels.some((label) => label === 'self-hosted' || label.startsWith('odroid'))) continue;
        const uses = (entry.steps ?? []).map((candidate) => candidate.uses ?? '');
        expect({
          file,
          id,
          fetches: uses.filter((use) => /checkout|download-artifact|upload-artifact/.test(use)),
        }).toEqual({
          file,
          id,
          fetches: [],
        });
      }
    }
  });
});

describe('the qa step: runs the PC driver and reports its exit code and case count', () => {
  const run = getStep('stage-qa.yml', 'qa', 'Run the stage QA through qa-cli');

  async function runQa(wrapperExit: number, wrapperOutput: string) {
    const script = run.run;
    if (!script) throw new Error('the qa step has no script');
    const work = mkdtempSync(join(tmpdir(), 'hcb-stage-qa-'));
    try {
      const outputFile = join(work, 'github-output');
      const seen = join(work, 'driver.json');
      writeFileSync(outputFile, '');
      // A fake driver at the installed path: records its argv and stdin, prints its output, exits like it.
      mkdirSync(join(work, '.local/bin'), { recursive: true });
      writeFileSync(
        join(work, '.local/bin/hypercal-stage-qa-pc'),
        `#!/usr/bin/env python3\nimport json, sys\ndata = sys.stdin.read()\njson.dump({"argv": sys.argv[1:], "stdin": data}, open(${JSON.stringify(seen)}, "w"))\nprint(${JSON.stringify(wrapperOutput)})\nsys.exit(${wrapperExit})\n`,
        { mode: 0o755 },
      );
      const child = Bun.spawn(['bash', '-e', '-c', script], {
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: work,
          GH_TOKEN: 'FAKE-TOKEN-0123456789',
          HEAD_SHA: SHA,
          RUNNER_TEMP: work,
          GITHUB_OUTPUT: outputFile,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await child.exited;
      const outputs = Object.fromEntries(
        readFileSync(outputFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => line.split('=', 2) as [string, string]),
      );
      const called = existsSync(seen)
        ? z.object({ argv: z.array(z.string()), stdin: z.string() }).parse(JSON.parse(readFileSync(seen, 'utf8')))
        : null;
      return { exitCode, outputs, called };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  test('passes only the SHA in argv and the token on stdin, and publishes rc and the case count', async () => {
    const result = await runQa(0, `noise\nSTAGE_QA_RESULT status=passed sha=${SHA} cases=6 failed=0`);
    expect(result.exitCode).toBe(0);
    expect(result.outputs).toEqual({ rc: '0', cases: '6' });
    expect(result.called).toEqual({
      argv: [SHA],
      stdin: 'FAKE-TOKEN-0123456789\n',
    });
  });

  test('a failed smoke fails the job and publishes its exit code', async () => {
    const result = await runQa(1, `STAGE_QA_RESULT status=failed sha=${SHA} cases=6 failed=2`);
    expect(result.exitCode).toBe(1);
    expect(result.outputs).toEqual({ rc: '1', cases: '6' });
  });

  test('a wrapper that printed no result line is reported as rc 70, never as a pass or a plain failure', async () => {
    const result = await runQa(1, 'hypercal-stage-qa-pc: command not found');
    expect(result.exitCode).toBe(70);
    expect(result.outputs.rc).toBe('70');
    expect(result.outputs.cases).toBe('0');
  });

  test('a zero exit without a result line is not a pass either', async () => {
    const result = await runQa(0, 'all good, trust me');
    expect(result.exitCode).toBe(70);
  });
});

describe('the report step: stage-qa status for the exact head, truthful in every outcome', () => {
  const reportStep = getStep('stage-qa.yml', 'report', 'Post the stage-qa status');

  async function runReport(env: Record<string, string>) {
    const script = reportStep.run;
    if (!script) throw new Error('the report step has no script');
    const work = mkdtempSync(join(tmpdir(), 'hcb-stage-report-'));
    try {
      const record = join(work, 'gh.jsonl');
      writeFileSync(
        join(work, 'gh'),
        `#!/usr/bin/env python3\nimport json, sys\nopen(${JSON.stringify(record)}, "a").write(json.dumps(sys.argv[1:]) + "\\n")\n`,
        { mode: 0o755 },
      );
      const child = Bun.spawn(['bash', '-e', '-c', script], {
        env: {
          PATH: `${work}:${process.env.PATH ?? '/usr/bin:/bin'}`,
          GH_TOKEN: 'FAKE-TOKEN',
          REPO,
          HEAD_SHA: SHA,
          RUN_URL: `https://github.com/${REPO}/actions/runs/777`,
          RUN_ID: '777',
          BUILD_CONCLUSION: 'success',
          BUILD_RUN_ID: '555',
          BUILD_RUN_URL: `https://github.com/${REPO}/actions/runs/555`,
          QA_RESULT: 'success',
          QA_RC: '0',
          QA_CASES: '6',
          ...env,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await child.exited;
      const posts = existsSync(record)
        ? readFileSync(record, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => z.array(z.string()).parse(JSON.parse(line)))
        : [];
      return { exitCode, posts };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  const field = (argv: string[], key: string) => argv.find((part) => part.startsWith(`${key}=`))?.slice(key.length + 1);

  test('a passed run posts success with the case count and this run as the target', async () => {
    const { exitCode, posts } = await runReport({});
    expect(exitCode).toBe(0);
    expect(posts).toHaveLength(1);
    const post = posts[0] ?? [];
    expect(post.slice(0, 4)).toEqual(['api', '--method', 'POST', `repos/${REPO}/statuses/${SHA}`]);
    expect(field(post, 'state')).toBe('success');
    expect(field(post, 'context')).toBe('stage-qa');
    expect(field(post, 'description')).toBe('passed cases=6 run=777');
    expect(field(post, 'target_url')).toBe(`https://github.com/${REPO}/actions/runs/777`);
  });

  test('a failed smoke posts failure', async () => {
    const { posts } = await runReport({ QA_RESULT: 'failure', QA_RC: '1' });
    expect(posts.map((post) => [field(post, 'state'), field(post, 'description')])).toEqual([
      ['failure', 'failed run=777'],
    ]);
  });

  test('a build that failed posts failure pointing at the build run', async () => {
    const { posts } = await runReport({ BUILD_CONCLUSION: 'failure', QA_RESULT: 'skipped', QA_RC: '', QA_CASES: '' });
    expect(posts.map((post) => [field(post, 'state'), field(post, 'description'), field(post, 'target_url')])).toEqual([
      ['failure', 'stage build failed run=555', `https://github.com/${REPO}/actions/runs/555`],
    ]);
  });

  test('runs that could not execute the QA post error, not a pass and not a failure of the PR', async () => {
    for (const [rc, reason] of [
      ['2', 'refused'],
      ['3', 'not provisioned'],
      ['70', 'no result from the wrapper'],
      ['75', 'lock wait timed out'],
    ] as const) {
      const { posts } = await runReport({ QA_RESULT: 'failure', QA_RC: rc, QA_CASES: '0' });
      expect(posts.map((post) => [field(post, 'state'), field(post, 'description')])).toEqual([
        ['error', `could not run: ${reason} run=777`],
      ]);
    }
  });

  test('a passed exit without a positive case count is an error, never a success', async () => {
    for (const cases of ['0', '', 'x']) {
      const { posts } = await runReport({ QA_CASES: cases });
      expect(posts.map((post) => field(post, 'state'))).toEqual(['error']);
    }
  });

  test('superseded, cancelled and skipped runs post nothing', async () => {
    for (const env of [
      { QA_RESULT: 'failure', QA_RC: '76' },
      { QA_RESULT: 'cancelled', QA_RC: '' },
      { QA_RESULT: 'skipped', QA_RC: '' },
      { BUILD_CONCLUSION: 'cancelled', QA_RESULT: 'skipped', QA_RC: '' },
    ]) {
      const { exitCode, posts } = await runReport(env);
      expect({ env, exitCode, posts }).toEqual({ env, exitCode: 0, posts: [] });
    }
  });

  test('a malformed head SHA is refused before anything is posted', async () => {
    const { exitCode, posts } = await runReport({ HEAD_SHA: 'main; echo pwned' });
    expect(exitCode).not.toBe(0);
    expect(posts).toEqual([]);
  });
});

describe('the pending status posted when the build starts', () => {
  const pending = getStep('stage-build.yml', 'build', 'Mark stage-qa pending');

  // A fake gh: records every call; answers the default-branch lookup of stage-qa.yml like the API does.
  async function runPending(lookup: 'exists' | 'missing' | 'broken') {
    const script = pending.run;
    if (!script) throw new Error('no script');
    const work = mkdtempSync(join(tmpdir(), 'hcb-stage-pending-'));
    try {
      const record = join(work, 'gh.jsonl');
      writeFileSync(
        join(work, 'gh'),
        [
          '#!/usr/bin/env python3',
          'import json, os, sys',
          `open(${JSON.stringify(record)}, "a").write(json.dumps(sys.argv[1:]) + "\\n")`,
          'if "--method" not in sys.argv:',
          '    lookup = os.environ["FAKE_LOOKUP"]',
          '    if lookup == "missing":',
          '        sys.stderr.write("gh: Not Found (HTTP 404)\\n"); sys.exit(1)',
          '    if lookup == "broken":',
          '        sys.stderr.write("gh: Bad Gateway (HTTP 502)\\n"); sys.exit(1)',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      const child = Bun.spawn(['bash', '-e', '-c', script], {
        env: {
          PATH: `${work}:${process.env.PATH ?? '/usr/bin:/bin'}`,
          FAKE_LOOKUP: lookup,
          GH_TOKEN: 'FAKE-TOKEN',
          REPO,
          HEAD_SHA: SHA,
          RUN_URL: `https://github.com/${REPO}/actions/runs/555`,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await child.exited;
      const calls = existsSync(record)
        ? readFileSync(record, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => z.array(z.string()).parse(JSON.parse(line)))
        : [];
      return { exitCode, calls };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  test('posts a pending stage-qa status on the head SHA that links the build run', async () => {
    const { exitCode, calls } = await runPending('exists');
    expect(exitCode).toBe(0);
    const post = calls.find((argv) => argv.includes('--method'));
    expect(post?.slice(0, 4)).toEqual(['api', '--method', 'POST', `repos/${REPO}/statuses/${SHA}`]);
    expect(post).toEqual(
      expect.arrayContaining([
        'state=pending',
        'context=stage-qa',
        'description=stage build started',
        `target_url=https://github.com/${REPO}/actions/runs/555`,
      ]),
    );
  });

  // The pull request that introduces Stage QA has no trusted stage-qa.yml on the default branch to resolve
  // a pending status, and the ship's CI gate would wait on it forever.
  test('posts nothing while stage-qa.yml does not exist on the default branch yet', async () => {
    const { exitCode, calls } = await runPending('missing');
    expect(exitCode).toBe(0);
    expect(calls.some((argv) => argv.includes('--method'))).toBe(false);
    expect(calls[0]?.[1]).toBe(`repos/${REPO}/contents/.github/workflows/stage-qa.yml`);
  });

  test('an unreadable default branch fails the build instead of guessing', async () => {
    const { exitCode, calls } = await runPending('broken');
    expect(exitCode).not.toBe(0);
    expect(calls.some((argv) => argv.includes('--method'))).toBe(false);
  });
});
