import type { RoutingRepairStore } from './routing-repair-store.ts';
import type { createToolCatalog } from './tool-catalog.ts';
import type { RoutingPacketRequest } from './turn-routing.ts';
import { planUserTurn, type RouterTurn } from './turn-routing.ts';

type Catalog = ReturnType<typeof createToolCatalog>;
type Classifier = (packet: RoutingPacketRequest, signal: AbortSignal) => Promise<string>;

export interface ConversationRouteInput {
  catalog: Catalog;
  classify: Classifier;
  repairStore: RoutingRepairStore;
  chatId: number;
  userId: number;
  timezone: string;
  scope: 'private' | 'group';
  turn: RouterTurn;
  recent: readonly RouterTurn[];
  signal?: AbortSignal;
  deadlineMs?: number;
}

/** Stateful wrapper around the pure planner. It never executes business tools. */
export async function classifyConversationTurn(input: ConversationRouteInput) {
  const repairOpen = await input.repairStore.isOpen(input.chatId, input.userId);
  const route = await planUserTurn(
    input.catalog,
    input.turn,
    input.recent,
    {
      repairOpen,
      nowIso: new Date().toISOString(),
      timezone: input.timezone,
      actorId: String(input.userId),
      chatId: String(input.chatId),
      scope: input.scope,
    },
    input.classify,
    input.signal,
    input.deadlineMs,
  );
  if (route.kind === 'protocol') return route;
  const signalledRepair = Object.values(route.plan.signals).some(Boolean);
  if (repairOpen || signalledRepair) await input.repairStore.open(input.chatId, input.userId);
  return {
    ...route,
    repairOpen: repairOpen || signalledRepair,
    allowDeterministic: route.plan.tier !== 'smart' && !route.fallback,
  };
}
