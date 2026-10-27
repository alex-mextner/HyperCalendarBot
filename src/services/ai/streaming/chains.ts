// src/services/ai/streaming/chains.ts
// Builds the ordered provider slots a round walks: the legacy smart/fast chains and the per-role chains,
// with the circuit keys that scope each slot's durable failure state to its account (and, for OpenRouter, model).

import type { ChainOrder, EnvConfig } from '../../../config/env.ts';
import type { ProviderChainKind } from '../../../utils/ai-provider-alert.ts';
import { logOnce } from '../../../utils/logger.ts';
import { claudeClient, hfClient, openrouterClient, zaiClient } from '../clients.ts';
import { excludedModelReason, isQualifiedFor, type ModelRole, presetById } from '../model-presets.ts';
import { providerCircuitKey } from '../provider-circuit.ts';
import type { BenchChain } from '../provider-eligibility.ts';
import type { ProviderId } from '../provider-ids.ts';
import { aiLogger } from './logger.ts';
import { type ProviderSlot, streamingSlot } from './slot.ts';

/**
 * The client factory each slot uses, behind one indirection.
 *
 * This exists so tests can substitute fake providers by assigning to this
 * object rather than replacing the whole clients module. `mock.module` is
 * process-global and outlives the file that calls it, so a test that mocked
 * `clients.ts` handed its fakes to whatever test file bun happened to load
 * next — which broke `clients.test.ts` on Linux and not on macOS, purely
 * because directory order differs between the two filesystems.
 */
export const providerClients = {
  zai: zaiClient,
  hf: hfClient,
  claude: claudeClient,
  openrouter: openrouterClient,
};

const PROVIDER_LABELS: Record<ProviderId, string> = {
  zai: 'z.ai',
  hf: 'HF',
  claude: 'Claude',
  openrouter: 'OpenRouter',
};

/**
 * What a provider needs before it can be put in a chain. `model` and `apiKey` are
 * optional in the type because Claude's are: loadConfig requires the z.ai and Hugging
 * Face credentials and models at startup, so for those two the check always
 * passes. Live-model discovery does not change that — it replaces a configured
 * model that turned out to be dead, and has nothing to start from without one.
 */
interface ProviderAvailability {
  model?: string;
  apiKey?: string;
  /** Part of the account fingerprint; absent when the client hardcodes the endpoint. */
  baseUrl?: string;
}

/**
 * Builds one chain in the configured order, skipping any provider whose key or
 * model is missing. Order is configuration rather than code because the reason
 * to change it arrives as an incident: a provider that answers 429 all week, or
 * one whose tier rejects a request this size on every single call. Both happened
 * on 2026-09-02, and both were a one-line change away from being routed around.
 *
 * An order that names only providers which turn out to be unconfigured would
 * leave the bot with nothing to answer with — worse than ignoring the order — so
 * that case falls back to every provider that IS configured, and says so loudly.
 */
function buildChain(
  kind: ProviderChainKind,
  chain: ChainOrder,
  available: Record<ProviderId, ProviderAvailability>,
): ProviderSlot[] {
  const { order, fallback: fallbackOrder } = chain;
  // An optional provider missing from the DEFAULT order is the documented
  // minimal deployment, not a mistake — Claude is in both defaults and plenty of
  // installations have no Claude key. Only a provider the operator named
  // themselves is worth a warning, and the config says which case this is
  // rather than the code guessing from array identity.
  const wasChosen = chain.fromEnv;
  const slotsFor = (ids: readonly ProviderId[]): ProviderSlot[] => {
    const chain: ProviderSlot[] = [];
    for (const provider of ids) {
      const { model, apiKey, baseUrl } = available[provider];
      if (!model || !apiKey) {
        logOnce(`skip:${kind}:${provider}:${!!model}:${!!apiKey}`, () => {
          const detail = { chain: kind, provider, hasModel: !!model, hasKey: !!apiKey };
          if (wasChosen) aiLogger.warn(detail, 'Provider named in the chain order is not configured — skipping it');
          else aiLogger.debug(detail, 'Optional provider in the default chain order is not configured — skipping it');
        });
        continue;
      }
      const excludedReason = excludedModelReason(model);
      if (excludedReason) {
        logOnce(`excluded:${kind}:${provider}:${model}`, () =>
          aiLogger.error(
            { chain: kind, provider, model },
            `Configured model is on the excluded list (${excludedReason}) — skipping it`,
          ),
        );
        continue;
      }
      chain.push({
        ...streamingSlot(
          PROVIDER_LABELS[provider],
          provider,
          providerClients[provider],
          model,
          slotCircuitKey(provider, baseUrl ?? '', apiKey, model),
        ),
        ...accountCircuitKeyFor(provider, baseUrl ?? '', apiKey),
      });
    }
    return chain;
  };

  const configured = slotsFor(order);
  if (configured.length > 0) return configured;

  // The fallback walks the default order rather than the declaration order of
  // the provider ids, so the preference this code is built around survives the
  // one path where the configured order could not be honoured.
  const fallback = slotsFor(fallbackOrder);
  if (fallback.length === 0) {
    // Not reachable today — loadConfig requires the z.ai and HF credentials and
    // refuses to start without them, so at least two providers always have both.
    // Kept because that is a startup rule, not an invariant of this function,
    // and an empty chain fails every request.
    logOnce(`none:${kind}:${order.join(',')}`, () =>
      aiLogger.error(
        { chain: kind, order },
        'No provider is configured with both a key and a model — every AI request will fail',
      ),
    );
    return fallback;
  }
  logOnce(`fallback:${kind}:${order.join(',')}`, () =>
    aiLogger.error(
      { chain: kind, order, usable: fallback.map((slot) => slot.provider) },
      'Configured provider order named nothing that is configured — falling back to the default order',
    ),
  );
  return fallback;
}

/**
 * OpenRouter routes every model to a different upstream, so a rate limit or outage of one model is
 * not a statement about the others: the circuit is scoped to the key AND the model. Exported so
 * the circuit-state script fingerprints the same account.
 */
export function openrouterCircuitScope(baseUrl: string, model: string | undefined): string {
  return `${baseUrl}#${model ?? ''}`;
}

/** The circuit key of one slot: per model for OpenRouter (see above), one per account for every other provider. */
function slotCircuitKey(provider: ProviderId, baseUrl: string, apiKey: string, model: string): string {
  return provider === 'openrouter'
    ? providerCircuitKey(provider, openrouterCircuitScope(baseUrl, model), apiKey)
    : providerCircuitKey(provider, baseUrl, apiKey);
}

/**
 * OpenRouter's whole-key circuit: a revoked or empty key is one incident for every model behind it, while
 * rate limits and outages stay on the per-model circuit.
 */
function accountCircuitKeyFor(provider: ProviderId, baseUrl: string, apiKey: string): { accountCircuitKey?: string } {
  return provider === 'openrouter' ? { accountCircuitKey: providerCircuitKey(provider, baseUrl, apiKey) } : {};
}

export function buildSmartChain(cfg: EnvConfig): ProviderSlot[] {
  return buildChain('smart', cfg.AI_SMART_CHAIN, {
    zai: { model: cfg.ZAI_MODEL, apiKey: cfg.ZAI_API_KEY, baseUrl: cfg.ZAI_BASE_URL },
    hf: { model: cfg.HF_MODEL, apiKey: cfg.HF_TOKEN, baseUrl: cfg.HF_BASE_URL },
    claude: { model: cfg.CLAUDE_MODEL, apiKey: cfg.CLAUDE_API_TOKEN },
    openrouter: {
      model: cfg.OPENROUTER_MODEL,
      apiKey: cfg.OPENROUTER_API_KEY,
      baseUrl: cfg.OPENROUTER_BASE_URL,
    },
  });
}

export function buildFastChain(cfg: EnvConfig): ProviderSlot[] {
  return buildChain('fast', cfg.AI_FAST_CHAIN, {
    zai: { model: cfg.ZAI_FAST_MODEL, apiKey: cfg.ZAI_API_KEY, baseUrl: cfg.ZAI_BASE_URL },
    hf: { model: cfg.HF_FAST_MODEL, apiKey: cfg.HF_TOKEN, baseUrl: cfg.HF_BASE_URL },
    claude: { model: cfg.CLAUDE_FAST_MODEL, apiKey: cfg.CLAUDE_API_TOKEN },
    openrouter: {
      model: cfg.OPENROUTER_FAST_MODEL,
      apiKey: cfg.OPENROUTER_API_KEY,
      baseUrl: cfg.OPENROUTER_BASE_URL,
    },
  });
}

/** Test seam: which preset table role chains read. */
export const roleRoutingSeams = { presetById };

function providerAccount(cfg: EnvConfig, provider: ProviderId): { apiKey?: string; baseUrl?: string; model?: string } {
  switch (provider) {
    case 'zai':
      return { apiKey: cfg.ZAI_API_KEY, baseUrl: cfg.ZAI_BASE_URL, model: cfg.ZAI_MODEL };
    case 'hf':
      return { apiKey: cfg.HF_TOKEN, baseUrl: cfg.HF_BASE_URL, model: cfg.HF_MODEL };
    case 'claude':
      return { apiKey: cfg.CLAUDE_API_TOKEN, model: cfg.CLAUDE_MODEL };
    case 'openrouter':
      return { apiKey: cfg.OPENROUTER_API_KEY, baseUrl: cfg.OPENROUTER_BASE_URL, model: cfg.OPENROUTER_MODEL };
  }
}

/**
 * One role's chain. An entry is `provider` (its ordinary model) or `provider:preset`. A preset entry
 * loads only when the preset names a model for that provider, the model is not excluded, the provider
 * has a key, and the preset is qualified for this role: roles can never promote an unmeasured model.
 * An unusable entry is skipped with an error log, never silently.
 */
export function buildRoleChain(role: ModelRole, cfg: EnvConfig): ProviderSlot[] {
  const slots: ProviderSlot[] = [];
  for (const entry of cfg.AI_ROLE_CHAINS[role]) {
    const account = providerAccount(cfg, entry.provider);
    const preset = entry.presetId ? roleRoutingSeams.presetById(entry.presetId) : null;
    const model = entry.presetId ? preset?.models[entry.provider] : account.model;
    const refusal = (() => {
      if (entry.presetId && !preset) return 'unknown preset';
      if (preset && !isQualifiedFor(preset, role, entry.provider)) return 'preset is not qualified for this role here';
      if (!model) return 'no model for this provider';
      if (!account.apiKey) return 'provider has no key';
      return excludedModelReason(model);
    })();
    if (refusal || !model || !account.apiKey) {
      logOnce(`role-skip:${role}:${entry.provider}:${entry.presetId ?? ''}:${refusal}`, () =>
        aiLogger.error(
          { role, provider: entry.provider, preset: entry.presetId },
          `Role chain entry skipped: ${refusal}`,
        ),
      );
      continue;
    }
    const slot = streamingSlot(
      PROVIDER_LABELS[entry.provider],
      entry.provider,
      providerClients[entry.provider],
      model,
      slotCircuitKey(entry.provider, account.baseUrl ?? '', account.apiKey, model),
      preset ?? undefined,
    );
    slots.push({
      ...slot,
      role,
      ...accountCircuitKeyFor(entry.provider, account.baseUrl ?? '', account.apiKey),
    });
  }
  return slots;
}

/**
 * What a provider bench is scoped to for this slot: the legacy chain it serves, or its role and model.
 * A role slot never shares a bench with the legacy chains, nor with another role or model.
 */
export function benchChainOf(slot: ProviderSlot, kind: ProviderChainKind): BenchChain {
  return slot.role ? `role:${slot.role}:${slot.configuredModel}` : kind;
}

/**
 * The slots of `legacy` that no plain slot of `tried` already asked the same way: a second identical ask fails
 * the same way. A preset slot asks differently (its own settings, its model never replaced), so the plain
 * legacy slot with that model stays: it may fit a request the preset's settings did not, and it can still
 * find a live replacement for a model that is gone.
 */
export function withoutModelsOf(tried: readonly ProviderSlot[], legacy: readonly ProviderSlot[]): ProviderSlot[] {
  const asked = new Set(
    tried.filter((slot) => slot.presetId === undefined).map((slot) => `${slot.provider}\0${slot.configuredModel}`),
  );
  return legacy.filter((slot) => !asked.has(`${slot.provider}\0${slot.configuredModel}`));
}
