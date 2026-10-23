// src/services/ai/role-routing.ts
// Role-based routing: planner, executor and repair each get their own provider chain, behind
// AI_ROUTING=roles. A leaf like provider-ids.ts: it imports no config or client, so the config
// layer (which parses the chains) and the streaming layer (which builds them) can both use it.
//
// A chain entry is `provider` (that provider's ordinary configured model) or `provider:preset`
// (the preset's model on that provider, with the preset's measured settings). An entry naming a
// preset the qualification gate has not admitted for the role is refused when the chain is built,
// so turning roles on can never promote an unmeasured model.

import type { ModelRole } from './model-presets.ts';
import { PROVIDER_IDS, type ProviderId } from './provider-ids.ts';
import type { AiCallPurpose } from './usage-recorder.ts';

export const AI_ROUTING_MODES = ['legacy', 'roles'] as const;
export type AiRoutingMode = (typeof AI_ROUTING_MODES)[number];

export interface RoleChainEntry {
  provider: ProviderId;
  /** Absent: the provider's ordinary configured model, no preset settings. */
  presetId?: string;
}

export type RoleChains = Record<ModelRole, RoleChainEntry[]>;

/** The variable that carries each role's chain. */
export const ROLE_CHAIN_VARIABLES: Record<ModelRole, string> = {
  planner: 'AI_PLANNER_CHAIN',
  executor: 'AI_EXECUTOR_CHAIN',
  repair: 'AI_REPAIR_CHAIN',
};

/**
 * Parses `provider[:preset],...`. A name that is not a known provider is dropped with the reason
 * handed to `onDropped`, like the legacy chain order does, rather than failing the start.
 */
export function parseRoleChain(raw: string | undefined, onDropped: (entry: string) => void): RoleChainEntry[] {
  if (!raw) return [];
  const entries: RoleChainEntry[] = [];
  for (const part of raw.split(',')) {
    const text = part.trim();
    if (!text) continue;
    const [providerName, presetId, ...extra] = text.split(':');
    const provider = PROVIDER_IDS.find((candidate): candidate is ProviderId => candidate === providerName);
    if (!provider || extra.length > 0 || presetId === '') {
      onDropped(text);
      continue;
    }
    const duplicate = entries.some((entry) => entry.provider === provider && entry.presetId === presetId);
    if (!duplicate) entries.push(presetId ? { provider, presetId } : { provider });
  }
  return entries;
}

/**
 * Which role a call plays. Only the agent's own rounds are roles: the main tool loop is the
 * executor, the round that retries after the answer validator rejected a draft is the repair.
 * Nothing calls the planner yet; its chain is accepted so the variable exists before its caller.
 * Summaries, validators, intent learning and the like stay on the legacy fast chain.
 */
export function roleForPurpose(purpose: AiCallPurpose | undefined): ModelRole | null {
  if (purpose === 'agent') return 'executor';
  if (purpose === 'retry') return 'repair';
  return null;
}

export interface RoleRoutingConfig {
  AI_ROUTING: AiRoutingMode;
  /** Canary: roles apply to these users only. Absent: to everyone, once AI_ROUTING is `roles`. */
  AI_ROUTING_USER_IDS?: number[];
}

/** True when this call's role chain, not the legacy chain, serves it. */
export function rolesApplyTo(config: RoleRoutingConfig, userId: number | undefined): boolean {
  if (config.AI_ROUTING !== 'roles') return false;
  if (!config.AI_ROUTING_USER_IDS) return true;
  return userId !== undefined && config.AI_ROUTING_USER_IDS.includes(userId);
}
