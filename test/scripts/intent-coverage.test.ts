// End-to-end runs of the coverage CLI on the committed synthetic fixtures: it refuses tracked output
// directories, writes counts and per-case buckets to a private directory, compares two rule sources,
// and reads a rule set from an exported replace_all revision body.
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { seedFingerprint } from '../../src/services/intent/rule-fingerprint.ts';
import { seedIntents } from '../../src/services/intent/seed-catalog.ts';
import { jsonCodec } from '../../src/utils/json-codec.ts';

const REPO = resolve(import.meta.dir, '../..');
const SCRIPT = join(REPO, 'scripts/intent-coverage.ts');
const FIXTURES = join(REPO, 'test/fixtures/intent-corpus/synthetic-cases.json');
const temporary: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'intent-coverage-cli-'));
  temporary.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function cli(args: string[]): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(['bun', SCRIPT, ...args], { cwd: REPO, stdout: 'pipe', stderr: 'pipe', env: process.env });
  const timer = setTimeout(() => child.kill('SIGKILL'), 170_000);
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  return { code, output: out + err };
}

const SummaryCodec = jsonCodec(
  z.object({
    cases: z.number(),
    ruleCount: z.number(),
    ruleFingerprint: z.string(),
    buckets: z.object({ covered: z.number() }),
    matcherOnly: z.object({ matched: z.number() }),
    comparison: z.object({ gained: z.array(z.string()), lost: z.array(z.string()) }).nullable(),
  }),
);

test('refuses to write results into a tracked directory and writes nothing there', async () => {
  const target = join(REPO, 'docs', 'coverage-refused-by-test');
  const result = await cli(['--fixtures', FIXTURES, '--out', target]);
  expect(result.code).toBe(2);
  expect(result.output).toMatch(/Refusing output directory/);
  expect(existsSync(target)).toBe(false);
}, 180_000);

test('measures the fixtures with the source seed and compares it with itself', async () => {
  const out = tempDir();
  const result = await cli(['--fixtures', FIXTURES, '--rules', 'seed', '--compare', 'seed', '--out', out]);
  expect(result.code).toBe(0);
  const summary = SummaryCodec.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  expect(summary.ruleCount).toBe(seedIntents.length);
  expect(summary.ruleFingerprint).toBe(seedFingerprint(seedIntents));
  expect(summary.buckets.covered).toBeGreaterThan(0);
  expect(summary.comparison).toEqual({ gained: [], lost: [] });
  expect(result.output).toContain(`covered ${summary.buckets.covered}/${summary.cases}`);
}, 180_000);

test('reads a rule set from an exported replace_all revision body and refuses an operations body', async () => {
  const dir = tempDir();
  const withoutDay = seedIntents.filter((seed) => seed.canonical_name !== 'basis.calendar.day');
  const body = join(dir, 'replace-all.json');
  writeFileSync(
    body,
    JSON.stringify({ type: 'replace_all', summary: 'Seed without the day agenda', rules: withoutDay }),
  );
  const out = join(dir, 'out');
  const result = await cli(['--fixtures', FIXTURES, '--rules', 'seed', '--compare', body, '--out', out]);
  expect(result.code).toBe(0);
  const summary = SummaryCodec.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  expect(summary.comparison?.gained).toEqual([]);
  expect(summary.comparison?.lost.length).toBeGreaterThan(0);

  const operations = join(dir, 'operations.json');
  writeFileSync(
    operations,
    JSON.stringify({
      type: 'operations',
      summary: 'One change',
      operations: [{ kind: 'retire', sourceNames: ['basis.calendar.day'], intents: [], reason: 'test' }],
    }),
  );
  const refused = await cli(['--fixtures', FIXTURES, '--rules', operations, '--out', join(dir, 'out2')]);
  expect(refused.code).toBe(2);
  expect(refused.output).toMatch(/replace_all/);
}, 180_000);
