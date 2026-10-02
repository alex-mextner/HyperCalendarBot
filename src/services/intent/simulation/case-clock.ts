// Preload of the intent simulator's child process (`bun --preload <this> scripts/intent-simulate.ts`,
// spawned by ./child.ts with INTENT_SIMULATION_CHILD=1). Executor helpers and tool handlers read
// `Date.now()` / `new Date()` directly, so the child replaces the global Date with one frozen at the
// time `setCaseClock` names: each case runs at its own recorded time whatever the host clock says.
// INTENT_SIM_HOST_NOW fakes the host clock before the first case, which is how tests prove the
// outcome does not depend on it. Imported anywhere else (the flag unset) it changes nothing, and
// `setCaseClock` refuses to run, so the bot process clock is never touched.

const HostDate = globalThis.Date;
let frozen = Number.NaN;
let installed = false;

/** The host Date with every "now" read — `new Date()`, `Date.now()`, `Date()` — answered by the case clock. */
const CaseDate = new Proxy(HostDate, {
  construct: (target, args, newTarget) => Reflect.construct(target, args.length === 0 ? [frozen] : args, newTarget),
  apply: () => new HostDate(frozen).toString(),
  get: (target, property, receiver) => (property === 'now' ? () => frozen : Reflect.get(target, property, receiver)),
});

function install(): void {
  const host = process.env.INTENT_SIM_HOST_NOW;
  frozen = host ? HostDate.parse(host) : HostDate.now();
  if (!Number.isFinite(frozen)) throw new Error(`INTENT_SIM_HOST_NOW is not a time: ${host}`);
  Object.defineProperty(globalThis, 'Date', { value: CaseDate, writable: true, configurable: true });
  installed = true;
}

if (process.env.INTENT_SIMULATION_CHILD === '1') install();

/** Freezes the child's clock at `at` (an ISO instant). */
export function setCaseClock(at: string): void {
  if (!installed) throw new Error('The case clock runs only in the simulator child process');
  const next = HostDate.parse(at);
  if (!Number.isFinite(next)) throw new Error(`Case time is not a time: ${at}`);
  frozen = next;
}
