// src/services/calendar/wall-time-adapters.ts
//
// The two future call-site shapes for the shared parser (GH-650): one matching the add
// wizard's existing `WizardDateTimeResult` tagged-union convention (add-event.scene.ts),
// one matching the intent binding's existing accept/reject convention
// (workflow-bindings.ts). Neither is wired into its production call site by this slice —
// GH-652 owns swapping `parseWizardDateTime`/`parseTime` for these once the legacy
// wrapper's compatibility for active sessions is explicitly flag-gated.
//
// Both adapters are thin transforms of one shared `resolve()` call, and `resolve()`
// switches on `WallTimeOutcome['decision']` with a `never`-typed default — so adding a
// new decision to wall-time-parser.ts without updating this file's switch is a compile
// error here, not a silent fallback the way the legacy pair diverged (PR562: bare "2" was
// accepted by the wizard and rejected by the intent path on the same commit).

import { parseWallTimeInput, type Schedule, type WallTimeOutcome } from './wall-time-parser.ts';

export interface WallTimeResolutionContext {
  selectedDate: string;
  timezone: string;
}

type InvalidReason = Extract<WallTimeOutcome, { decision: 'invalid' }>['reason'];

/** Canonical, reason-carrying resolution shared by both adapters; also the wizard's own return shape. */
export type WallTimeResolution =
  | { kind: 'complete'; schedule: Schedule }
  | { kind: 'ambiguous_number' | 'ambiguous_instant'; candidates: readonly [string, string] }
  | { kind: 'clarify'; reason: 'unknown_time_is_not_all_day' }
  | { kind: 'invalid'; reason: InvalidReason }
  | { kind: 'unhandled'; reason: 'not_pending_time' };

function assertNever(value: never): never {
  throw new Error(`Unhandled wall-time decision: ${JSON.stringify(value)}`);
}

function resolve(rawInput: string, ctx: WallTimeResolutionContext): WallTimeResolution {
  const outcome = parseWallTimeInput(rawInput, { ...ctx, pendingField: 'time' });
  switch (outcome.decision) {
    case 'accepted':
      return { kind: 'complete', schedule: outcome.schedule };
    case 'ambiguous':
      return {
        kind: outcome.reason === 'bare_hour' ? 'ambiguous_number' : 'ambiguous_instant',
        candidates: outcome.candidates,
      };
    case 'clarify':
      return { kind: 'clarify', reason: outcome.reason };
    case 'invalid':
      return { kind: 'invalid', reason: outcome.reason };
    // Unreachable in practice — pendingField is hardcoded to 'time' above, so
    // parseWallTimeInput never actually returns 'unhandled' here. Kept so this switch
    // stays exhaustive over the full WallTimeOutcome type rather than narrowing it by hand.
    case 'unhandled':
      return { kind: 'unhandled', reason: outcome.reason };
    default:
      return assertNever(outcome);
  }
}

/** Future v3 boundary for the /add wizard's time step (see WizardDateTimeResult in add-event.scene.ts). */
export function resolveWizardWallTime(rawInput: string, ctx: WallTimeResolutionContext): WallTimeResolution {
  return resolve(rawInput, ctx);
}

export type IntentTimeResolution =
  | { ok: true; schedule: Schedule }
  | { ok: false; resolution: Exclude<WallTimeResolution, { kind: 'complete' }> };

/** Future v3 boundary for the intent `time` binding (see parseTime in workflow-bindings.ts). */
export function resolveIntentWallTime(rawInput: string, ctx: WallTimeResolutionContext): IntentTimeResolution {
  const resolution = resolve(rawInput, ctx);
  return resolution.kind === 'complete' ? { ok: true, schedule: resolution.schedule } : { ok: false, resolution };
}
