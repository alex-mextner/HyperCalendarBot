// scripts/model-quality/run.ts
// Live qualification run. Manual only: tests never import it. Credentials come from the environment
// (bun --env-file=<.env> scripts/model-quality/run.ts ...), spend is capped (budget.ts), and the output is
// one NEW directory per invocation, never reused:
//   manifest.json  what was run (source, prompt/tools/fixture hashes, settings, scope), written before request 1
//   results.jsonl  one row per attempt, appended as it finishes
//   SHA256SUMS     written once at the end
//
//   bun --env-file=.env scripts/model-quality/run.ts --out <new dir> --models deepseek41-flash@openrouter \
//     --roles executor,repair,planner --budget 1 [--already-spent 0.2] [--cases today,tomorrow] [--repeats 1]

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { MODEL_ROLES, type ModelRole } from '../../src/services/ai/model-presets.ts';
import { Budget } from './budget.ts';
import { buildManifest, gitInfo, writeChecksums } from './evidence.ts';
import { fixtures } from './fixtures.ts';
import { lightCallFor, runLightCase } from './light.ts';
import { lightCases } from './light-cases.ts';
import { candidateId, QUALIFICATION_TARGETS } from './models.ts';
import { DEFAULT_LIMITS, type MeasuredRow, runScenario } from './runner.ts';
import { clientFor, roundFor } from './slot.ts';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    out: { type: 'string' },
    models: { type: 'string' },
    roles: { type: 'string', default: 'executor,repair,planner' },
    cases: { type: 'string' },
    repeats: { type: 'string', default: '1' },
    budget: { type: 'string' },
    'already-spent': { type: 'string', default: '0' },
    mode: { type: 'string', default: 'full' },
    rounds: { type: 'string', default: String(DEFAULT_LIMITS.maxRounds) },
  },
  strict: true,
});

if (!values.out) throw new Error('--out <new directory> is required');
if (values.budget === undefined) throw new Error('--budget <USD> is required');
if (values.mode !== 'full' && values.mode !== 'lazy') throw new Error('Invalid tool schema mode');
const mode = values.mode;
const roles = (values.roles ?? '').split(',').map((r) => {
  const role = MODEL_ROLES.find((known): known is ModelRole => known === r);
  if (!role) throw new Error(`Unknown role ${r}`);
  return role;
});
const ids = values.models?.split(',');
const selected = QUALIFICATION_TARGETS.filter((c) => !ids || ids.includes(candidateId(c)));
if (!selected.length || ids?.some((id) => !selected.some((c) => candidateId(c) === id)))
  throw new Error('Unknown model selection');
const caseIds = values.cases?.split(',');
const chosen = fixtures.filter((f) => !caseIds || caseIds.includes(f.id));
const lightChosen = lightCases.filter((c) => !caseIds || caseIds.includes(c.id));
if (!chosen.length && roles.some((r) => r !== 'planner')) throw new Error('No scenarios selected');
const repeats = Number(values.repeats);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 3) throw new Error('Invalid repeats');
const maxRounds = Number(values.rounds);
if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 12) throw new Error('Invalid max rounds');
const budget = new Budget(Number(values.budget), Number(values['already-spent']));
const limits = { ...DEFAULT_LIMITS, maxRounds };

const out = resolve(values.out);
mkdirSync(out, { recursive: false, mode: 0o700 });
writeFileSync(
  `${out}/manifest.json`,
  `${JSON.stringify(
    buildManifest({
      git: gitInfo(),
      at: new Date().toISOString(),
      candidates: selected,
      roles,
      caseIds: [...chosen.map((f) => f.id), ...(roles.includes('planner') ? lightChosen.map((c) => c.id) : [])],
      repeats,
      budgetUsd: budget.capUsd,
      alreadySpentUsd: Number(values['already-spent']),
      mode,
      maxRounds,
    }),
    null,
    2,
  )}\n`,
  { flag: 'wx', mode: 0o600 },
);

/** Errors that mean the route itself is unusable: further cases would only repeat the same failed request. */
const STOP_ERRORS = new Set([
  'NO_KEY',
  'HTTP_401',
  'HTTP_402',
  'HTTP_403',
  'HTTP_404',
  'HTTP_429',
  'EXPERIMENT_BUDGET',
]);

function record(row: MeasuredRow): boolean {
  appendFileSync(`${out}/results.jsonl`, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  console.log(
    JSON.stringify({
      model: row.candidate,
      role: row.role,
      case: row.caseId,
      rep: row.repetition,
      pass: row.pass,
      critical: row.critical,
      ms: Math.round(row.durationMs),
      rounds: row.rounds,
      error: row.error,
      reasons: row.reasons,
      costUsd: row.costUsd,
      spent: Math.round(budget.spentUsd * 1e6) / 1e6,
    }),
  );
  return row.error !== null && STOP_ERRORS.has(row.error);
}

let rows = 0;
for (const candidate of selected) {
  let stop = false;
  const client = (() => {
    try {
      return clientFor(candidate);
    } catch {
      console.log(JSON.stringify({ model: candidateId(candidate), error: 'NO_KEY' }));
      return null;
    }
  })();
  if (!client) continue;
  const round = roundFor(candidate, client);
  const light = lightCallFor(client);
  for (const role of roles) {
    for (let repetition = 0; repetition < repeats && !stop; repetition++) {
      if (role === 'planner') {
        for (const fixture of lightChosen) {
          rows++;
          if (
            record(
              await runLightCase({
                candidate,
                fixture,
                repetition,
                call: light,
                budget,
                attemptTimeoutMs: limits.attemptTimeoutMs,
              }),
            )
          ) {
            stop = true;
            break;
          }
        }
      } else {
        for (const fixture of chosen) {
          rows++;
          if (record(await runScenario({ candidate, fixture, role, repetition, round, budget, mode, limits }))) {
            stop = true;
            break;
          }
        }
      }
    }
    if (stop) break;
  }
}
writeChecksums(out);
console.log(
  `RUN_COMPLETE ${JSON.stringify({ out, rows, spentThisRunUsd: budget.spentUsd, unknownReservations: budget.unknownReservations })}`,
);
