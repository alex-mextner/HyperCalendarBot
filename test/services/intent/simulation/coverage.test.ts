// The coverage harness: rule-set comparison, the private output guard, the committed synthetic
// fixtures and the private corpus reader. Simulation runs in the real child process.
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { seedIntents } from '../../../../src/services/intent/seed-catalog.ts';
import { loadFixtureCases, loadPrivateCorpus } from '../../../../src/services/intent/simulation/corpus.ts';
import {
  BUCKETS,
  compareReports,
  LABEL_CLASSES,
  measureCoverage,
  writeReport,
} from '../../../../src/services/intent/simulation/coverage.ts';
import { assertPrivateOutputDir } from '../../../../src/services/intent/simulation/output-guard.ts';

const REPO = resolve(import.meta.dir, '../../../..');
const FIXTURES = join(REPO, 'test/fixtures/intent-corpus/synthetic-cases.json');
const temporary: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'intent-coverage-'));
  temporary.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('committed synthetic fixtures', () => {
  const fixtures = loadFixtureCases(FIXTURES);
  let report: Awaited<ReturnType<typeof measureCoverage>>;
  beforeAll(async () => {
    report = await measureCoverage(seedIntents, fixtures.cases);
  }, 180_000);

  test('every label class has at least six synthetic cases', () => {
    for (const labelClass of LABEL_CLASSES)
      expect(fixtures.cases.filter((row) => row.label?.class === labelClass).length).toBeGreaterThanOrEqual(6);
    expect(fixtures.origins).toEqual(['synthetic']);
  });

  test('each fixture lands in the bucket it documents under the source seed', () => {
    const actual = Object.fromEntries(report.cases.map((row) => [row.caseId, row.bucket]));
    expect(actual).toEqual(fixtures.expectedBuckets);
  });

  test('comparing a rule set with itself reports nothing gained or lost', async () => {
    const again = await measureCoverage(seedIntents, fixtures.cases);
    expect(compareReports(report, again)).toEqual({ gained: [], lost: [], changed: [] });
  }, 180_000);

  test('a rule set without the agenda rule loses exactly the cases that rule covered', async () => {
    const withoutDay = seedIntents.filter((seed) => seed.canonical_name !== 'basis.calendar.day');
    const reduced = await measureCoverage(withoutDay, fixtures.cases);
    const comparison = compareReports(report, reduced);
    const dayCovered = report.cases
      .filter((row) => row.bucket === 'covered' && row.intent === 'basis.calendar.day')
      .map((row) => row.caseId);
    expect(dayCovered.length).toBeGreaterThan(0);
    expect(comparison.lost).toEqual(dayCovered);
    expect(comparison.gained).toEqual([]);
  }, 180_000);

  test('the summary counts every case in exactly one bucket and per class', () => {
    const total = BUCKETS.reduce((sum, bucket) => sum + report.summary.buckets[bucket], 0);
    expect(total).toBe(fixtures.cases.length);
    expect(report.summary.cases).toBe(fixtures.cases.length);
    for (const labelClass of LABEL_CLASSES) {
      const row = report.summary.byClass[labelClass];
      const perClass = BUCKETS.reduce((sum, bucket) => sum + row[bucket], 0);
      expect(perClass).toBe(fixtures.cases.filter((c) => c.label?.class === labelClass).length);
    }
  });

  test('the written case list carries no request text; the three-way file keeps a missing ideal visible', () => {
    const out = tempDir();
    writeReport(out, report);
    const lines = readFileSync(join(out, 'cases.jsonl'), 'utf8');
    for (const fixture of fixtures.cases) expect(lines).not.toContain(fixture.request);
    const summary = readFileSync(join(out, 'summary.json'), 'utf8');
    expect(summary).toContain('"covered"');
    const threeWay = readFileSync(join(out, 'three-way.jsonl'), 'utf8').trim().split('\n');
    expect(threeWay.length).toBe(report.threeWay.length);
    expect(report.threeWay.some((row) => row.idealMissing)).toBe(true);
    expect(report.threeWay.every((row) => row.rubric === 'unscored')).toBe(true);
  });
});

describe('private output guard', () => {
  test('refuses tracked directories inside the repository', () => {
    for (const dir of ['docs', 'test', 'src', 'docs/intents', '.', 'scripts/out'])
      expect(() => assertPrivateOutputDir(join(REPO, dir), REPO)).toThrow(/refus/i);
  });

  test('refuses a path that climbs back into the repository', () => {
    expect(() => assertPrivateOutputDir(join(REPO, 'logs/../docs'), REPO)).toThrow(/refus/i);
  });

  test('accepts the ignored logs directory and paths outside the repository', () => {
    expect(assertPrivateOutputDir(join(REPO, 'logs/coverage-run'), REPO)).toBe(join(REPO, 'logs/coverage-run'));
    const outside = tempDir();
    expect(assertPrivateOutputDir(outside, REPO)).toBe(outside);
  });
});

describe('private corpus reader', () => {
  function writeCorpus(dir: string) {
    const turn = (role: string, text: string) => ({ role, text, createdAt: '2026-03-01 10:00:00' });
    const base = {
      createdAt: '2026-03-02 08:15:00',
      timezoneAssumption: 'Europe/Berlin',
      prior: [turn('user', 'synthetic earlier turn')],
      contextRecovered: true,
      sourceId: 'synthetic-source',
    };
    const corpus = [
      {
        ...base,
        caseId: 'case-001',
        request: 'synthetic agenda question',
        historical: [turn('assistant', JSON.stringify({ role: 'assistant', content: 'Synthetic old answer' }))],
        sensitiveExcluded: false,
      },
      {
        ...base,
        caseId: 'case-002',
        request: 'синтетический вопрос',
        historical: [turn('assistant', JSON.stringify([{ type: 'text', text: 'Старый синтетический ответ' }]))],
        sensitiveExcluded: false,
      },
      { ...base, caseId: 'case-003', request: '[redacted]', historical: [], sensitiveExcluded: true },
    ];
    writeFileSync(join(dir, 'cases.json'), JSON.stringify(corpus));
    const label = (caseId: string, labelClass: string) => ({
      caseId,
      family: 'agenda',
      class: labelClass,
      oldVerdict: 'synthetic',
      idealResponse: 'Synthetic ideal',
      expectedTools: ['get_events'],
      needsContext: [],
      rationale: 'synthetic',
      variationNotes: 'synthetic',
    });
    writeFileSync(join(dir, 'semantic-small-000.json'), JSON.stringify({ cases: [label('case-001', 'direct')] }));
    writeFileSync(join(dir, 'semantic-small-000.receipt.json'), JSON.stringify({ status: 'completed' }));
    const withoutIdeal = { ...label('case-002', 'contextual'), idealResponse: undefined };
    writeFileSync(join(dir, 'semantic-small-001.json'), JSON.stringify({ cases: [withoutIdeal] }));
    writeFileSync(join(dir, 'semantic-small-001.receipt.json'), JSON.stringify({ status: 'failed' }));
  }

  test('joins labels by case id, keeps receipt provenance and marks a case without a label', () => {
    const dir = tempDir();
    writeCorpus(dir);
    const cases = loadPrivateCorpus(join(dir, 'cases.json'), dir);
    expect(cases.map((row) => [row.caseId, row.label?.class ?? null, row.labelProvenance])).toEqual([
      ['case-001', 'direct', 'verified'],
      ['case-002', 'contextual', 'unverified'],
      ['case-003', null, 'missing'],
    ]);
  });

  test('a label without an ideal answer keeps it missing instead of failing the run', () => {
    const dir = tempDir();
    writeCorpus(dir);
    const [first, second] = loadPrivateCorpus(join(dir, 'cases.json'), dir);
    expect(first!.label?.idealResponse).toBe('Synthetic ideal');
    expect(second!.label?.idealResponse).toBeNull();
  });

  test('a case with an unknown time zone is refused by id before anything runs', () => {
    const dir = tempDir();
    writeCorpus(dir);
    const path = join(dir, 'cases.json');
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('Europe/Berlin', 'Europe/Berln'));
    expect(() => loadPrivateCorpus(path, dir)).toThrow(/case-001.*Europe\/Berln/);
  });

  test('reads the case time as UTC, detects the language and extracts the historical answer', () => {
    const dir = tempDir();
    writeCorpus(dir);
    const [first, second, third] = loadPrivateCorpus(join(dir, 'cases.json'), dir);
    expect(first).toMatchObject({ at: '2026-03-02T08:15:00.000Z', timezone: 'Europe/Berlin', language: 'en' });
    expect(first!.historicalAnswer).toBe('Synthetic old answer');
    expect(second).toMatchObject({ language: 'ru', historicalAnswer: 'Старый синтетический ответ' });
    expect(first!.calendar).toEqual([]);
    expect(third).toMatchObject({ sensitive: true, historicalAnswer: null });
  });

  test('an unlabelled case is simulated but reported as unlabelled, never as covered', async () => {
    const dir = tempDir();
    writeCorpus(dir);
    const cases = loadPrivateCorpus(join(dir, 'cases.json'), dir).map((row) =>
      row.caseId === 'case-003' ? { ...row, sensitive: false, request: 'что у меня на сегодня' } : row,
    );
    const report = await measureCoverage(seedIntents, cases);
    expect(report.cases.find((row) => row.caseId === 'case-003')).toMatchObject({
      bucket: 'unlabelled',
      intent: 'basis.calendar.day',
    });
    expect(report.summary.labelProvenance).toEqual({ verified: 1, unverified: 1, missing: 1 });
  }, 120_000);
});
