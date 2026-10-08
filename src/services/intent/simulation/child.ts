// Parent side of the simulator: spawns `bun --preload case-clock.ts scripts/intent-simulate.ts`
// with a bounded timeout, sends rules and cases as JSON on stdin and reads the outcomes from one
// marked line on stdout (the child's logger writes to stdout too). The parent process clock, network
// and database are never touched; the child sees only what is sent to it.
import { resolve } from 'node:path';
import { z } from 'zod';
import { jsonCodec } from '../../../utils/json-codec.ts';
import { JsonValueSchema } from '../rule-fingerprint.ts';
import type { CanonicalSeed } from '../seed-replacement.ts';
import type { SimulationCase, SimulationOutcome } from './simulator.ts';

export const RESULT_MARKER = 'INTENT_SIMULATION_RESULT ';
const ROOT = resolve(import.meta.dir, '../../../..');
const PRELOAD = resolve(import.meta.dir, 'case-clock.ts');
const ENTRY = resolve(ROOT, 'scripts/intent-simulate.ts');

const SyntheticEventSchema = z.object({ title: z.string(), start: z.string(), end: z.string().optional() });
const SimulationCaseSchema = z.object({
  caseId: z.string(),
  request: z.string(),
  at: z.string(),
  timezone: z.string(),
  language: z.enum(['ru', 'en']),
  calendar: z.array(SyntheticEventSchema),
});
const RuleSchema = z.object({
  canonical_name: z.string(),
  pattern: z.string(),
  workflow: z.record(z.string(), JsonValueSchema),
  phrases: z.array(z.string()),
  trigger_words: z.array(z.string()),
  source_message: z.string(),
});
export const SimulationInputCodec = jsonCodec(
  z.object({ rules: z.array(RuleSchema), cases: z.array(SimulationCaseSchema) }),
);

const OutcomeSchema = z.object({
  caseId: z.string(),
  routed: z.union([
    z.object({ status: z.literal('matched'), intent: z.string() }),
    z.object({
      status: z.literal('abstained'),
      reason: z.enum(['no_match', 'ambiguous', 'missing_capture', 'input_too_long']),
    }),
  ]),
  handled: z.boolean(),
  tools: z.array(
    z.object({ name: z.string(), success: z.boolean(), afterConfirmation: z.boolean(), write: z.boolean() }),
  ),
  writeOutcome: z.enum(['none', 'applied', 'unknown']),
  askedConfirmation: z.boolean(),
  askedClarification: z.boolean(),
  blockedExternal: z.array(z.string()),
  stubbed: z.array(z.string()),
  reply: z.string().nullable(),
  grounding: z.object({ grounded: z.boolean(), ungrounded: z.array(z.string()) }),
  error: z.string().nullable(),
});
const OutcomesCodec = jsonCodec(z.array(OutcomeSchema));

export async function runSimulationChild(
  input: { rules: readonly CanonicalSeed[]; cases: readonly SimulationCase[] },
  options: { hostNow?: string; timeoutMs: number },
): Promise<SimulationOutcome[]> {
  const env: { [key: string]: string | undefined } = { ...process.env, INTENT_SIMULATION_CHILD: '1' };
  if (options.hostNow) env.INTENT_SIM_HOST_NOW = options.hostNow;
  else delete env.INTENT_SIM_HOST_NOW;
  const child = Bun.spawn([process.execPath, '--preload', PRELOAD, ENTRY], {
    cwd: ROOT,
    env,
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, options.timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (timedOut) throw new Error(`Intent simulation timed out after ${options.timeoutMs} ms`);
    const line = stdout.split('\n').findLast((text) => text.startsWith(RESULT_MARKER));
    if (code !== 0 || line === undefined)
      throw new Error(`Intent simulation failed (exit ${code}): ${stderr.slice(-2000)}`);
    return OutcomesCodec.parse(line.slice(RESULT_MARKER.length));
  } finally {
    clearTimeout(timer);
  }
}
