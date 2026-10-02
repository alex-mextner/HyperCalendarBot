import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const deployScript = join(ROOT, 'scripts/deploy-bot.sh');
const fallbackScript = join(ROOT, 'scripts/deploy-local-fallback.sh');
const wrapperScript = join(ROOT, '.claude/scripts/pr-ship.sh');
const workflow = readFileSync(join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
const backupScript = readFileSync(join(ROOT, 'scripts/backup-db.sh'), 'utf8');
const stageScript = readFileSync(join(ROOT, 'scripts/stage-release.sh'), 'utf8');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'hypercal-deploy-test-'));
  dirs.push(d);
  return d;
}
function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/bash\nset -euo pipefail\n${body}\n`);
  chmodSync(path, 0o755);
}
function run(script: string, env: Record<string, string>, args: string[] = []) {
  return spawnSync('/bin/bash', [script, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 12_000,
  });
}

function deployHarness(
  opts: {
    revision?: string;
    architecture?: string;
    health?: string;
    ready?: string;
    pullFail?: boolean;
    migrationFail?: boolean;
    restartCount?: number;
    startupLog?: string;
    noExisting?: boolean;
    smokeFail?: boolean;
    dbCheckFail?: boolean;
  } = {},
) {
  const dir = temp(),
    bin = join(dir, 'bin'),
    dep = join(dir, 'deploy');
  mkdirSync(bin);
  mkdirSync(join(dep, 'scripts'), { recursive: true });
  mkdirSync(join(dep, 'data/dictionaries'), { recursive: true });
  writeFileSync(join(dep, 'docker-compose.yml'), 'services:\n  bot:\n    image: $' + '{HYPERCAL_IMAGE:-repo:latest}\n');
  writeFileSync(join(dep, 'data/calendar.db'), 'original');
  writeFileSync(join(dep, 'data/dictionaries/stress-dict.json'), '{}');
  if (!opts.noExisting) writeFileSync(join(dep, '.current-image'), 'old-id');
  const log = join(dir, 'calls.log'),
    sha = 'a'.repeat(40),
    revision = opts.revision ?? sha;
  executable(
    join(dep, 'scripts/backup-db.sh'),
    `mkdir -p "$DEPLOY_DIR/data/backups"; cp "$DEPLOY_DIR/data/calendar.db" "$DEPLOY_DIR/data/backups/pre.db"; gzip -f "$DEPLOY_DIR/data/backups/pre.db"; echo "BACKUP_PATH=$DEPLOY_DIR/data/backups/pre.db.gz"`,
  );
  executable(
    join(bin, 'docker'),
    `echo "docker HYPERCAL_IMAGE=${'$'}{HYPERCAL_IMAGE:-} $*" >> "$FAKE_LOG"
case " $* " in
  *"pull repo:${sha}"*) [[ "${'$'}{FAKE_PULL_FAIL:-0}" == 1 ]] && exit 42;;
  *"inspect hypercal-bot --format {{.Image}}"*) [[ -f "$DEPLOY_DIR/.current-image" ]] && cat "$DEPLOY_DIR/.current-image" || exit 1;;
  *"inspect hypercal-bot --format {{.RestartCount}}"*) echo ${opts.restartCount ?? 0};;
  *"image inspect repo:${sha} --format {{ index .Config.Labels"*) echo ${revision};;
  *"image inspect repo:${sha} --format {{.Architecture}}"*) echo ${opts.architecture ?? 'amd64'};;
  *"image inspect repo:${sha} --format {{.Id}}"*) echo new-id;;
  *"image inspect repo:${sha}"*) exit 0;;
  *"run --rm --network none --entrypoint bun "*) [[ "${'$'}{FAKE_SMOKE_FAIL:-0}" == 1 ]] && exit 44 || exit 0;;
  *"run --rm --network none -v "*) echo partial-migration > "$DEPLOY_DIR/data/calendar.db"; if [[ "${'$'}{FAKE_MIGRATION_FAIL:-0}" == 1 ]]; then exit 43; fi; exit 0;;
  *"compose up"*) if [[ "${'$'}{HYPERCAL_IMAGE:-}" == "repo:${sha}" ]]; then echo new-id > "$DEPLOY_DIR/.current-image"; else echo old-id > "$DEPLOY_DIR/.current-image"; fi;;
  *"exec hypercal-bot bun"*) if [[ "${'$'}{FAKE_DB_CHECK_FAIL:-0}" == 1 ]]; then printf 'bad\\t1\\n'; exit 45; else printf 'ok\\t0\\n'; fi;;
  *"images repo --format"*) printf 'repo:rollback-20260102T000000Z\\nrepo:rollback-20260101T000000Z\\nrepo:rollback-20251231T000000Z\\nrepo:rollback-20251230T000000Z\\n';;
  *"logs --since"*) printf '%s\\n' ${JSON.stringify(opts.startupLog ?? '')};;
esac`,
  );
  executable(
    join(bin, 'curl'),
    `case "$*" in *health*) printf %s "${opts.health ?? 'ok'}";; *ready*) printf %s "${opts.ready ?? 'ok'}";; esac`,
  );
  executable(join(bin, 'seq'), `echo 1`);
  executable(join(bin, 'sleep'), `:`);
  executable(join(bin, 'caddy'), `:`);
  executable(join(bin, 'chown'), `:`);
  return {
    dir,
    bin,
    dep,
    log,
    sha,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      DEPLOY_DIR: dep,
      DEPLOY_SHA: sha,
      IMAGE_REPO: 'repo',
      DEPLOY_IMAGE_PRELOADED: '1',
      FAKE_LOG: log,
      FAKE_MIGRATION_FAIL: opts.migrationFail ? '1' : '0',
      FAKE_SMOKE_FAIL: opts.smokeFail ? '1' : '0',
      FAKE_DB_CHECK_FAIL: opts.dbCheckFail ? '1' : '0',
      HEALTH_URL: 'http://fake/health',
      READY_URL: 'http://fake/ready',
      DEPLOY_PROBE_COUNT: '1',
      DEPLOY_PROBE_DELAY: '0',
    },
  };
}

function localHarness(remoteSum = 'f'.repeat(64)) {
  const d = temp(),
    bin = join(d, 'bin'),
    repo = join(d, 'repo'),
    log = join(d, 'calls.log'),
    sha = 'c'.repeat(40),
    sum = 'f'.repeat(64);
  mkdirSync(bin);
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  writeFileSync(join(repo, 'docker-compose.yml'), 'services: {}\n');
  writeFileSync(join(repo, 'Caddyfile'), '{}\n');
  for (const n of [
    'deploy-bot.sh',
    'backup-db.sh',
    'healthcheck-alert.sh',
    'prepare-runtime-dirs.sh',
    'stage-release.sh',
  ])
    writeFileSync(join(repo, 'scripts', n), '#!/bin/bash\n');
  executable(
    join(bin, 'git'),
    `echo "git $*" >> "$FAKE_LOG"; case "$1 $2" in "rev-parse --show-toplevel") echo "$FAKE_REPO";; "rev-parse origin/main^{commit}") echo "$FAKE_SHA";; esac; if [[ "$1" == archive ]]; then tar -cf - -C "$FAKE_REPO" .; fi`,
  );
  executable(
    join(bin, 'docker'),
    `echo "docker $*" >> "$FAKE_LOG"; original="$*"; if [[ "${'$'}{1:-}" == --context ]]; then shift 2; fi; if [[ "${'$'}{1:-}" == image && "${'$'}{2:-}" == inspect ]]; then if [[ "$original" == *Architecture* ]]; then echo amd64; else echo "$FAKE_SHA"; fi; fi; if [[ "${'$'}{1:-}" == save ]]; then printf image-bytes; fi`,
  );
  executable(join(bin, 'scp'), `echo "scp $*" >> "$FAKE_LOG"`);
  executable(
    join(bin, 'ssh'),
    `body="$(cat)"; echo "ssh $*" >> "$FAKE_LOG"; [[ -n "$body" ]] && printf 'ssh-stdin %s\n' "$body" >> "$FAKE_LOG"; [[ "$*" == *sha256sum* ]] && echo "$FAKE_REMOTE_SUM remote" || true`,
  );
  executable(join(bin, 'shasum'), `echo "$FAKE_SUM  file"`);
  executable(join(bin, 'gzip'), `cat`);
  executable(join(bin, 'curl'), `printf ok`);
  const guard = join(d, 'ship.guard');
  writeFileSync(guard, `${sha}\n`, { mode: 0o600 });
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_LOG: log,
    FAKE_REPO: repo,
    FAKE_SHA: sha,
    FAKE_SUM: sum,
    FAKE_REMOTE_SUM: remoteSum,
    HYPERCAL_DOCKER_CONTEXT: 'colima',
    HYPERCAL_GH_SHIP_GUARD_FILE: guard,
    HYPERCAL_SHIP_MERGE_SHA: sha,
  };
  return { d, bin, repo, log, sha, sum, env };
}

function wrapperHarness(mode: 'success' | 'queued' | 'infra' | 'failure') {
  const d = temp(),
    bin = join(d, 'bin'),
    repo = join(d, 'repo'),
    cfg = join(d, 'config/agent-tools'),
    tools = join(d, 'tools/ci/ship'),
    log = join(d, 'calls.log'),
    sha = 'd'.repeat(40);
  mkdirSync(bin);
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  mkdirSync(cfg, { recursive: true });
  mkdirSync(tools, { recursive: true });
  writeFileSync(join(cfg, 'env'), `AGENT_TOOLS_ROOT=${join(d, 'tools')}\n`);
  executable(join(tools, 'ship.sh'), `echo "shared-ship $*" >> "$FAKE_LOG"`);
  executable(join(repo, 'scripts/deploy-local-fallback.sh'), `echo "fallback $*" >> "$FAKE_LOG"`);
  executable(join(bin, 'git'), `[[ "$1 $2" == "rev-parse --show-toplevel" ]] && echo "$FAKE_REPO"`);
  executable(join(bin, 'sleep'), `: `);
  const status = mode === 'success' ? 'completed' : mode === 'queued' ? 'in_progress' : 'completed',
    conclusion = mode === 'success' ? 'success' : mode === 'queued' ? '' : 'failure';
  const jobs =
    mode === 'failure'
      ? '{"jobs":[{"name":"test","startedAt":"2026-09-15T00:00:00Z","conclusion":"failure"}]}'
      : mode === 'queued'
        ? '{"jobs":[{"name":"test","startedAt":"2026-09-15T00:00:00Z","conclusion":null}]}'
        : mode === 'infra'
          ? '{"jobs":[]}'
          : '{"jobs":[{"name":"test","startedAt":"2026-09-15T00:00:00Z","conclusion":"success"},{"name":"build","startedAt":"2026-09-15T00:00:01Z","conclusion":"success"}]}';
  executable(
    join(bin, 'gh'),
    `echo "gh $*" >> "$FAKE_LOG"; if [[ "$1 $2" == "pr view" ]]; then echo "$FAKE_SHA"; elif [[ "$1 $2 $3" == "run list --workflow=CI/CD"* ]]; then echo 123; elif [[ "$1 $2" == "run view" && "$*" == *status,conclusion* ]]; then printf '%s\\t%s\\n' '${status}' '${conclusion}'; elif [[ "$1 $2" == "run view" && "$*" == *jobs* ]]; then echo '${jobs}'; elif [[ "$1 $2" == "run cancel" ]]; then exit 0; fi`,
  );
  return {
    log,
    sha,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_LOG: log,
      FAKE_REPO: repo,
      FAKE_SHA: sha,
      FAKE_MODE: mode,
      XDG_CONFIG_HOME: join(d, 'config'),
    },
  };
}

describe('remote deploy transaction', () => {
  test('rejects short SHA before Docker', () => {
    const h = deployHarness();
    const r = run(deployScript, { ...h.env, DEPLOY_SHA: 'abc' });
    expect(r.status).not.toBe(0);
    expect(existsSync(h.log)).toBe(false);
  });
  test('pull failure before stop leaves DB and old service untouched', () => {
    const h = deployHarness({ pullFail: true });
    const r = run(deployScript, { ...h.env, DEPLOY_IMAGE_PRELOADED: '0', FAKE_PULL_FAIL: '1' });
    expect(r.status).not.toBe(0);
    expect(readFileSync(join(h.dep, 'data/calendar.db'), 'utf8')).toBe('original');
    const calls = readFileSync(h.log, 'utf8');
    expect(calls).not.toContain('compose stop');
    expect(calls).not.toContain('compose up');
  });
  test('rejects wrong revision before touching running service', () => {
    const h = deployHarness({ revision: 'b'.repeat(40) });
    const r = run(deployScript, h.env);
    expect(r.status).not.toBe(0);
    expect(readFileSync(join(h.dep, 'data/calendar.db'), 'utf8')).toBe('original');
    expect(readFileSync(h.log, 'utf8')).not.toContain('compose up');
  });
  test('rejects wrong architecture before touching running service', () => {
    const h = deployHarness({ architecture: 'arm64' });
    const r = run(deployScript, h.env);
    expect(r.status).not.toBe(0);
    expect(readFileSync(join(h.dep, 'data/calendar.db'), 'utf8')).toBe('original');
    expect(readFileSync(h.log, 'utf8')).not.toContain('compose up');
  });
  test('existing DB without a running bot is refused before migration', () => {
    const h = deployHarness({ noExisting: true });
    const r = run(deployScript, h.env);
    expect(r.status).not.toBe(0);
    expect(readFileSync(join(h.dep, 'data/calendar.db'), 'utf8')).toBe('original');
    expect(readFileSync(h.log, 'utf8')).not.toContain('scripts/db-migrate.ts');
  });
  test('runtime smoke failure leaves running bot and DB untouched', () => {
    const h = deployHarness({ smokeFail: true });
    const r = run(deployScript, h.env);
    expect(r.status).not.toBe(0);
    expect(readFileSync(join(h.dep, 'data/calendar.db'), 'utf8')).toBe('original');
    expect(readFileSync(h.log, 'utf8')).not.toContain('compose stop');
  });
  test('database integrity failure restores DB and previous image', () => {
    const h = deployHarness({ dbCheckFail: true });
    const r = run(deployScript, h.env);
    expect(r.status).not.toBe(0);
    expect(readFileSync(join(h.dep, 'data/calendar.db'), 'utf8')).toBe('original');
    expect(readFileSync(h.log, 'utf8')).toContain('HYPERCAL_IMAGE=repo:rollback-');
  });
  test('migration failure after a partial write restores DB and previous image', () => {
    const h = deployHarness({ migrationFail: true });
    const r = run(deployScript, h.env);
    expect(r.status).not.toBe(0);
    expect(readFileSync(join(h.dep, 'data/calendar.db'), 'utf8')).toBe('original');
    expect(readFileSync(h.log, 'utf8')).toContain('HYPERCAL_IMAGE=repo:rollback-');
  });
  test('health failure restores DB and previous image', () => {
    const h = deployHarness({ health: 'down', ready: '' });
    const r = run(deployScript, h.env);
    expect(r.status).not.toBe(0);
    expect(readFileSync(join(h.dep, 'data/calendar.db'), 'utf8')).toBe('original');
    expect(readFileSync(h.log, 'utf8')).toContain('HYPERCAL_IMAGE=repo:rollback-');
  });
  test('restart during verification restores DB and previous image', () => {
    const h = deployHarness({ restartCount: 1 });
    const r = run(deployScript, h.env);
    expect(r.status).not.toBe(0);
    expect(readFileSync(join(h.dep, 'data/calendar.db'), 'utf8')).toBe('original');
    expect(readFileSync(h.log, 'utf8')).toContain('HYPERCAL_IMAGE=repo:rollback-');
  });
  test('fatal startup log restores DB and previous image', () => {
    const h = deployHarness({ startupLog: 'Unhandled promise rejection' });
    const r = run(deployScript, h.env);
    expect(r.status).not.toBe(0);
    expect(readFileSync(join(h.dep, 'data/calendar.db'), 'utf8')).toBe('original');
    expect(readFileSync(h.log, 'utf8')).toContain('HYPERCAL_IMAGE=repo:rollback-');
  });
  test('success records exact image and keeps max three rollback tags', () => {
    const h = deployHarness();
    const r = run(deployScript, h.env);
    expect(r.status).toBe(0);
    const calls = readFileSync(h.log, 'utf8');
    expect(calls).toContain(`HYPERCAL_IMAGE=repo:${h.sha}`);
    expect(r.stdout).toContain(`deployed_sha=${h.sha}`);
    expect((calls.match(/image rm repo:rollback-/g) ?? []).length).toBe(1);
    const receipt = JSON.parse(readFileSync(join(h.dep, 'releases', `${h.sha}.json`), 'utf8'));
    expect(receipt.restart_count).toBe(0);
  });
});

describe('local fallback', () => {
  test('refuses direct invocation without gh ship guard', () => {
    const h = localHarness();
    const { HYPERCAL_GH_SHIP_GUARD_FILE: _guard, HYPERCAL_SHIP_MERGE_SHA: _merge, ...env } = h.env;
    void _guard;
    void _merge;
    const r = run(fallbackScript, env, [h.sha]);
    expect(r.status).not.toBe(0);
    expect(existsSync(h.log)).toBe(false);
  });
  test('builds amd64 locally and remote never docker-builds or registry-pulls', () => {
    const h = localHarness();
    const r = run(fallbackScript, h.env, [h.sha]);
    expect(r.status).toBe(0);
    const calls = readFileSync(h.log, 'utf8');
    expect(calls).toContain(' build --platform linux/amd64');
    expect(calls).toContain(' save ghcr.io/alex-mextner/hypercalendarbot:');
    expect(calls).not.toContain('docker build');
    expect(calls).not.toContain('docker pull');
    expect(calls).not.toContain('docker login');
    expect(calls).toContain('docker load');
  });
  test('checksum mismatch refuses remote deploy', () => {
    const h = localHarness('e'.repeat(64));
    const r = run(fallbackScript, h.env, [h.sha]);
    expect(r.status).not.toBe(0);
    const calls = readFileSync(h.log, 'utf8');
    expect(calls).not.toContain('DEPLOY_IMAGE_PRELOADED=1');
  });
});

describe('CI and gh ship integration', () => {
  test('CI labels exact SHA, stages config transactionally, and logs out ephemeral auth', () => {
    expect(workflow).toContain('org.opencontainers.image.revision=$' + '{{ github.sha }}');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).toContain('image_digest: $' + '{{ steps.build-image.outputs.digest }}');
    expect(workflow).toContain('DEPLOY_IMAGE_DIGEST="$IMAGE_DIGEST"');
    expect(workflow).not.toContain('$' + '{{ env.REGISTRY }}/$' + '{{ env.IMAGE_NAME }}:latest');
    expect(workflow).toContain('DEPLOY_SHA="$' + '{{ github.sha }}"');
    expect(workflow).toContain('/releases/incoming-$' + '{{ github.sha }}');
    expect(stageScript).toContain('restore_config()');
    expect(stageScript).toContain('prepare-runtime-dirs.sh');
    expect(workflow).toContain('stage-release.sh');
    expect(workflow).toContain("trap 'docker logout ghcr.io");
  });
  test('backup script exposes machine-readable path', () => {
    expect(backupScript).toContain('BACKUP_PATH=');
  });
  for (const mode of ['success', 'queued'] as const)
    test(`wrapper leaves ${mode} Actions deployment alone`, () => {
      const h = wrapperHarness(mode);
      const r = run(wrapperScript, h.env, ['42']);
      expect(r.status).toBe(0);
      expect(readFileSync(h.log, 'utf8')).not.toContain('fallback ');
    });
  test('wrapper runs fallback when hosted CI infrastructure never ran test/build', () => {
    const h = wrapperHarness('infra');
    const r = run(wrapperScript, h.env, ['42']);
    expect(r.status).toBe(0);
    expect(readFileSync(h.log, 'utf8')).toContain(`fallback ${h.sha}`);
  });
  test('wrapper refuses real CI failure', () => {
    const h = wrapperHarness('failure');
    const r = run(wrapperScript, h.env, ['42']);
    expect(r.status).not.toBe(0);
    expect(readFileSync(h.log, 'utf8')).not.toContain('fallback ');
  });
  test('dry-run never deploys', () => {
    const h = wrapperHarness('infra');
    const r = run(wrapperScript, h.env, ['42', '--dry-run']);
    expect(r.status).toBe(0);
    expect(readFileSync(h.log, 'utf8')).toContain('shared-ship 42 --dry-run');
    expect(readFileSync(h.log, 'utf8')).not.toContain('fallback ');
  });
});
