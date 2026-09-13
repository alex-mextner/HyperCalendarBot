import type { RouterTurn, RoutingState } from './turn-routing.ts';
export interface RoutingContext {
  readonly turn: Readonly<RouterTurn>;
  readonly recent: readonly Readonly<RouterTurn>[];
  readonly state: Readonly<RoutingState>;
  readonly omittedHistory: number;
}
/** Snapshot only bounded, allowlisted fields. Strings are immutable; no full-history deep clone. */
export function captureRoutingContext(
  turn: RouterTurn,
  recent: readonly RouterTurn[],
  state: RoutingState,
): RoutingContext {
  if (turn.text.length > 131072) throw new Error('REQUEST_TOO_LARGE');
  const copyTurn = (t: RouterTurn) => Object.freeze({ id: t.id, kind: t.kind, text: t.text, role: t.role });
  const visible: Readonly<RouterTurn>[] = [];
  for (let i = recent.length - 1; i >= Math.max(0, recent.length - 64) && visible.length < 6; i--) {
    const t = recent[i]!;
    if (t.kind === 'message' || t.kind === 'command') visible.unshift(copyTurn(t));
  }
  const pending = state.pendingRequests ?? [],
    completed = state.completedActions ?? [];
  const capturedState = Object.freeze({
    repairOpen: state.repairOpen,
    nowIso: state.nowIso,
    timezone: state.timezone,
    actorId: state.actorId,
    chatId: state.chatId,
    scope: state.scope,
    pendingRequests: Object.freeze(pending.slice(-12).map((r) => Object.freeze({ id: r.id, summary: r.summary }))),
    completedActions: Object.freeze(
      completed.slice(-20).map((r) => Object.freeze({ id: r.id, tool: r.tool, outcome: r.outcome })),
    ),
    omittedPending: (state.omittedPending ?? 0) + Math.max(0, pending.length - 12),
    omittedCompleted: (state.omittedCompleted ?? 0) + Math.max(0, completed.length - 20),
  });
  return Object.freeze({
    turn: copyTurn(turn),
    recent: Object.freeze(visible),
    state: capturedState,
    omittedHistory: Math.max(0, recent.length - visible.length),
  });
}
