// Prints the non-correct dev results (never held-out texts) for rule development.
//   bun --no-env-file scripts/intent-benchmark/explain.ts [--rules current|FILE] [--outcome wrong|missed|false_match|rubric] [--family F] [--limit N] [--history synthetic|real]
import './quiet.ts';
import { parseArgs } from 'node:util';
import { loadHistory, loadRules, runBenchmark } from './benchmark.ts';
import { loadRealHistory } from './real-history.ts';
import { hardFindings } from './rubric.ts';

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    rules: { type: 'string', default: 'current' },
    outcome: { type: 'string', default: 'wrong' },
    family: { type: 'string' },
    limit: { type: 'string', default: '40' },
    history: { type: 'string', default: 'synthetic' },
  },
  strict: true,
});
const run = await runBenchmark(
  { rules: loadRules(values.rules ?? 'current'), label: 'explain', matrixStep: 0, latencyRounds: 0 },
  values.history === 'real' ? loadRealHistory() : loadHistory(),
);
let shown = 0;
for (const result of run.results.dev) {
  const { conversation, verdict } = result;
  const family = conversation.expect.route === 'rule' ? conversation.expect.family : `ai:${conversation.expect.why}`;
  if (values.family && !family.startsWith(values.family)) continue;
  const rubric =
    values.outcome === 'rubric' && verdict.outcome === 'correct' && hardFindings(result.findings).length > 0;
  if (!(rubric || verdict.outcome === values.outcome)) continue;
  if (shown++ >= Number(values.limit)) break;
  const detail = rubric
    ? hardFindings(result.findings)
        .map((f) => `${f.code}: ${f.detail}`)
        .join(' | ')
    : verdict.problems.join(' | ');
  console.log(
    `${result.id} [${family}] "${conversation.say}" rule=${result.ruleName ?? '-'}\n    ${detail}\n    reply: ${(result.turns.at(-1)?.messages.at(-1)?.text ?? '').replace(/\n/g, ' / ').slice(0, 160)}`,
  );
}
