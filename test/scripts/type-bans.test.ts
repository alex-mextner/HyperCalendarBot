// test/scripts/type-bans.test.ts
//
// The gate decides what cannot merge, so its edges matter: a ban that also
// catches ordinary prose is a gate people learn to bypass, and one that misses
// the real construct is decoration.
//
// The banned constructs are assembled from pieces rather than written out —
// this file is TypeScript, the gate scans TypeScript, and spelled literally
// they would make it block its own test. Keep any new fixture split the same way.
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, '../../ci/type-bans/type-bans.sh');
/** Each case builds a repository and shells out to the gate. */
const TIMEOUT_MS = 30_000;

const DOUBLE_CAST = `const x = value ${'as'} unknown ${'as'} Widget;\n`;
const BOTTOM_CAST = `send(payload ${'as'} ${'never'});\n`;
const LOOSE_DICTIONARY = `let bag: ${'Record'}<string, unknown> = {};\n`;
const EMPTY_SCHEMA = `const schema = z.${'unknown'}();\n`;

interface Verdict {
  blocked: boolean;
  output: string;
}

/** Runs the gate over one added file, on a fresh repo whose base commit is empty. */
async function gate(path: string, added: string): Promise<Verdict> {
  const repo = mkdtempSync(join(tmpdir(), 'type-bans-'));
  try {
    const git = (...args: string[]) =>
      Bun.spawn(['git', ...args], { cwd: repo, stdout: 'pipe', stderr: 'pipe' }).exited;
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'test');
    writeFileSync(join(repo, 'README.md'), 'base\n');
    await git('add', '.');
    await git('commit', '-qm', 'base');
    const base = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repo }).stdout.toString().trim();
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), added);
    await git('add', '-A');
    await git('commit', '-qm', 'change');

    const proc = Bun.spawn(['bash', SCRIPT], {
      cwd: repo,
      env: { ...process.env, TYPE_BANS_BASE: base },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const output = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
    return { blocked: (await proc.exited) !== 0, output };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

describe('type-ban gate', () => {
  test(
    'blocks the double cast in src',
    async () => {
      const verdict = await gate('src/widget.ts', DOUBLE_CAST);
      expect(verdict.blocked).toBe(true);
      expect(verdict.output).toContain('double-cast');
    },
    TIMEOUT_MS,
  );

  // CLAUDE.md's one exception: a centralized test factory may present a partial
  // mock as the real interface.
  test(
    'allows the double cast in a test',
    async () => {
      const verdict = await gate('test/widget.test.ts', DOUBLE_CAST);
      expect(verdict.blocked).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    'blocks the bottom-type cast anywhere',
    async () => {
      const verdict = await gate('test/widget.test.ts', BOTTOM_CAST);
      expect(verdict.blocked).toBe(true);
      expect(verdict.output).toContain('as-never');
    },
    TIMEOUT_MS,
  );

  // The word appears in ordinary English, and a gate that fires on comments is
  // one people route around.
  test(
    'leaves the same word alone in prose',
    async () => {
      const verdict = await gate('src/widget.ts', '// This branch was never reached in production.\n');
      expect(verdict.blocked).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    'blocks the loose dictionary type',
    async () => {
      const verdict = await gate('src/widget.ts', LOOSE_DICTIONARY);
      expect(verdict.blocked).toBe(true);
      expect(verdict.output).toContain('record-string-unknown');
    },
    TIMEOUT_MS,
  );

  test(
    'blocks a schema that validates nothing',
    async () => {
      const verdict = await gate('src/widget.ts', EMPTY_SCHEMA);
      expect(verdict.blocked).toBe(true);
      expect(verdict.output).toContain('z-unknown');
    },
    TIMEOUT_MS,
  );

  // Only TypeScript is in scope; a Python script naming the same construct is not.
  test(
    'ignores files it does not type-check',
    async () => {
      const verdict = await gate('scripts/tool.py', LOOSE_DICTIONARY);
      expect(verdict.blocked).toBe(false);
    },
    TIMEOUT_MS,
  );
});
