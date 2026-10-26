/**
 * Acceptance gate for a tool schema mode: compares saved dry-run outcomes of the same cases
 * (`DRYRUN_OUT` of scripts/dryrun-tool-selection.ts, repeated runs per `DRYRUN_TOOL_MODE`).
 *
 *   bun scripts/dryrun-gate.ts full1.json,full2.json,full3.json hybrid1.json,hybrid2.json,hybrid3.json
 *   bun scripts/dryrun-gate.ts <baseline runs> <candidate runs> --exclude-users=u07,u09
 *
 * Each side is a comma-separated list of runs. A provider answers the same case differently from run to
 * run, so a single run per side cannot tell a mode effect from noise; the spread between the baseline's own
 * repeats is the margin the candidate gets. Over the cases answered in every run of both sides (a timeout
 * says nothing about tool choice, so those are left out and counted) it passes only when:
 *   - the candidate needs at most 0.1 more discover_tools rounds per request,
 *   - its first request carries fewer prompt tokens,
 *   - its mean accuracy is at least the baseline's mean minus the baseline's repeat spread (max - min),
 *   - no write-capable row regressed: where the baseline picked a write tool correctly in most of its runs,
 *     the candidate must too. Such rows are listed and need an explicit explanation.
 */
import { z } from 'zod';
import { WRITE_TOOLS } from '../src/services/ai/tool-executor.ts';

const MAX_EXTRA_ROUNDS_PER_REQUEST = 0.1;

const outcomeSchema = z.object({
  id: z.string(),
  provider: z.string(),
  error: z.string().nullable(),
  ok: z.boolean(),
  tools: z.array(z.string()),
  promptTokens: z.number().nullable(),
  discoverRounds: z.number(),
});
type Outcome = z.infer<typeof outcomeSchema>;

const keyOf = (outcome: Outcome) => `${outcome.provider}/${outcome.id}`;
const userOf = (outcome: Outcome) => outcome.id.split(':')[0] ?? '';

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

const flags = process.argv.slice(2).filter((arg) => arg.startsWith('--'));
const unknownFlag = flags.find((flag) => !flag.startsWith('--exclude-users='));
if (unknownFlag) throw new Error(`unknown flag ${unknownFlag}`);
const excluded = new Set(flags.flatMap((flag) => flag.slice('--exclude-users='.length).split(',')));
const [baselineArg, candidateArg] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
if (!baselineArg || !candidateArg) {
  throw new Error(
    'usage: bun scripts/dryrun-gate.ts <baseline.json[,more]> <candidate.json[,more]> [--exclude-users=u07,...]',
  );
}

async function loadRuns(arg: string): Promise<Map<string, Outcome>[]> {
  const runs = await Promise.all(
    arg.split(',').map(async (path) => z.array(outcomeSchema).parse(await Bun.file(path).json())),
  );
  return runs.map((run) => new Map(run.filter((o) => !excluded.has(userOf(o))).map((o) => [keyOf(o), o])));
}

const baseRuns = await loadRuns(baselineArg);
const candRuns = await loadRuns(candidateArg);
const everyRun = [...baseRuns, ...candRuns];
const [firstRun] = everyRun;
const total = firstRun?.size ?? 0;
const keys = [...(firstRun?.keys() ?? [])].filter((key) => everyRun.every((run) => run.get(key)?.error === null));
if (keys.length === 0) throw new Error('no case was answered in every run');

const rows = (runs: Map<string, Outcome>[], key: string) => runs.flatMap((run) => run.get(key) ?? []);
const accuracyOf = (run: Map<string, Outcome>) => mean(keys.map((key) => (run.get(key)?.ok ? 1 : 0)));
const baseAccuracies = baseRuns.map(accuracyOf);
const candAccuracies = candRuns.map(accuracyOf);
const baseSpread = Math.max(...baseAccuracies) - Math.min(...baseAccuracies);
const extraRounds = mean(
  keys.map(
    (key) =>
      mean(rows(candRuns, key).map((o) => o.discoverRounds)) - mean(rows(baseRuns, key).map((o) => o.discoverRounds)),
  ),
);
// NaN when a side reported no usage at all, so the comparison below fails instead of passing on a missing number.
const tokensOf = (runs: Map<string, Outcome>[]) => {
  const counts = keys.flatMap((key) =>
    rows(runs, key).flatMap((o) => (o.promptTokens === null ? [] : [o.promptTokens])),
  );
  return counts.length === 0 ? Number.NaN : mean(counts);
};

// Per write tool, so one noisy baseline run that picked a different write tool cannot disarm the check for another.
const picked = (runs: Map<string, Outcome>[], key: string, tool: string) =>
  rows(runs, key).filter((o) => o.ok && o.tools.includes(tool)).length * 2 > runs.length;
const writeRegressions = keys.filter((key) =>
  [...WRITE_TOOLS].some((tool) => picked(baseRuns, key, tool) && !picked(candRuns, key, tool)),
);

const pct = (value: number) => value.toFixed(3);
console.log(
  `compared ${keys.length} of ${total} cases answered in all ${everyRun.length} runs (${baseRuns.length} baseline, ${candRuns.length} candidate)\n` +
    `accuracy per baseline run ${baseAccuracies.map(pct).join(' ')}; per candidate run ${candAccuracies.map(pct).join(' ')}\n` +
    `baseline mean ${pct(mean(baseAccuracies))} (repeat spread ${pct(baseSpread)}), candidate mean ${pct(mean(candAccuracies))}\n` +
    `extra discover rounds per request ${pct(extraRounds)}\n` +
    `first-request prompt tokens baseline ${Math.round(tokensOf(baseRuns))} candidate ${Math.round(tokensOf(candRuns))}`,
);
const checks = [
  { name: 'at least 80% of the cases were answered in every run', ok: keys.length >= total * 0.8 },
  {
    name: 'at least 2 runs per side, so the repeat spread is measured',
    ok: baseRuns.length >= 2 && candRuns.length >= 2,
  },
  {
    name: 'candidate mean accuracy >= baseline mean minus its repeat spread',
    ok: mean(candAccuracies) >= mean(baseAccuracies) - baseSpread,
  },
  {
    name: `extra discover rounds per request <= ${MAX_EXTRA_ROUNDS_PER_REQUEST}`,
    ok: extraRounds <= MAX_EXTRA_ROUNDS_PER_REQUEST,
  },
  { name: 'first-request prompt tokens lower', ok: tokensOf(candRuns) < tokensOf(baseRuns) },
  { name: 'no write-capable row regressed', ok: writeRegressions.length === 0 },
];
for (const check of checks) console.log(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name}`);
for (const key of writeRegressions) console.log(`  write regression: ${key}`);

// Ids shaped `user:case` get a per-user spread, because a corpus is usually dominated by a few users.
const byUser = Map.groupBy(keys, (key) => (key.includes(':') ? key.slice(key.indexOf('/') + 1).split(':')[0] : 'all'));
for (const [user, group] of byUser) {
  const acc = (runs: Map<string, Outcome>[]) =>
    mean(runs.map((run) => mean(group.map((key) => (run.get(key)?.ok ? 1 : 0)))));
  const rounds = mean(
    group.map(
      (key) =>
        mean(rows(candRuns, key).map((o) => o.discoverRounds)) - mean(rows(baseRuns, key).map((o) => o.discoverRounds)),
    ),
  );
  console.log(
    `  ${user} n=${group.length} accuracy ${pct(acc(baseRuns))} -> ${pct(acc(candRuns))}, extra rounds ${pct(rounds)}`,
  );
}
if (checks.some((check) => !check.ok)) process.exitCode = 1;
