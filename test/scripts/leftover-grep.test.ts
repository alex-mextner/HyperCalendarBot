// test/scripts/leftover-grep.test.ts
//
// The gate decides what cannot merge, so an exclusion added to it has to be
// exactly as wide as intended: console output allowed under scripts/, every
// other rule still blocking there, and nothing loosened outside it.
//
// These tests run the real gate against a throwaway git repository, so the
// assertions are about its verdict, not about how it is written.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '../../ci/leftover-grep/leftover-grep.sh');

/**
 * The fixtures are assembled from pieces rather than written out, because this
 * file feeds the gate the very markers the gate hunts for. Spelled literally,
 * they are found in this file's own added lines and the gate blocks its own
 * test. Keep any new fixture split the same way.
 */
const CONSOLE_CALL = `console.${'log'}('table');\n`;
const UNTRACKED_NOTE = `// ${'TO'}${'DO'}: come back to this\n`;
/** Each case builds a repository and shells out to the gate — well past bun's 5s default. */
const TIMEOUT_MS = 30_000;

/** The host environment with every variable this gate reads removed. */
function hostEnvWithoutGateConfig(): { [key: string]: string } {
  const inherited: { [key: string]: string } = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(LEFTOVER_|CONSOLE_EXCLUDE$|ALLOW_CONSOLE$|TICKET_REGEX$)/.test(key)) continue;
    inherited[key] = value;
  }
  return inherited;
}

interface Verdict {
  blocked: boolean;
  output: string;
}

/**
 * Runs the gate over one added file, on a fresh repo whose base commit is empty.
 * `movedTo` instead commits the file at `path` in the base, then moves it there,
 * so the diff the gate sees is a pure rename.
 */
async function gate(
  path: string,
  added: string,
  env: { [key: string]: string } = {},
  movedTo?: string,
): Promise<Verdict> {
  const repo = mkdtempSync(join(tmpdir(), 'leftover-'));
  try {
    const git = (...args: string[]) =>
      Bun.spawn(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' }).exited;
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'test');
    writeFileSync(join(repo, 'README.md'), 'base\n');
    if (movedTo !== undefined) {
      mkdirSync(join(repo, path, '..'), { recursive: true });
      writeFileSync(join(repo, path), added);
    }
    await git('add', '.');
    await git('commit', '-qm', 'base');
    const base = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repo }).stdout.toString().trim();
    const destination = movedTo ?? path;
    mkdirSync(join(repo, destination, '..'), { recursive: true });
    if (movedTo !== undefined) await git('mv', path, movedTo);
    else writeFileSync(join(repo, destination), added);
    await git('add', '-A');
    await git('commit', '-qm', 'change');

    const proc = Bun.spawn(['bash', SCRIPT], {
      cwd: repo,
      // Ambient configuration is stripped, not inherited: every knob this gate
      // reads is documented and exportable, so a developer with ALLOW_CONSOLE=1
      // in their shell would otherwise get different verdicts than CI.
      env: { ...hostEnvWithoutGateConfig(), LEFTOVER_BASE: base, ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    return { blocked: (await proc.exited) !== 0, output };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

describe('leftover gate', () => {
  test(
    'blocks a console line by default, wherever it is',
    async () => {
      const verdict = await gate('scripts/report.ts', CONSOLE_CALL);
      expect(verdict.blocked).toBe(true);
      expect(verdict.output).toContain('console');
    },
    TIMEOUT_MS,
  );

  test(
    'allows a console line on an excluded path',
    async () => {
      const verdict = await gate('scripts/report.ts', CONSOLE_CALL, { CONSOLE_EXCLUDE: '^scripts/' });
      expect(verdict.blocked).toBe(false);
    },
    TIMEOUT_MS,
  );

  // The exclusion lifts one rule, not the gate: a script is still code.
  test(
    `still blocks an untracked ${'TO'}${'DO'} on an excluded path`,
    async () => {
      const verdict = await gate('scripts/report.ts', UNTRACKED_NOTE, { CONSOLE_EXCLUDE: '^scripts/' });
      expect(verdict.blocked).toBe(true);
      expect(verdict.output).toContain('untracked-todo');
    },
    TIMEOUT_MS,
  );

  test(
    'still blocks a console line outside the excluded path',
    async () => {
      const verdict = await gate('src/handler.ts', CONSOLE_CALL, { CONSOLE_EXCLUDE: '^scripts/' });
      expect(verdict.blocked).toBe(true);
    },
    TIMEOUT_MS,
  );

  // A path the diff parser truncates matches no include pattern, so the file
  // skips every rule rather than one — the quietest way for a gate to fail.
  test(
    'scans a path that contains a space',
    async () => {
      const verdict = await gate('src/report table.ts', UNTRACKED_NOTE);
      expect(verdict.blocked).toBe(true);
      expect(verdict.output).toContain('untracked-todo');
    },
    TIMEOUT_MS,
  );

  // A move carries no added lines, so the destination would never be read — and
  // the file lands somewhere the exclusion does not cover.
  test(
    'scans a file moved out of the excluded path',
    async () => {
      const verdict = await gate('scripts/report.ts', CONSOLE_CALL, { CONSOLE_EXCLUDE: '^scripts/' }, 'src/report.ts');
      expect(verdict.blocked).toBe(true);
      expect(verdict.output).toContain('console');
    },
    TIMEOUT_MS,
  );

  // The exclusion is anchored, so it only holds while both scan modes report a
  // path the same way. The full-tree scan is the one that would drift.
  test(
    'the exclusion holds in a full-tree scan too',
    async () => {
      const verdict = await gate('scripts/report.ts', CONSOLE_CALL, {
        CONSOLE_EXCLUDE: '^scripts/',
        LEFTOVER_FULLTREE: '1',
      });
      expect(verdict.blocked).toBe(false);
    },
    TIMEOUT_MS,
  );
});
