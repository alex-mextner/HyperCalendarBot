// Honest intent coverage over a case corpus (docs/intents/coverage-methodology.md).
//
//   bun scripts/intent-coverage.ts --corpus <private cases.json> --labels <private labels dir> \
//     [--rules seed|<replace_all body.json>] [--compare seed|<replace_all body.json>] --out <private dir>
//   bun scripts/intent-coverage.ts --fixtures test/fixtures/intent-corpus/synthetic-cases.json --out <dir>
//
// Simulation runs in a sandboxed child process (scripts/intent-simulate.ts): no network, no AI calls,
// no production database. The private corpus is read in place; results go only to --out, which must
// be under this repository's ignored logs/ or outside the repository. Exit 2 = invalid arguments,
// refused output directory or unreadable input.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadFixtureCases, loadPrivateCorpus, loadRuleSource } from '../src/services/intent/simulation/corpus.ts';
import {
  type Comparison,
  type CoverageCase,
  compareReports,
  measureCoverage,
  writeReport,
} from '../src/services/intent/simulation/coverage.ts';
import { assertPrivateOutputDir } from '../src/services/intent/simulation/output-guard.ts';

const REPO = resolve(import.meta.dir, '..');

function fail(message: string): never {
  console.error(`intent-coverage: ${message}`);
  process.exit(2);
}

function readArgs() {
  try {
    return parseArgs({
      args: process.argv.slice(2),
      options: {
        corpus: { type: 'string' },
        labels: { type: 'string' },
        fixtures: { type: 'string' },
        rules: { type: 'string', default: 'seed' },
        compare: { type: 'string' },
        out: { type: 'string' },
      },
      strict: true,
    }).values;
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

function loadInputs(values: ReturnType<typeof readArgs>) {
  if (!values.out) fail('--out <private directory> is required');
  const out = assertPrivateOutputDir(values.out, REPO);
  const hasCorpus = values.corpus !== undefined || values.labels !== undefined;
  if (hasCorpus === (values.fixtures !== undefined)) fail('give either --corpus with --labels, or --fixtures');
  let cases: CoverageCase[];
  if (values.fixtures !== undefined) cases = loadFixtureCases(values.fixtures).cases;
  else if (values.corpus && values.labels) cases = loadPrivateCorpus(values.corpus, values.labels);
  else fail('--corpus and --labels go together');
  const rules = loadRuleSource(values.rules);
  const compareRules = values.compare === undefined ? null : loadRuleSource(values.compare);
  return { out, cases, rules, compareRules };
}

const values = readArgs();
let inputs: ReturnType<typeof loadInputs>;
try {
  inputs = loadInputs(values);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
const report = await measureCoverage(inputs.rules, inputs.cases);
let comparison: Comparison | null = null;
if (inputs.compareRules) comparison = compareReports(report, await measureCoverage(inputs.compareRules, inputs.cases));
writeReport(inputs.out, report, comparison);
const { buckets, cases, matcherOnly } = report.summary;
console.log(
  `covered ${buckets.covered}/${cases}; matcher-only matched ${matcherOnly.matched}/${cases}` +
    (comparison ? `; compare: gained ${comparison.gained.length}, lost ${comparison.lost.length}` : '') +
    `; results in ${inputs.out}`,
);
process.exit(0);
