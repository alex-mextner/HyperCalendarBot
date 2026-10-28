// Child process of the intent simulator. Never run directly: src/services/intent/simulation/child.ts
// spawns it as `bun --preload src/services/intent/simulation/case-clock.ts scripts/intent-simulate.ts`
// with INTENT_SIMULATION_CHILD=1, writes `{ rules, cases }` on stdin and reads one marked result line
// from stdout. Network and process spawning are sealed before any case runs; the only database is
// in memory.
import { RESULT_MARKER, SimulationInputCodec } from '../src/services/intent/simulation/child.ts';
import { sealProcess } from '../src/services/intent/simulation/sandbox.ts';
import { simulateCases } from '../src/services/intent/simulation/simulator.ts';

if (process.env.INTENT_SIMULATION_CHILD !== '1') {
  console.error('scripts/intent-simulate.ts runs only as the simulator child process (see simulation/child.ts)');
  process.exit(2);
}
sealProcess();
const input = SimulationInputCodec.parse(await Bun.stdin.text());
const outcomes = await simulateCases(input.rules, input.cases);
await Bun.write(Bun.stdout, `\n${RESULT_MARKER}${JSON.stringify(outcomes)}\n`);
process.exit(0);
