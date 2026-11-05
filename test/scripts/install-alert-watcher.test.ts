// test/scripts/install-alert-watcher.test.ts
//
// The installer is what keeps the incident consumer alive on the owner's PC, so it has to be safe to
// run twice (the second run must not restart a healthy service) and must never put the alert secret
// where a process list, a unit file or a terminal could show it. systemctl, keychain, loginctl and ssh
// are stubs in a throwaway HOME: nothing here reaches the real user manager or keyring. bun is a stub
// too, except in the tests that check the watcher's build against the real binary.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '../../scripts/install-alert-watcher.sh');
/** keychain-cli lets a caller own only its own namespace, so the service is its own caller. */
const CALLER = 'hcb-alert-watcher';
const REF = `${CALLER}/admin-alert-token`;
/** Obviously fake; what matters is that it never appears in output, argv or the unit. */
const FETCHED = 'FAKE_FETCHED_VALUE';

let work: string;
let home: string;
let repo: string;

function stub(name: string, body: string): void {
  writeFileSync(join(work, 'bin', name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
}

function unitPath(): string {
  return join(home, '.config/systemd/user/hcb-alert-watcher.service');
}

function calls(file: string): string[] {
  const path = join(work, file);
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];
}

interface Outcome {
  exitCode: number;
  output: string;
}

async function install(args: string[] = [], env: Record<string, string> = {}): Promise<Outcome> {
  const proc = Bun.spawn(['bash', SCRIPT, ...args], {
    env: {
      PATH: `${join(work, 'bin')}:/usr/bin:/bin`,
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      HCB_REPO_DIR: repo,
      HCB_OMP_LAUNCHER: join(work, 'rig-detached-omp'),
      ...env,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, output: stdout + stderr };
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'hcb-install-watcher-'));
  home = join(work, 'home');
  repo = join(work, 'repo');
  mkdirSync(join(work, 'bin'));
  mkdirSync(home);
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  writeFileSync(join(repo, 'scripts/hcb-alert-watcher.ts'), '// stub\n');
  writeFileSync(join(work, 'rig-detached-omp'), '#!/bin/sh\n', { mode: 0o755 });
  stub('systemctl', `printf '%s\\n' "$*" >> "${work}/systemctl.log"`);
  stub('loginctl', 'echo "Linger=yes"');
  stub('bun', 'true');
  stub('tmux', 'true');
  stub('ctmux', 'true');
  stub('tg', 'true');
  // `keychain exists` answers from a marker file; `set` records its argv and stdin.
  stub(
    'keychain',
    `case "$1" in
  exists) [[ -e "${work}/secret-present" ]] ;;
  set) printf '%s\\n' "$*" >> "${work}/keychain-set.log"; cat > "${work}/keychain-set.stdin"; touch "${work}/secret-present" ;;
  *) exit 64 ;;
esac`,
  );
  stub(
    'ssh',
    `printf '%s\\n' "$*" >> "${work}/ssh.log"
if [[ -n "\${FAKE_SSH_FAIL:-}" ]]; then echo "ssh: connect to host timed out" >&2; exit 255; fi
printf "ADMIN_ALERT_TOKEN='%s'\\n" "\${FAKE_REMOTE_VALUE-${FETCHED}}"`,
  );
  chmodSync(join(work, 'bin'), 0o755);
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('install', () => {
  test('writes a user unit that injects the secret through keychain exec and starts the service', async () => {
    writeFileSync(join(work, 'secret-present'), '');
    const { exitCode, output } = await install();

    expect(exitCode).toBe(0);
    const unit = readFileSync(unitPath(), 'utf8');
    expect(unit).toMatch(
      new RegExp(
        `^ExecStart=${join(work, 'bin/keychain')} exec --no-redact --caller ${CALLER} --env ADMIN_ALERT_TOKEN=${REF} -- ${join(work, 'bin/bun')} ${join(repo, 'scripts/hcb-alert-watcher.ts')}$`,
        'm',
      ),
    );
    expect(unit).toContain(`Environment=HCB_REPO_DIR=${repo}`);
    expect(unit).toContain(`Environment=HCB_OMP_LAUNCHER=${join(work, 'rig-detached-omp')}`);
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('RestartPreventExitStatus=78');
    expect(unit).toContain('WantedBy=default.target');
    expect(statSync(unitPath()).mode & 0o777).toBe(0o644);
    expect(calls('systemctl.log')).toEqual(['--user daemon-reload', '--user enable --now hcb-alert-watcher.service']);
    expect(output).toContain('hcb-alert-watcher');
  });

  test("tools the omp session needs but that are missing from the unit's PATH are named in a warning", async () => {
    writeFileSync(join(work, 'secret-present'), '');
    mkdirSync(join(home, '.local/bin'), { recursive: true });
    writeFileSync(join(home, '.local/bin/omp'), '#!/bin/sh\n', { mode: 0o755 });
    const { exitCode, output } = await install();

    expect(exitCode).toBe(0);
    expect(output).not.toMatch(/omp not found on the unit's PATH/);
    expect(output).toMatch(/ctmux not found on the unit's PATH/);
  });

  test('--fetch-token-from strips a CRLF line ending and surrounding spaces from the copied value', async () => {
    const { exitCode } = await install(['--fetch-token-from', 'root@odroidn2'], {
      FAKE_REMOTE_VALUE: 'FAKE_FETCHED_VALUE\r',
    });
    expect(exitCode).toBe(0);
    expect(readFileSync(join(work, 'keychain-set.stdin'), 'utf8')).toBe('FAKE_FETCHED_VALUE');
  });

  test('--fetch-token-from refuses a value with an inline comment instead of storing a token the server would reject', async () => {
    const { exitCode, output } = await install(['--fetch-token-from', 'root@odroidn2'], {
      FAKE_REMOTE_VALUE: 'FAKE_FETCHED_VALUE # rotated',
    });
    expect(exitCode).not.toBe(0);
    expect(output).toMatch(/whitespace/);
    expect(existsSync(join(work, 'keychain-set.stdin'))).toBe(false);
  });

  test('tg is resolved at install time and pinned in the unit, so owner notices cannot silently fail on the unit PATH', async () => {
    writeFileSync(join(work, 'secret-present'), '');
    await install();
    expect(readFileSync(unitPath(), 'utf8')).toContain(`Environment=HCB_TG_BIN=${join(work, 'bin/tg')}`);
  });

  test('a PC without tg is warned about: the watcher would investigate but could never tell the owner it is blind', async () => {
    writeFileSync(join(work, 'secret-present'), '');
    rmSync(join(work, 'bin/tg'));
    const { exitCode, output } = await install();
    expect(exitCode).toBe(0);
    expect(output).toMatch(/warning: tg not found/);
    expect(readFileSync(unitPath(), 'utf8')).not.toContain('HCB_TG_BIN');
  });

  test('an HCB_BASE_URL given at install time is written into the unit; without one the unit carries none', async () => {
    writeFileSync(join(work, 'secret-present'), '');
    await install();
    expect(readFileSync(unitPath(), 'utf8')).not.toContain('HCB_BASE_URL');

    await install([], { HCB_BASE_URL: 'https://example.invalid' });
    expect(readFileSync(unitPath(), 'utf8')).toContain('Environment=HCB_BASE_URL=https://example.invalid');
    expect(calls('systemctl.log').at(-1)).toBe('--user restart hcb-alert-watcher.service');
  });

  test('a second run changes nothing and does not restart a healthy service', async () => {
    writeFileSync(join(work, 'secret-present'), '');
    await install();
    rmSync(join(work, 'systemctl.log'));
    const second = await install();

    expect(second.exitCode).toBe(0);
    expect(calls('systemctl.log').filter((c) => c.includes('restart') || c.includes('daemon-reload'))).toEqual([]);
    expect(second.output).toMatch(/unchanged/i);
  });

  test('a changed repository path rewrites the unit and restarts the service', async () => {
    writeFileSync(join(work, 'secret-present'), '');
    await install();
    const moved = join(work, 'repo2');
    mkdirSync(join(moved, 'scripts'), { recursive: true });
    writeFileSync(join(moved, 'scripts/hcb-alert-watcher.ts'), '// stub\n');
    rmSync(join(work, 'systemctl.log'));
    await install([], { HCB_REPO_DIR: moved });

    expect(readFileSync(unitPath(), 'utf8')).toContain(join(moved, 'scripts/hcb-alert-watcher.ts'));
    expect(calls('systemctl.log')).toEqual([
      '--user daemon-reload',
      '--user enable --now hcb-alert-watcher.service',
      '--user restart hcb-alert-watcher.service',
    ]);
  });

  test('without the secret in the keychain it stops before touching anything and says how to store it', async () => {
    const { exitCode, output } = await install();

    expect(exitCode).not.toBe(0);
    expect(output).toContain(`keychain set --caller ${CALLER} ${REF}`);
    expect(output).toContain('--fetch-token-from');
    expect(existsSync(unitPath())).toBe(false);
    expect(calls('systemctl.log')).toEqual([]);
  });

  test('--fetch-token-from copies the production token into the keychain without printing it', async () => {
    const { exitCode, output } = await install(['--fetch-token-from', 'root@odroidn2']);

    expect(exitCode).toBe(0);
    expect(output).not.toContain(FETCHED);
    expect(readFileSync(join(work, 'keychain-set.stdin'), 'utf8')).toBe(FETCHED);
    expect(calls('keychain-set.log').join('\n')).not.toContain(FETCHED);
    expect(calls('keychain-set.log')[0]).toContain(`--caller ${CALLER}`);
    expect(calls('keychain-set.log')[0]).toContain(REF);
    const ssh = calls('ssh.log').join('\n');
    expect(ssh).toContain('BatchMode=yes');
    expect(ssh).toContain('root@odroidn2');
    expect(ssh).not.toContain(FETCHED);
    expect(readFileSync(unitPath(), 'utf8')).not.toContain(FETCHED);
  });

  test('--fetch-token-from names an unreachable host instead of claiming the token is missing', async () => {
    const { exitCode, output } = await install(['--fetch-token-from', 'root@odroidn2'], { FAKE_SSH_FAIL: '1' });

    expect(exitCode).not.toBe(0);
    expect(output).toMatch(/ssh to root@odroidn2 failed/);
    expect(output).not.toMatch(/no ADMIN_ALERT_TOKEN/);
    expect(existsSync(join(work, 'keychain-set.stdin'))).toBe(false);
  });

  test('--fetch-token-from refuses an empty remote value instead of storing nothing', async () => {
    const { exitCode, output } = await install(['--fetch-token-from', 'root@odroidn2'], { FAKE_REMOTE_VALUE: '' });

    expect(exitCode).not.toBe(0);
    expect(output).toMatch(/no ADMIN_ALERT_TOKEN/i);
    expect(existsSync(join(work, 'keychain-set.stdin'))).toBe(false);
  });

  test('--fetch-token-from leaves an existing keychain entry alone', async () => {
    writeFileSync(join(work, 'secret-present'), '');
    const { exitCode } = await install(['--fetch-token-from', 'root@odroidn2']);

    expect(exitCode).toBe(0);
    expect(calls('ssh.log')).toEqual([]);
    expect(calls('keychain-set.log')).toEqual([]);
  });

  test('a missing omp launcher is reported before the unit is written', async () => {
    writeFileSync(join(work, 'secret-present'), '');
    const { exitCode, output } = await install([], { HCB_OMP_LAUNCHER: join(work, 'absent') });

    expect(exitCode).not.toBe(0);
    expect(output).toMatch(/rig-detached-omp/);
    expect(existsSync(unitPath())).toBe(false);
  });

  test('a checkout without the watcher script is reported, not installed', async () => {
    writeFileSync(join(work, 'secret-present'), '');
    rmSync(join(repo, 'scripts/hcb-alert-watcher.ts'));
    const { exitCode, output } = await install();

    expect(exitCode).not.toBe(0);
    expect(output).toContain('hcb-alert-watcher.ts');
    expect(existsSync(unitPath())).toBe(false);
  });

  /** The tests below build the watcher with the real Bun, which is what the installer's check runs. */
  function useRealBun(): void {
    rmSync(join(work, 'bin/bun'));
    symlinkSync(process.execPath, join(work, 'bin/bun'));
  }

  function writeWatcher(source: string): void {
    writeFileSync(join(repo, 'scripts/hcb-alert-watcher.ts'), source);
  }

  /** A refused install writes no unit and runs no systemctl command. */
  function expectNothingInstalled(): void {
    expect(existsSync(unitPath())).toBe(false);
    expect(calls('systemctl.log')).toEqual([]);
  }

  test('with the real bun, a watcher whose package is not installed is refused with the install command', async () => {
    writeFileSync(join(work, 'secret-present'), '');
    useRealBun();
    // A name that exists on no machine: a `zod` here would resolve whenever TMPDIR sits inside a checkout.
    writeWatcher(`export { z } from 'hcb-missing-package-${crypto.randomUUID()}';\n`);
    const { exitCode, output } = await install();

    expect(exitCode).not.toBe(0);
    expect(output).toMatch(/Could not resolve/);
    expect(output).toContain(`(cd ${repo} && bun install --frozen-lockfile)`);
    expectNothingInstalled();
  });

  test('with the real bun, a package whose installed version lacks an export is refused with the install command', async () => {
    writeFileSync(join(work, 'secret-present'), '');
    useRealBun();
    // What a merge that raises a dependency leaves behind: the package resolves, but the old copy lacks the name.
    mkdirSync(join(repo, 'node_modules/hcb-old-package'), { recursive: true });
    writeFileSync(
      join(repo, 'node_modules/hcb-old-package/package.json'),
      JSON.stringify({ name: 'hcb-old-package', version: '1.0.0', main: 'index.js', type: 'module' }),
    );
    writeFileSync(join(repo, 'node_modules/hcb-old-package/index.js'), 'export const oldName = 1;\n');
    writeWatcher("export { newName } from 'hcb-old-package';\n");
    const { exitCode, output } = await install();

    expect(exitCode).not.toBe(0);
    expect(output).toContain('No matching export');
    expect(output).toContain(`(cd ${repo} && bun install --frozen-lockfile)`);
    expectNothingInstalled();
  });

  test("with the real bun, a build failure that is not a missing package shows Bun's own error and does not blame the dependencies", async () => {
    writeFileSync(join(work, 'secret-present'), '');
    useRealBun();
    // What a bad merge leaves behind: `bun install` cannot fix it, so the operator must be sent to the real cause.
    writeWatcher('<<<<<<< HEAD\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> other\n');
    const { exitCode, output } = await install();

    expect(exitCode).not.toBe(0);
    expect(output).toMatch(/bun build of .*hcb-alert-watcher\.ts failed/);
    expect(output).toContain('Unexpected <<');
    expect(output).not.toMatch(/bun install/);
    expectNothingInstalled();
  });

  test('with the real bun, a missing local file is not blamed on the dependencies', async () => {
    writeFileSync(join(work, 'secret-present'), '');
    useRealBun();
    // A renamed module: Bun says `Could not resolve` for it too, but `bun install` cannot bring it back.
    writeWatcher("export { a } from './renamed-module';\n");
    const { exitCode, output } = await install();

    expect(exitCode).not.toBe(0);
    expect(output).toMatch(/bun build of .*hcb-alert-watcher\.ts failed/);
    expect(output).toContain('./renamed-module');
    expect(output).not.toMatch(/bun install/);
    expectNothingInstalled();
  });

  test('with the real bun, a local file that lacks an export is a code bug and gets no install hint', async () => {
    writeFileSync(join(work, 'secret-present'), '');
    useRealBun();
    // Only a file under node_modules is a stale install; the same Bun error for a file of the repo is not fixed by `bun install`.
    writeFileSync(join(repo, 'scripts/local.js'), 'export const present = 1;\n');
    writeWatcher("export { absent } from './local.js';\n");
    const { exitCode, output } = await install();

    expect(exitCode).not.toBe(0);
    expect(output).toContain('No matching export');
    expect(output).not.toMatch(/bun install/);
    expectNothingInstalled();
  });

  test('a build killed without any output still names its exit status', async () => {
    writeFileSync(join(work, 'secret-present'), '');
    stub('bun', 'exit 137');
    const { exitCode, output } = await install();

    expect(exitCode).toBe(1);
    expect(output).toMatch(/bun build of .*hcb-alert-watcher\.ts failed \(exit 137\)/);
    expectNothingInstalled();
  });

  test('a build log far longer than the pipe buffer still ends in a message with its first lines, not in silence', async () => {
    writeFileSync(join(work, 'secret-present'), '');
    // 3000 lines of 100 characters on stderr: over the 64 KiB a pipe holds, so a writer feeding `head` is cut off by SIGPIPE.
    stub('bun', `for i in $(seq 1 3000); do printf 'error: line %04d %090d\\n' "$i" 0 >&2; done\nexit 1`);
    const { exitCode, output } = await install();

    expect(exitCode).toBe(1);
    expect(output).toMatch(/bun build of .*hcb-alert-watcher\.ts failed/);
    expect(output).toContain('error: line 0001');
    // The message is an excerpt, not the 300 KB log.
    expect(output).not.toContain('error: line 3000');
    expect(output.length).toBeLessThan(5000);
    expectNothingInstalled();
  });

  test('--dry-run runs the same check and refuses a watcher that does not build, changing nothing', async () => {
    writeFileSync(join(work, 'secret-present'), '');
    useRealBun();
    writeWatcher('<<<<<<< HEAD\n');
    const { exitCode, output } = await install(['--dry-run']);

    expect(exitCode).not.toBe(0);
    expect(output).toMatch(/bun build of .*hcb-alert-watcher\.ts failed/);
    expectNothingInstalled();
  });

  test('--uninstall still removes a unit when the watcher no longer builds', async () => {
    writeFileSync(join(work, 'secret-present'), '');
    await install();
    rmSync(join(work, 'systemctl.log'));
    useRealBun();
    writeWatcher('<<<<<<< HEAD\n');
    const { exitCode } = await install(['--uninstall']);

    expect(exitCode).toBe(0);
    expect(existsSync(unitPath())).toBe(false);
    expect(calls('systemctl.log')).toEqual(['--user disable --now hcb-alert-watcher.service', '--user daemon-reload']);
  });

  test('with the real bun, the real watcher of this checkout resolves and installs', async () => {
    writeFileSync(join(work, 'secret-present'), '');
    useRealBun();
    const { exitCode, output } = await install([], { HCB_REPO_DIR: join(import.meta.dir, '../..') });

    expect(output).not.toMatch(/bun build of .* failed/);
    expect(exitCode).toBe(0);
    expect(existsSync(unitPath())).toBe(true);
  });

  test('--dry-run prints the plan and touches nothing', async () => {
    writeFileSync(join(work, 'secret-present'), '');
    const { exitCode, output } = await install(['--dry-run']);

    expect(exitCode).toBe(0);
    expect(output).toContain('ExecStart=');
    expect(existsSync(unitPath())).toBe(false);
    expect(calls('systemctl.log')).toEqual([]);
  });

  test('a PC without linger is warned about, because the service would stop at logout', async () => {
    writeFileSync(join(work, 'secret-present'), '');
    stub('loginctl', 'echo "Linger=no"');
    const { exitCode, output } = await install();

    expect(exitCode).toBe(0);
    expect(output).toMatch(/enable-linger/);
  });
});

describe('uninstall', () => {
  test('stops and removes the unit, keeps the state and the keychain entry, and is repeatable', async () => {
    writeFileSync(join(work, 'secret-present'), '');
    await install();
    rmSync(join(work, 'systemctl.log'));
    const first = await install(['--uninstall']);

    expect(first.exitCode).toBe(0);
    expect(existsSync(unitPath())).toBe(false);
    expect(calls('systemctl.log')).toEqual(['--user disable --now hcb-alert-watcher.service', '--user daemon-reload']);
    expect(existsSync(join(work, 'secret-present'))).toBe(true);

    const second = await install(['--uninstall']);
    expect(second.exitCode).toBe(0);
    expect(second.output).toMatch(/not installed/i);
  });
});
