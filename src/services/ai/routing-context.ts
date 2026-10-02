// src/services/ai/routing-context.ts
//
// Immutable snapshot of one classification request. Captured BEFORE the async
// classifier call so a concurrent turn on the same chat cannot mutate the
// evidence or lower a repair floor already committed to this in-flight call.
// Adapted from the routing-context.ts prototype on
// origin/feat/inference-three-tiers-integrated-20260913 (PR #267); the shape
// is unchanged, only the source file location and doc comments.

import type { RouterTurn, RoutingState } from './turn-routing.ts';

export interface RoutingContext {
  readonly turn: Readonly<RouterTurn>;
  readonly recent: readonly Readonly<RouterTurn>[];
  readonly state: Readonly<RoutingState>;
  /** Turns dropped from `recent` by the bounded window, for transparency in the packet. */
  readonly omittedHistory: number;
}

const MAX_SCAN_WINDOW = 64;
const MAX_VISIBLE_TURNS = 6;
const MAX_PENDING = 12;
const MAX_COMPLETED = 20;
const MAX_TURN_TEXT_CHARS = 131_072;

/** Snapshot only bounded, allowlisted fields. Strings are immutable; no full-history deep clone. */
export function captureRoutingContext(
  turn: RouterTurn,
  recent: readonly RouterTurn[],
  state: RoutingState,
): RoutingContext {
  if (turn.text.length > MAX_TURN_TEXT_CHARS) throw new Error('REQUEST_TOO_LARGE');
  const copyTurn = (t: RouterTurn): Readonly<RouterTurn> =>
    Object.freeze({ id: t.id, kind: t.kind, text: t.text, role: t.role });

  const visible: Readonly<RouterTurn>[] = [];
  for (
    let i = recent.length - 1;
    i >= Math.max(0, recent.length - MAX_SCAN_WINDOW) && visible.length < MAX_VISIBLE_TURNS;
    i--
  ) {
    const candidate = recent[i]!;
    if (candidate.kind === 'message' || candidate.kind === 'command') visible.unshift(copyTurn(candidate));
  }

  const pending = state.pendingRequests ?? [];
  const completed = state.completedActions ?? [];
  const capturedState: Readonly<RoutingState> = Object.freeze({
    repairOpen: state.repairOpen,
    nowIso: state.nowIso,
    timezone: state.timezone,
    actorId: state.actorId,
    chatId: state.chatId,
    scope: state.scope,
    pendingRequests: Object.freeze(
      pending.slice(-MAX_PENDING).map((r) => Object.freeze({ id: r.id, summary: r.summary })),
    ),
    completedActions: Object.freeze(
      completed.slice(-MAX_COMPLETED).map((r) => Object.freeze({ id: r.id, tool: r.tool, outcome: r.outcome })),
    ),
    omittedPending: (state.omittedPending ?? 0) + Math.max(0, pending.length - MAX_PENDING),
    omittedCompleted: (state.omittedCompleted ?? 0) + Math.max(0, completed.length - MAX_COMPLETED),
  });

  return Object.freeze({
    turn: copyTurn(turn),
    recent: Object.freeze(visible),
    state: capturedState,
    omittedHistory: Math.max(0, recent.length - visible.length),
  });
}
