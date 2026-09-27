// test/scripts/docker-compose-secrets.test.ts
//
// The production host is shared with other services, so anything in a process's
// argv is readable by every local user through `ps`. On 2026-09-27 the Redis
// password was found there twice: in the `redis-server --requirepass …` command
// line and in the healthcheck's `redis-cli -a …`, which runs every 10 seconds.
// The bot container also received REDIS_PASSWORD although it only uses REDIS_URL.
//
// These tests render the real docker-compose.yml with Docker Compose itself and a
// synthetic .env, then run the rendered redis command and healthcheck against
// stub binaries that record the argv they were given — what `ps` would show.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const COMPOSE_FILE = join(import.meta.dir, '../../docker-compose.yml');
const PASSWORD = 'Synth-redis-pw-4f2c9';
// Quote, backslash, dollar and space: characters a config-file or shell hand-off could mangle.
const TRICKY_PASSWORD = 'Synth"pw\\4f$HOME 9c';

type Service = {
  command?: string[];
  environment?: Record<string, string | null>;
  healthcheck?: { test?: string[] };
};

/** The real Docker Compose v2 CLI; the local `docker` wrapper renders compose files differently. */
function composeCli(): string[] | undefined {
  for (const cli of [['docker-compose'], ['docker', 'compose']]) {
    try {
      const probe = Bun.spawnSync([...cli, 'version'], { stdout: 'pipe', stderr: 'pipe' });
      if (probe.exitCode === 0 && probe.stdout.toString().includes('Docker Compose version')) return cli;
    } catch {
      // binary not installed
    }
  }
  return undefined;
}

const COMPOSE = composeCli();

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'compose-secrets-'));
  mkdirSync(join(work, 'bin'));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/** A clean environment: no REDIS_PASSWORD leaking in from the developer's shell or .env. */
function baseEnv(): Record<string, string> {
  return { PATH: `${join(work, 'bin')}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: work };
}

/** docker-compose.yml as Docker Compose resolves it for a host whose .env holds `password`. */
function render(password = PASSWORD): Record<string, Service> {
  if (!COMPOSE) throw new Error('Docker Compose v2 CLI is not installed');
  const project = join(work, 'project');
  mkdirSync(project);
  copyFileSync(COMPOSE_FILE, join(project, 'docker-compose.yml'));
  writeFileSync(join(project, '.env'), `REDIS_PASSWORD='${password}'\nBOT_TOKEN=synthetic-bot-token\n`);
  const proc = Bun.spawnSync([...COMPOSE, '--project-directory', project, 'config', '--format', 'json'], {
    cwd: project,
    env: baseEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) throw new Error(`compose config failed: ${proc.stderr.toString()}`);
  // `config` re-escapes `$` as `$$` so its output stays valid compose; containers get a single `$`.
  const parsed: { services: Record<string, Service> } = JSON.parse(proc.stdout.toString(), (_key, value) =>
    typeof value === 'string' ? value.replaceAll('$$', '$') : value,
  );
  return parsed.services;
}

function stub(name: string, body: string): void {
  writeFileSync(join(work, 'bin', name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

function containerEnv(service: Service): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(service.environment ?? {})) if (value !== null) env[key] = value;
  return env;
}

/**
 * Starts the redis service the way the image does (`docker-entrypoint.sh <command>`),
 * with an entrypoint stub that records the redis-server argv and the config it reads on stdin.
 */
function startRedis(redis: Service): { argv: string[]; stdin: string } {
  stub(
    'docker-entrypoint.sh',
    `if [ "$1" = redis-server ]; then printf '%s\\n' "$@" > "$ARGV_LOG"; cat > "$STDIN_LOG"; exit 0; fi
exec "$@"`,
  );
  const argvLog = join(work, 'redis-argv');
  const stdinLog = join(work, 'redis-stdin');
  writeFileSync(stdinLog, '');
  const proc = Bun.spawnSync([join(work, 'bin', 'docker-entrypoint.sh'), ...(redis.command ?? [])], {
    env: { ...baseEnv(), ...containerEnv(redis), ARGV_LOG: argvLog, STDIN_LOG: stdinLog },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect({ exitCode: proc.exitCode, stderr: proc.stderr.toString() }).toEqual({ exitCode: 0, stderr: '' });
  return { argv: readFileSync(argvLog, 'utf8').trimEnd().split('\n'), stdin: readFileSync(stdinLog, 'utf8') };
}

/** The requirepass value redis-server ends up with, from argv options or stdin config lines. */
function effectiveRequirepass(started: { argv: string[]; stdin: string }): string | undefined {
  const flag = started.argv.indexOf('--requirepass');
  if (flag !== -1) return started.argv[flag + 1];
  const line = started.stdin.split('\n').find((l) => l.startsWith('requirepass '));
  // redis.conf double-quoted strings use backslash escapes for `"` and `\`, as JSON does.
  return line === undefined ? undefined : JSON.parse(line.slice('requirepass '.length));
}

/**
 * Runs the rendered healthcheck with a redis-cli stub that behaves like redis-cli against a
 * server protected by `password` (PONG only when authenticated) and records its argv.
 */
function runHealthcheck(redis: Service, password: string): { exitCode: number; check: string[]; argv: string } {
  const check = redis.healthcheck?.test ?? [];
  expect(check[0]).toBe('CMD-SHELL');
  stub(
    'redis-cli',
    `printf '%s\\n' "$@" >> "$ARGV_LOG"
auth="$REDISCLI_AUTH"
while [ $# -gt 0 ]; do [ "$1" = -a ] && auth="$2"; shift; done
if [ "$auth" = "$EXPECTED_PASSWORD" ]; then echo PONG; else echo 'NOAUTH Authentication required.'; fi`,
  );
  const argvLog = join(work, 'cli-argv');
  writeFileSync(argvLog, '');
  const proc = Bun.spawnSync(['sh', '-c', check[1] ?? ''], {
    env: { ...baseEnv(), ...containerEnv(redis), ARGV_LOG: argvLog, EXPECTED_PASSWORD: password },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { exitCode: proc.exitCode, check, argv: readFileSync(argvLog, 'utf8') };
}

describe.skipIf(!COMPOSE)('docker-compose.yml keeps the Redis password out of argv and the bot env', () => {
  test('redis-server is started with the password but without it on its command line', () => {
    const redis = render().redis;
    expect(redis).toBeDefined();
    const started = startRedis(redis!);
    expect(effectiveRequirepass(started)).toBe(PASSWORD);
    expect(started.argv.filter((arg) => arg.includes(PASSWORD))).toEqual([]);
    expect((redis!.command ?? []).filter((arg) => arg.includes(PASSWORD))).toEqual([]);
  });

  test('the redis healthcheck authenticates without the password in redis-cli argv', () => {
    const { exitCode, check, argv } = runHealthcheck(render().redis!, PASSWORD);
    expect(exitCode).toBe(0);
    expect(check.filter((arg) => arg.includes(PASSWORD))).toEqual([]);
    expect(argv).not.toContain(PASSWORD);
  });

  test('a password with quotes, backslashes, dollars and spaces reaches redis-server and the healthcheck intact', () => {
    const redis = render(TRICKY_PASSWORD).redis!;
    expect(effectiveRequirepass(startRedis(redis))).toBe(TRICKY_PASSWORD);
    expect(runHealthcheck(redis, TRICKY_PASSWORD).exitCode).toBe(0);
  });

  test('the bot receives the password only inside REDIS_URL', () => {
    const bot = render().bot!;
    const env = containerEnv(bot);
    expect(env.REDIS_URL).toBe(`redis://:${PASSWORD}@redis:6379`);
    expect(env.REDIS_PASSWORD ?? '').toBe('');
    expect(Object.keys(env).filter((key) => env[key]?.includes(PASSWORD))).toEqual(['REDIS_URL']);
  });
});
