// What the intent simulator lets a tool do. It runs in a child process (scripts/intent-simulate.ts)
// that calls `sealProcess()` before any case: no network and no helper processes (MTProto bridge,
// voice calls). Tools whose effect reaches another person or an outside service are answered by the
// simulator with `simulation_blocked` and reported; image rendering, which needs a headless browser
// and only delivers to the requester, is stubbed and reported. Everything else runs its real handler
// against the child's in-memory database.

/**
 * Tools that would message or call other people, change someone else's calendar access, or queue
 * work outside the process. Reads such as `find_user` or the Google status run: the sandbox context
 * has no username resolver and no Google repository, so they answer from the database alone.
 */
const BLOCKED_TOOLS = new Set([
  'send_invitation',
  'resend_invitation',
  'cancel_invitation',
  'notify_participants',
  'share_event',
  'share_agenda',
  'propose_edit',
  'propose_calendar_change',
  'manage_secretaries',
  'make_call',
  'end_call',
  'schedule_ai_call',
  'schedule_ai_call_cancel',
  'add_trigger',
  'remove_trigger',
  'send_feedback',
]);
const STUBBED_TOOLS = new Set(['render_day_image', 'render_week_image', 'render_month_image', 'render_table']);

export function sandboxDecision(tool: string): 'blocked' | 'stubbed' | 'run' {
  if (BLOCKED_TOOLS.has(tool)) return 'blocked';
  return STUBBED_TOOLS.has(tool) ? 'stubbed' : 'run';
}

/**
 * Replaces network and process spawning for the rest of this process. Never called by the bot.
 * File access is not sealed: the handlers the simulator reaches open no files beyond the in-memory
 * database they are given, and the child's only output is its stdout.
 */
export function sealProcess(): void {
  globalThis.fetch = Object.assign(
    async (): Promise<Response> => {
      throw new Error('simulation_network_blocked');
    },
    { preconnect: () => {} },
  );
  const refuse = (): never => {
    throw new Error('simulation_spawn_blocked');
  };
  Object.defineProperty(Bun, 'spawn', { value: refuse });
  Object.defineProperty(Bun, 'spawnSync', { value: refuse });
}
