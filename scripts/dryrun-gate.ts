/**
 * Acceptance gate for a tool schema mode: compares two saved dry-run outcomes of the same cases
 * (`DRYRUN_OUT` of scripts/dryrun-tool-selection.ts, one run per `DRYRUN_TOOL_MODE`).
 *
 *   bun scripts/dryrun-gate.ts full.json hybrid.json
 *
 * Passes only when, over the cases the provider answered in both runs (a timeout says nothing about
 * tool choice, so those are left out and counted):
 *   - selection accuracy of the candidate is at least the baseline's,
 *   - the candidate needs at most 0.1 more discover_tools rounds per request,
 *   - its first request carries fewer prompt tokens on average.
 */
import { z } from 'zod';

const MAX_EXTRA_ROUNDS_PER_REQUEST = 0.1;

const outcomeSchema = z.object({
  id: z.string(),
  provider: z.string(),
  error: z.string().nullable(),
  ok: z.boolean(),
  promptTokens: z.number().nullable(),
  discoverRounds: z.number(),
});
type Outcome = z.infer<typeof outcomeSchema>;

async function load(path: string): Promise<Outcome[]> {
  return z.array(outcomeSchema).parse(await Bun.file(path).json());
}

const keyOf = (outcome: Outcome) => `${outcome.provider}/${outcome.id}`;

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

const [basePath, candidatePath] = process.argv.slice(2);
if (!basePath || !candidatePath) throw new Error('usage: bun scripts/dryrun-gate.ts <baseline.json> <candidate.json>');

const base = new Map((await load(basePath)).filter((o) => o.error === null).map((o) => [keyOf(o), o]));
const candidates = await load(candidatePath);
const pairs = candidates.flatMap((candidate) => {
  const baseline = candidate.error === null ? base.get(keyOf(candidate)) : undefined;
  return baseline ? [{ baseline, candidate }] : [];
});
if (pairs.length === 0) throw new Error('no case was answered in both runs');

const accuracy = (side: 'baseline' | 'candidate') => pairs.filter((pair) => pair[side].ok).length / pairs.length;
const extraRounds = mean(pairs.map((pair) => pair.candidate.discoverRounds - pair.baseline.discoverRounds));
// NaN when a side reported no usage at all, so the comparison below fails instead of passing on a missing number.
const tokens = (side: 'baseline' | 'candidate') => {
  const counts = pairs.flatMap((pair) => (pair[side].promptTokens === null ? [] : [pair[side].promptTokens]));
  return counts.length === 0 ? Number.NaN : mean(counts);
};

const checks = [
  {
    name: 'at least 80% of the candidate cases were answered in both runs',
    ok: pairs.length >= candidates.length * 0.8,
  },
  { name: 'selection accuracy >= baseline', ok: accuracy('candidate') >= accuracy('baseline') },
  {
    name: `extra discover rounds per request <= ${MAX_EXTRA_ROUNDS_PER_REQUEST}`,
    ok: extraRounds <= MAX_EXTRA_ROUNDS_PER_REQUEST,
  },
  { name: 'first-request prompt tokens lower', ok: tokens('candidate') < tokens('baseline') },
];

console.log(
  `compared ${pairs.length} of ${candidates.length} cases (others were not answered in both runs)\n` +
    `accuracy baseline ${accuracy('baseline').toFixed(3)} candidate ${accuracy('candidate').toFixed(3)}\n` +
    `extra discover rounds per request ${extraRounds.toFixed(3)}\n` +
    `first-request prompt tokens baseline ${Math.round(tokens('baseline'))} candidate ${Math.round(tokens('candidate'))}`,
);
for (const check of checks) console.log(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name}`);
if (checks.some((check) => !check.ok)) process.exitCode = 1;
