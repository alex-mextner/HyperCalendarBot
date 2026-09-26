import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const SCRIPT = join(ROOT, 'scripts/install-git-hooks.sh');
const USER_HOOK = '#!/bin/sh\n# the user-global hook dispatcher\n';

/**
 * A throwaway HOME whose global git config points core.hooksPath at a shared directory that
 * already holds a user hook. Nothing here can reach the real HOME or its global hooks.
 */
function sandbox(globalHooksPath = true) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hcb-hooks-')));
  const home = join(dir, 'home');
  const globalHooks = join(home, '.config/git/hooks');
  mkdirSync(globalHooks, { recursive: true });
  writeFileSync(join(globalHooks, 'pre-commit'), USER_HOOK, { mode: 0o755 });
  const core = globalHooksPath ? `[core]\n\thooksPath = ${globalHooks}\n` : '';
  writeFileSync(join(home, '.gitconfig'), `${core}[user]\n\tname = t\n\temail = t@example.invalid\n`);
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const env: Record<string, string | undefined> = {
    ...inherited,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    // lefthook's own postinstall is a no-op when CI is set; the hazard must be exercised here too.
    CI: '',
  };
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const globalHooksUntouched = () => {
    expect(readdirSync(globalHooks)).toEqual(['pre-commit']);
    expect(readFileSync(join(globalHooks, 'pre-commit'), 'utf8')).toBe(USER_HOOK);
  };
  return { dir, home, env, git, globalHooksUntouched };
}

/** Runs the guard with a stand-in lefthook that only records how it was called. */
function runGuard(box: ReturnType<typeof sandbox>, cwd: string) {
  const bin = join(box.dir, 'bin');
  const calls = join(box.dir, 'lefthook.calls');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'lefthook'), `#!/bin/sh\necho "$*" >> '${calls}'\n`, { mode: 0o755 });
  const result = spawnSync('sh', [SCRIPT], {
    cwd,
    env: { ...box.env, PATH: `${bin}:${box.env.PATH}` },
    encoding: 'utf8',
  });
  let recorded: string[] = [];
  try {
    recorded = readFileSync(calls, 'utf8').trim().split('\n');
  } catch {}
  return { status: result.status, stderr: result.stderr, calls: recorded };
}

describe('postinstall git hook guard', () => {
  test('a global core.hooksPath outside the repository is left alone', () => {
    const box = sandbox();
    try {
      const repo = join(box.dir, 'repo');
      mkdirSync(repo);
      box.git(repo, 'init', '-q');
      const run = runGuard(box, repo);
      expect(run.status).toBe(0);
      expect(run.calls).toEqual([]);
      expect(run.stderr).toContain('outside this repository');
      box.globalHooksUntouched();
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  test('a local core.hooksPath pointing outside the repository is left alone', () => {
    const box = sandbox(false);
    try {
      const repo = join(box.dir, 'repo');
      mkdirSync(repo);
      box.git(repo, 'init', '-q');
      box.git(repo, 'config', 'core.hooksPath', '../shared-hooks');
      expect(runGuard(box, repo).calls).toEqual([]);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  test("the repository's own hooks directory is installed, also from a linked worktree", () => {
    const box = sandbox();
    try {
      const repo = join(box.dir, 'repo');
      mkdirSync(repo);
      box.git(repo, 'init', '-q');
      box.git(repo, 'config', 'core.hooksPath', join(repo, '.git/hooks'));
      box.git(repo, 'commit', '-q', '--allow-empty', '--no-verify', '-m', 'base');
      box.git(repo, 'worktree', 'add', '-q', join(box.dir, 'linked'));
      expect(runGuard(box, repo).calls).toEqual(['install --force']);
      expect(runGuard(box, join(box.dir, 'linked')).calls).toEqual(['install --force', 'install --force']);
      box.globalHooksUntouched();
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  test('without any core.hooksPath the default .git/hooks is installed', () => {
    const box = sandbox(false);
    try {
      const repo = join(box.dir, 'repo');
      mkdirSync(repo);
      box.git(repo, 'init', '-q');
      expect(runGuard(box, repo).calls).toEqual(['install --force']);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  test('outside a git work tree nothing is installed', () => {
    const box = sandbox();
    try {
      const plain = join(box.dir, 'plain');
      mkdirSync(plain);
      const run = runGuard(box, plain);
      expect(run.status).toBe(0);
      expect(run.calls).toEqual([]);
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  });

  test('a real bun install of this manifest leaves a global core.hooksPath untouched', () => {
    // The 2026-09-26 incident: lefthook's own dependency postinstall runs `lefthook install -f`,
    // which writes into a global core.hooksPath. The repository's root postinstall must not either.
    const cache = spawnSync(process.execPath, ['pm', 'cache'], { encoding: 'utf8' }).stdout.trim();
    const box = sandbox();
    try {
      const repo = join(box.dir, 'repo');
      mkdirSync(join(repo, 'scripts'), { recursive: true });
      for (const file of ['package.json', 'bun.lock', 'lefthook.yml', 'scripts/install-git-hooks.sh']) {
        cpSync(join(ROOT, file), join(repo, file));
      }
      box.git(repo, 'init', '-q');
      const install = spawnSync(process.execPath, ['install', '--frozen-lockfile'], {
        cwd: repo,
        env: { ...box.env, BUN_INSTALL_CACHE_DIR: cache },
        encoding: 'utf8',
        timeout: 180_000,
      });
      expect({ status: install.status, stderr: install.status === 0 ? '' : install.stderr }).toEqual({
        status: 0,
        stderr: '',
      });
      box.globalHooksUntouched();
    } finally {
      rmSync(box.dir, { recursive: true, force: true });
    }
  }, 240_000);
});
