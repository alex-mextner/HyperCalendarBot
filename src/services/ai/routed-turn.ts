import type OpenAI from 'openai';
import { z } from 'zod';
import { captureRoutingContext, type RoutingContext } from './routing-context.ts';
import type { createToolCatalog } from './tool-catalog.ts';
import {
  buildRoutingPacket,
  planRoutingContext,
  type planUserTurn,
  type RouterTurn,
  type RoutingState,
} from './turn-routing.ts';

type Catalog = ReturnType<typeof createToolCatalog>;
type Request = Parameters<typeof planUserTurn>[4];
type Planned = Extract<Awaited<ReturnType<typeof planUserTurn>>, { kind: 'plan' }>;
type Plan = Planned['plan'];
/** Per-turn schemas only; exposure is not authorization. Existing handlers must still check access. */
export function createToolSession(
  catalog: Catalog,
  turn: RouterTurn,
  recent: readonly RouterTurn[],
  state: RoutingState,
  signal?: AbortSignal,
) {
  const discovery = buildRoutingPacket(catalog, turn, recent, state).executorTools[0]!;
  if (JSON.stringify([discovery]).length > 26000 || catalog.identifiers().tools.length > 128)
    throw new Error('CATALOG_TOO_LARGE');
  const active = new Map<string, OpenAI.ChatCompletionTool>([['discover_tools', discovery]]);
  const validators = new Map<string, z.ZodType>();
  let rounds = 0;
  return {
    index: catalog.index(),
    exposedNames: () => [...active.keys()],
    schemas: () => structuredClone([...active.values()]),
    discover(input: unknown) {
      signal?.throwIfAborted();
      if (++rounds > 5) return { ok: false as const, error: 'DISCOVERY_BUDGET_EXHAUSTED' };
      const result = catalog.describe(input);
      if (!result.ok) return result;
      const deferred = [...result.deferred];
      const activated: string[] = [];
      for (const tool of result.tools) {
        if (tool.type !== 'function') continue;
        const name = tool.function.name;
        const candidate = new Map(active);
        candidate.set(name, tool);
        if (candidate.size > 33 || JSON.stringify([...candidate.values()]).length > 26000) {
          deferred.push(name);
          continue;
        }
        if (!validators.has(name))
          validators.set(
            name,
            z.fromJSONSchema((tool.function.parameters ?? {}) as Parameters<typeof z.fromJSONSchema>[0]),
          );
        active.set(name, tool);
        activated.push(name);
      }
      return { ok: true as const, activated, unavailable: result.unavailable, deferred };
    },
    async invoke<T>(
      name: string,
      input: Record<string, unknown>,
      handler: (name: string, input: Record<string, unknown>, signal?: AbortSignal) => Promise<T>,
    ) {
      signal?.throwIfAborted();
      if (name === 'discover_tools' || !active.has(name)) throw new Error('TOOL_NOT_EXPOSED');
      const parsed = validators.get(name)?.safeParse(input);
      if (!parsed?.success || !parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data))
        throw new Error('TOOL_ARGUMENTS_INVALID');
      signal?.throwIfAborted();
      return handler(name, parsed.data as Record<string, unknown>, signal);
    },
  };
}
type Session = ReturnType<typeof createToolSession>;
interface RoutedOptions<T> {
  catalog: Catalog;
  turn: RouterTurn;
  recent: readonly RouterTurn[];
  state: RoutingState;
  classify: Request;
  signal?: AbortSignal;
  tryDeterministic?: (
    plan: Plan,
    signal: AbortSignal | undefined,
    context: RoutingContext,
  ) => Promise<{ handled: false } | { handled: true; value: T }>;
  execute: (
    tier: Plan['tier'],
    session: Session,
    plan: Plan,
    signal: AbortSignal | undefined,
    context: RoutingContext,
  ) => Promise<T>;
}
/** Executable orchestration boundary; its bot-ingress wiring is a separate rollout step. */
export async function runRoutedTurn<T>(options: RoutedOptions<T>) {
  const {
    catalog,
    turn: incomingTurn,
    recent: incomingRecent,
    state: incomingState,
    classify,
    signal,
    tryDeterministic,
    execute,
  } = options;
  if ((incomingTurn.kind !== 'message' && incomingTurn.kind !== 'command') || incomingTurn.role === 'assistant')
    return { kind: 'protocol' as const };
  const context = captureRoutingContext(incomingTurn, incomingRecent, incomingState);
  const { turn, recent, state } = context;
  const route = await planRoutingContext(catalog, context, classify, signal);
  if (route.kind === 'protocol') return route;
  signal?.throwIfAborted();
  const repairOpen = state.repairOpen || Object.values(route.plan.signals).some(Boolean);
  if (route.plan.tier !== 'smart' && !route.fallback && tryDeterministic) {
    const result = await tryDeterministic(structuredClone(route.plan), signal, context);
    signal?.throwIfAborted();
    if (result.handled) return { kind: 'deterministic' as const, value: result.value, repairOpen };
  }
  const session = createToolSession(catalog, turn, recent, state, signal);
  const initial = session.discover({ groups: route.plan.groups, tools: route.plan.tools });
  signal?.throwIfAborted();
  const value = await execute(route.plan.tier, session, structuredClone(route.plan), signal, context);
  signal?.throwIfAborted();
  return { kind: 'model' as const, value, tier: route.plan.tier, repairOpen, fallback: route.fallback, initial };
}
