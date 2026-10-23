// scripts/model-quality/models.ts
// The routes the qualification run measures. A candidate is a registry preset on one provider, so the
// model id, effort, temperature and price come from src/services/ai/model-presets.ts: the harness cannot
// measure a model the bot would not run, and cannot drift from the registry.

import { DEFAULT_OPENROUTER_BASE_URL } from '../../src/config/env.ts';
import { type ModelPreset, presetById, type TokenPrice } from '../../src/services/ai/model-presets.ts';
import type { ProviderId } from '../../src/services/ai/provider-ids.ts';

export interface Candidate {
  preset: ModelPreset;
  provider: ProviderId;
  model: string;
  /** Environment variable that holds this route's credential; never printed or stored. */
  keyEnv: string;
  baseURL: string;
  price: TokenPrice;
}

/**
 * List prices for routes the registry carries no price for (it leaves Claude's NULL so the ledger
 * never invents a cost). Used only to estimate a measured cost, with its source and date.
 */
const CLAUDE_LIST_PRICES: Record<string, TokenPrice> = {
  'claude-haiku-5-5': {
    inputUsdPerMTok: 0.1,
    outputUsdPerMTok: 0.5,
    asOf: '2026-10-23',
    source: 'https://platform.claude.com/docs/en/about-claude/pricing (Claude Haiku 5.5, prompts up to 100,000 tokens)',
  },
};

const ROUTES: Partial<Record<ProviderId, { keyEnv: string; baseURL: string }>> = {
  openrouter: { keyEnv: 'OPENROUTER_API_KEY', baseURL: DEFAULT_OPENROUTER_BASE_URL },
  claude: { keyEnv: 'CLAUDE_API_TOKEN', baseURL: 'https://api.anthropic.com/v1/' },
};

export function candidateFor(presetId: string, provider: ProviderId): Candidate {
  const preset = presetById(presetId);
  if (!preset) throw new Error(`Unknown preset ${presetId}`);
  const model = preset.models[provider];
  if (!model) throw new Error(`Preset ${presetId} has no model on ${provider}`);
  const route = ROUTES[provider];
  if (!route) throw new Error(`No measured route for provider ${provider}`);
  const price = preset.prices[provider] ?? CLAUDE_LIST_PRICES[model];
  if (!price) throw new Error(`No dated list price for ${presetId} on ${provider}`);
  return { preset, provider, model, ...route, price };
}

/** The owner-named set for the B5 run. Order is the run order. */
export const QUALIFICATION_TARGETS: Candidate[] = [
  candidateFor('deepseek41-flash', 'openrouter'),
  candidateFor('glm53-flash-low', 'openrouter'),
  candidateFor('haiku', 'claude'),
];

export function candidateId(candidate: Candidate): string {
  return `${candidate.preset.id}@${candidate.provider}`;
}
