import { expect, test } from 'bun:test';
import {
  evaluateCoverage,
  hasRuntimeCode,
  productionLineCoverage,
  runtimeSourceLines,
} from '../../ci/coverage-check.ts';

test('empty/missing production report cannot pass the local/CI gate', () => {
  for (const report of ['', 'SF:test/only.test.ts\nDA:1,1\nend_of_record'])
    expect(() => productionLineCoverage(report)).toThrow();
});
test('conservative threshold includes missing mapped runtime and uninstrumented physical lines', () => {
  const source = 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\n';
  const report = 'SF:src/example.ts\nDA:1,1\nDA:2,1\nDA:3,1\nDA:4,1\nend_of_record';
  for (const missing of ['mapped', 'uninstrumented']) {
    const sources = new Map([['src/example.ts', source]]);
    if (missing === 'mapped') sources.set('src/example.ts', `${source}export const e = 5;\n`);
    else sources.set('src/missing.ts', 'throw new Error("must not execute");\n');
    const exact = evaluateCoverage(report, sources);
    expect(exact.conservative).toEqual({ covered: 4, total: 5, ratio: 0.8 });
    expect(exact.passed).toBe(true);
    const below = evaluateCoverage(report.replace('DA:4,1', 'DA:4,0'), sources);
    expect(below.conservative.ratio).toBe(0.6);
    expect(below.passed).toBe(false);
    expect(evaluateCoverage(`${report}\n${report}`, sources).conservative).toEqual(exact.conservative);
  }
  const largeSource = `${'execute();\n'.repeat(10001)}`;
  const near = `SF:src/large.ts\n${Array.from({ length: 8000 }, (_, i) => `DA:${i + 1},1`).join('\n')}\nend_of_record`;
  expect(evaluateCoverage(near, new Map([['src/large.ts', largeSource]])).passed).toBe(false);
});
test('malformed counters are rejected', () => {
  for (const value of ['DA:1,-1', 'DA:0,1', 'DA:1,NaN', 'DA:1.5,1', 'DA:1,', 'DA:1, '])
    expect(() => productionLineCoverage(`SF:src/example.ts\n${value}\nend_of_record`)).toThrow(
      'Malformed coverage record',
    );
});

test('source paths cannot be used to inflate the production report', () => {
  for (const name of ['node_modules/library/src/lib.ts', 'test/fixtures/src/fake.ts', '../src/external.ts'])
    expect(() => productionLineCoverage(`SF:${name}\nDA:1,1\nend_of_record`)).toThrow('No production');
});
test('multiple executions of the same file use documented union coverage', () => {
  const first = 'SF:src/example.ts\nDA:1,1\nDA:2,0\nend_of_record';
  const second = 'SF:src/example.ts\nDA:1,0\nDA:2,1\nend_of_record';
  expect(productionLineCoverage(`${first}\n${second}`)).toMatchObject({ covered: 2, total: 2, ratio: 1 });
});

test('truncated records and inconsistent summaries fail closed', () => {
  for (const report of [
    'SF:src/example.ts\nDA:1,1',
    'SF:src/example.ts\nDA:1,1\nLF:2\nLH:1\nend_of_record',
    'SF:src/example.ts\nDA:1,1\nLF:1\nLH:0\nend_of_record',
    'SF:src/example.ts\nDA:1,1\nSF:src/other.ts\nDA:1,1\nend_of_record',
  ])
    expect(() => productionLineCoverage(report)).toThrow('Malformed');
});

test('relative, absolute and backslash aliases count a source line once', () => {
  const names = ['src/example.ts', './src/../src/example.ts', `${process.cwd()}/src/example.ts`, 'src\\example.ts'];
  const report = names.map((name) => `SF:${name}\nDA:1,1\nDA:2,0\nend_of_record`).join('\n');
  expect(productionLineCoverage(report)).toMatchObject({ covered: 1, total: 2, ratio: 0.5 });
});

test('CLI inventories uninstrumented sources and emits serializable conservative coverage', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  mkdirSync(`${process.cwd()}/coverage`, { recursive: true });
  const root = mkdtempSync(`${process.cwd()}/coverage/inventory-`);
  try {
    mkdirSync(`${root}/src`);
    writeFileSync(`${root}/src/loaded.ts`, 'one\ntwo\n');
    writeFileSync(`${root}/src/unloaded.ts`, '// comment\ncode\n\n');
    writeFileSync(
      `${root}/report.info`,
      'SF:src/loaded.ts\nDA:1,1\nDA:2,1\nLF:2\nLH:2\nend_of_record\nSF:src/unloaded.ts\nLF:0\nLH:0\nend_of_record\n',
    );
    const proc = Bun.spawnSync(
      [process.execPath, `${process.cwd()}/ci/coverage-check.ts`, 'report.info', 'summary.json'],
      { cwd: root },
    );
    expect(proc.exitCode).toBe(1);
    const summary = await Bun.file(`${root}/summary.json`).json();
    expect(summary.loaded).toMatchObject({ covered: 2, total: 2, ratio: 1 });
    expect(summary.conservative).toMatchObject({ covered: 2, total: 5, ratio: 0.4 });
    expect(summary.uninstrumented).toEqual([{ path: 'src/unloaded.ts', physicalLines: 3 }]);
    expect(summary.sourceFiles).toEqual(['src/loaded.ts', 'src/unloaded.ts']);
    const missing = Bun.spawnSync([process.execPath, `${process.cwd()}/ci/coverage-check.ts`, 'missing.info'], {
      cwd: root,
    });
    expect(missing.exitCode).not.toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runner cannot reuse stale reports or accept a missing browser run', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } = await import('node:fs');
  mkdirSync(`${process.cwd()}/coverage`, { recursive: true });
  const root = mkdtempSync(`${process.cwd()}/coverage/runner-`);
  try {
    mkdirSync(`${root}/ci`);
    mkdirSync(`${root}/coverage`);
    writeFileSync(`${root}/coverage/lcov.info`, 'accepted full report');
    copyFileSync('ci/test-coverage.sh', `${root}/ci/test-coverage.sh`);
    const fake = `${root}/fixture-bun`;
    writeFileSync(fake, '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    const run = Bun.spawnSync(['bash', 'ci/test-coverage.sh'], {
      cwd: root,
      env: { PATH: process.env.PATH, BUN_BIN: fake },
    });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain('Missing fresh');
    expect(await Bun.file(`${root}/coverage/lcov.info`).text()).toBe('accepted full report');
    writeFileSync(
      fake,
      `#!/bin/bash
if [[ "$*" == *"playwright-pool.test.ts"* && "$*" != *"path-ignore"* ]]; then exit 17; fi
for arg in "$@"; do
  if [[ "$arg" == --coverage-dir=* ]]; then
    dir="\${arg#--coverage-dir=}"
    mkdir -p "$dir"
    printf 'SF:src/example.ts\\nDA:1,1\\nend_of_record\\n' > "$dir/lcov.info"
  fi
done
exit 0
`,
      { mode: 0o755 },
    );
    const browserFailure = Bun.spawnSync(['bash', 'ci/test-coverage.sh'], {
      cwd: root,
      env: { PATH: process.env.PATH, BUN_BIN: fake },
    });
    expect(browserFailure.exitCode).not.toBe(0);
    expect(await Bun.file(`${root}/coverage/lcov.info`).text()).toBe('accepted full report');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Bun config honors explicit report directories and targeted runs preserve accepted reports', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } = await import('node:fs');
  mkdirSync('coverage', { recursive: true });
  const root = mkdtempSync(`${process.cwd()}/coverage/config-`);
  try {
    copyFileSync('bunfig.toml', `${root}/bunfig.toml`);
    writeFileSync(`${root}/sum.ts`, 'export function sum(a: number, b: number) { return a + b; }\n');
    mkdirSync(`${root}/accepted`);
    writeFileSync(`${root}/accepted/lcov.info`, 'preserved');
    writeFileSync(
      `${root}/fixture.test.ts`,
      "import { test, expect } from 'bun:test'; import { sum } from './sum'; test('arithmetic fixture', () => expect(sum(2, 2)).toBe(4));\n",
    );
    const result = Bun.spawnSync(
      [process.execPath, 'test', '--coverage', '--coverage-reporter=lcov', '--coverage-dir=fresh', './fixture.test.ts'],
      { cwd: root },
    );
    expect(result.exitCode).toBe(0);
    expect(await Bun.file(`${root}/fresh/lcov.info`).exists()).toBe(true);
    const targeted = Bun.spawnSync([process.execPath, 'test', './fixture.test.ts'], { cwd: root });
    expect(targeted.exitCode).toBe(0);
    expect(await Bun.file(`${root}/accepted/lcov.info`).text()).toBe('preserved');
    expect(await Bun.file(`${root}/coverage/lcov.info`).exists()).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing Chromium fails the real pool suite instead of skipping', () => {
  const result = Bun.spawnSync([process.execPath, '--no-env-file', 'test', './test/worker/playwright-pool.test.ts'], {
    env: { PATH: process.env.PATH, PLAYWRIGHT_BROWSERS_PATH: `${process.cwd()}/coverage/not-installed-chromium` },
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("Executable doesn't exist");
  expect(result.stderr.toString()).toContain('1 fail');
});

test('compiler-erased declarations contribute zero, but runtime syntax stays uncovered', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const root = mkdtempSync(`${process.cwd()}/coverage/erasure-`);
  try {
    mkdirSync(`${root}/src`);
    const sources = {
      'loaded.ts': 'export const value = 1;',
      'shapes.ts': 'import type { X } from "./other"; export interface Shape { x: X }\nexport type ID = string;',
      'ambient.d.ts': 'declare const window: unknown;\ninterface Ambient { x: string }',
      'empty.ts': '// nothing executable\nexport {};',
      'entry.ts': 'import "./side-effect";',
      'enum.ts': 'export enum Mode { A, B }',
      'value.ts': 'export const value = 1;',
      'import.ts': 'import { Value } from "./value"; export type T = typeof Value;',
    };
    for (const [name, source] of Object.entries(sources)) writeFileSync(`${root}/src/${name}`, source);
    writeFileSync(`${root}/report.info`, 'SF:src/loaded.ts\nDA:1,1\nend_of_record\n');
    const run = Bun.spawnSync(
      [process.execPath, `${process.cwd()}/ci/coverage-check.ts`, 'report.info', 'summary.json'],
      { cwd: root },
    );
    expect(run.exitCode).toBe(1);
    const summary = await Bun.file(`${root}/summary.json`).json();
    expect(summary.noRuntime.map((file: { path: string }) => file.path)).toEqual([
      'src/ambient.d.ts',
      'src/empty.ts',
      'src/shapes.ts',
    ]);
    expect(summary.conservative).toMatchObject({ covered: 1, total: 5, ratio: 0.2 });
    expect(summary.uninstrumented.map((file: { path: string }) => file.path)).toEqual([
      'src/entry.ts',
      'src/enum.ts',
      'src/import.ts',
      'src/value.ts',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compiler classifier retains runtime imports, enums, namespaces and JSX, and fails invalid syntax', () => {
  for (const source of [
    'import { type T } from "./effects";',
    'export * from "./effects";',
    'export const enum E { A }',
    'namespace N { export const v = 1; }',
    'const element = <div />;',
    'export function f() {}',
    'export class C {}',
  ])
    expect(hasRuntimeCode(source, 'arbitrary.tsx')).toBe(true);
  for (const source of [
    'export type { T } from "./types";',
    'declare class Ambient { x: string }',
    '/* comment */',
    'export interface X { y: number }',
  ])
    expect(hasRuntimeCode(source, 'arbitrary.ts')).toBe(false);
  expect(() => hasRuntimeCode('export const = ;', 'invalid.ts')).toThrow('invalid source');
});

// These subprocess fixtures exercise report validation, not application execution coverage.
for (const attack of ['one-line', 'out-of-bounds', 'hidden-directory', 'hidden-file']) {
  test(`actual CLI rejects ${attack} report inflation`, async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    mkdirSync('coverage', { recursive: true });
    const root = mkdtempSync(`${process.cwd()}/coverage/attack-`);
    try {
      mkdirSync(`${root}/src/.internal`, { recursive: true });
      const source = 'export const first = 1;\nexport const second = 2;\nexport const third = 3;\n';
      writeFileSync(`${root}/src/loaded.ts`, source);
      writeFileSync(`${root}/src/second.ts`, source);
      const line = attack === 'out-of-bounds' ? 999999 : 1;
      const records = ['loaded', 'second'].map((name) => `SF:src/${name}.ts\nDA:${line},1\nend_of_record`);
      if (attack.startsWith('hidden')) {
        records.splice(
          0,
          2,
          ...['loaded', 'second'].map((name) => `SF:src/${name}.ts\nDA:1,1\nDA:2,1\nDA:3,1\nend_of_record`),
        );
        writeFileSync(`${root}/src/${attack === 'hidden-file' ? '.runtime.ts' : '.internal/runtime.ts'}`, source);
      }
      writeFileSync(`${root}/report.info`, records.join('\n'));
      const run = Bun.spawnSync(
        [process.execPath, `${process.cwd()}/ci/coverage-check.ts`, 'report.info', 'summary.json'],
        { cwd: root },
      );
      expect(run.exitCode).toBe(1);
      if (attack === 'out-of-bounds') expect(run.stderr.toString()).toContain('outside source line bounds');
      else {
        const summary = await Bun.file(`${root}/summary.json`).json();
        expect(summary.passed).toBe(false);
        expect(summary.conservative.total).toBe(attack === 'one-line' ? 6 : 9);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('runtime source maps retain multiline code, large deltas, transformed enums and JSX without executing imports', () => {
  const source =
    'import "./must-not-execute";\n// erased comment\nexport interface Shape { x: number }\n\nexport function f(value: number) {\n  return value + 1;\n}\n';
  expect([...runtimeSourceLines(source, 'src/f.ts')].sort((a, b) => a - b)).toEqual([1, 5, 6, 7]);
  const distant = `${'// erased\n'.repeat(40)}export enum E {\n A,\n B\n}\n`;
  expect([...runtimeSourceLines(distant, 'src/e.ts')].sort((a, b) => a - b)).toEqual([41, 42, 43, 44]);
  expect(
    runtimeSourceLines('export const view = (\n  <div>\n    text\n  </div>\n);', 'src/view.tsx').size,
  ).toBeGreaterThan(1);
  expect(runtimeSourceLines('export type X = string;\nexport {};', 'src/types.ts').size).toBe(0);
});

test('DA bounds reject a terminator phantom line and accept the actual final line', () => {
  for (const ending of ['', '\n', '\r\n', '\r']) {
    const sources = new Map([['src/file.ts', `execute();${ending}`]]);
    expect(evaluateCoverage('SF:src/file.ts\nDA:1,1\nend_of_record', sources).passed).toBe(true);
    expect(() => evaluateCoverage('SF:src/file.ts\nDA:2,1\nend_of_record', sources)).toThrow(
      'outside source line bounds',
    );
  }
});

test('runner independently rejects failed unit and browser statuses with valid passing reports', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readdirSync } = await import('node:fs');
  const root = mkdtempSync(`${process.cwd()}/coverage/statuses-`);
  try {
    mkdirSync(`${root}/ci`);
    mkdirSync(`${root}/coverage`);
    mkdirSync(`${root}/src`);
    writeFileSync(`${root}/src/example.ts`, 'export const value = 1;\n');
    copyFileSync('ci/test-coverage.sh', `${root}/ci/test-coverage.sh`);
    const fake = `${root}/fixture-bun`;
    writeFileSync(
      fake,
      `#!/bin/bash
if [[ "$1" == ci/coverage-check.ts ]]; then exec "$REAL_BUN" "$REAL_CHECK" "$2" "$3"; fi
for arg in "$@"; do
  if [[ "$arg" == --coverage-dir=* ]]; then
    dir="\${arg#--coverage-dir=}"
    mkdir -p "$dir"
    printf 'SF:src/example.ts\\nDA:1,1\\nend_of_record\\n' > "$dir/lcov.info"
  fi
done
if [[ "$*" == *"playwright-pool.test.ts"* && "$*" != *"path-ignore"* ]]; then exit "$BROWSER_EXIT"; fi
exit "$UNIT_EXIT"
`,
      { mode: 0o755 },
    );
    for (const [unit, browser] of [
      [0, 0],
      [17, 0],
      [0, 19],
    ]) {
      const before = new Set(readdirSync(`${root}/coverage`, { recursive: false }).filter(Boolean));
      const run = Bun.spawnSync(['bash', 'ci/test-coverage.sh'], {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          BUN_BIN: fake,
          REAL_BUN: process.execPath,
          REAL_CHECK: `${process.cwd()}/ci/coverage-check.ts`,
          UNIT_EXIT: String(unit),
          BROWSER_EXIT: String(browser),
        },
      });
      expect(run.exitCode).toBe(unit || browser ? 1 : 0);
      const fresh = readdirSync(`${root}/coverage`).filter((name) => !before.has(name));
      expect(fresh.length).toBe(1);
      const report = `${root}/coverage/${fresh[0]}`;
      expect(await Bun.file(`${report}/tests.json`).json()).toEqual({ unitExitCode: unit, browserExitCode: browser });
      expect((await Bun.file(`${report}/summary.json`).json()).passed).toBe(true);
      expect(await Bun.file(`${report}/unit/lcov.info`).exists()).toBe(true);
      expect(await Bun.file(`${report}/browser/lcov.info`).exists()).toBe(true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
