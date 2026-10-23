import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest, sha256, writeChecksums } from '../../../scripts/model-quality/evidence.ts';
import { fixtures } from '../../../scripts/model-quality/fixtures.ts';
import { QUALIFICATION_TARGETS } from '../../../scripts/model-quality/models.ts';

const git = { sha: 'a'.repeat(40), tree: 'b'.repeat(40), dirtyPaths: [] };

function manifest() {
  return buildManifest({
    git,
    at: '2026-10-23T20:00:00.000Z',
    candidates: QUALIFICATION_TARGETS,
    roles: ['executor', 'repair', 'planner'],
    caseIds: fixtures.map((f) => f.id),
    repeats: 1,
    budgetUsd: 1,
    alreadySpentUsd: 0.5,
    mode: 'full',
    maxRounds: 6,
  });
}

test('the manifest pins source, fixture, prompt and tool versions and the scope', () => {
  const m = manifest();
  expect(m.source).toEqual(git);
  for (const key of [
    'fixturesSha256',
    'promptSha256',
    'toolsSha256',
    'repairNudgeSha256',
    'lightInstructionsSha256',
  ] as const)
    expect(m[key]).toMatch(/^[0-9a-f]{64}$/);
  expect(m.toolCount).toBeGreaterThan(50);
  expect(m.caseIds).toHaveLength(32);
  expect(m.scope.privateHistorySent).toBe(false);
  expect(m.scope.productionSideEffects).toBe(false);
  expect(m.scope.qualification).toBeNull();
  expect(m.budget).toEqual({ capUsd: 1, alreadySpentUsd: 0.5, runWideCapUsd: 3 });
});

test("the manifest records each candidate's model settings and dated price, never a credential", () => {
  const m = manifest();
  const glm = m.candidates.find((c) => c.id === 'glm53-flash-low@openrouter');
  expect(glm).toMatchObject({ model: 'z-ai/glm-5.3-flash', effort: 'low', temperature: 1, maxOutputTokens: 8192 });
  expect(glm?.price.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(JSON.stringify(m)).not.toMatch(/sk-|KEY|TOKEN|Bearer/);
});

test('the manifest is stable for identical inputs', () =>
  expect(JSON.stringify(manifest())).toBe(JSON.stringify(manifest())));

test('checksums cover every file once, are verifiable, and refuse to overwrite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hcb-evidence-'));
  writeFileSync(join(dir, 'a.json'), 'one');
  writeFileSync(join(dir, 'results.jsonl'), 'two\n');
  writeChecksums(dir);
  const lines = readFileSync(join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n');
  expect(lines).toEqual([`${sha256('one')}  a.json`, `${sha256('two\n')}  results.jsonl`]);
  expect(() => writeChecksums(dir)).toThrow();
});
