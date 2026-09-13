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

/**
 * Runs the gate over one added file, on a fresh repo whose base commit is empty.
 * `movedTo` instead commits the file at `path` in the base and moves it there,
 * so the diff the gate sees is a pure rename.
 */
async function gate(path: string, added: string, movedTo?: string): Promise<Verdict> {
  const repo = mkdtempSync(join(tmpdir(), 'type-bans-'));
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

  // "w-as unknown as" lives inside an ordinary sentence, and a gate that blocks
  // the sentence is a gate someone disables.
  test(
    'leaves the words alone inside a sentence',
    async () => {
      const prose = 'const note = "the provider status was unknown as of the last poll";\n';
      const verdict = await gate('src/widget.ts', prose);
      expect(verdict.blocked).toBe(false);
    },
    TIMEOUT_MS,
  );

  // A cast cannot live in a comment, and English can say anything there.
  test(
    'leaves comment lines alone',
    async () => {
      const comment = `// treat the empty set ${'as'} ${'never'}, per the spec\n`;
      const verdict = await gate('src/widget.ts', comment);
      expect(verdict.blocked).toBe(false);
    },
    TIMEOUT_MS,
  );

  // Chained through the bottom type, this used to fall between two patterns:
  // not "as unknown as", and never followed by a bracket.
  test(
    'blocks a cast chained through the bottom type',
    async () => {
      const chained = `const x = value ${'as'} ${'never'} ${'as'} Widget;\n`;
      const verdict = await gate('src/widget.ts', chained);
      expect(verdict.blocked).toBe(true);
      expect(verdict.output).toContain('as-never');
    },
    TIMEOUT_MS,
  );

  // A limit, recorded so it surprises nobody: catching a construct the formatter
  // wrapped across lines needs a parser, and this is a grep on purpose.
  test(
    'does not see a construct split across lines',
    async () => {
      const wrapped = `let bag: ${'Record'}<\n  string,\n  unknown\n> = {};\n`;
      const verdict = await gate('src/widget.ts', wrapped);
      expect(verdict.blocked).toBe(false);
    },
    TIMEOUT_MS,
  );

  // Shipped package sources receive the same protection as top-level src/.
  test(
    'covers a package that ships, not only the top-level src',
    async () => {
      const verdict = await gate('packages/example/src/main.ts', DOUBLE_CAST);
      expect(verdict.blocked).toBe(true);
      expect(verdict.output).toContain('double-cast');
    },
    TIMEOUT_MS,
  );

  // A custom type whose name happens to end in the banned one is not the banned
  // one, and a formatter's spacing does not change what a type is.
  test(
    'tells the banned dictionary apart from a custom type',
    async () => {
      const custom = `let value: My${'Record'}<string, unknown> = load();\n`;
      expect((await gate('src/widget.ts', custom)).blocked).toBe(false);

      const spaced = `let bag: ${'Record'} < string , unknown > = {};\n`;
      expect((await gate('src/widget.ts', spaced)).blocked).toBe(true);
    },
    TIMEOUT_MS,
  );

  // Moving a file does not write its contents anew, and failing an honest
  // rename over debt that was already there is the one thing this gate says it
  // will not do.
  test(
    'stays quiet when a file carrying old debt is only moved',
    async () => {
      const verdict = await gate('src/old/widget.ts', BOTTOM_CAST, 'src/new/widget.ts');
      expect(verdict.blocked).toBe(false);
    },
    TIMEOUT_MS,
  );

  // A comment can open a line that goes on to hold a cast; skipping the whole
  // line would be a one-character way past every ban.
  test(
    'still reads code that follows a comment on the same line',
    async () => {
      const mixed = `/* fine */ send(payload ${'as'} ${'never'});\n`;
      const verdict = await gate('src/widget.ts', mixed);
      expect(verdict.blocked).toBe(true);
    },
    TIMEOUT_MS,
  );

  // Degrading quietly is how a gate ends up scanning the base branch instead of
  // the pull request, and then either failing everything or passing everything.
  test(
    'refuses to run when its base cannot be resolved',
    async () => {
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

        const proc = Bun.spawn(['bash', SCRIPT], {
          cwd: repo,
          env: { ...process.env, TYPE_BANS_BASE: 'origin/nope' },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const output = await new Response(proc.stderr).text();
        expect(await proc.exited).not.toBe(0);
        expect(output).toContain('cannot resolve base');
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
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
