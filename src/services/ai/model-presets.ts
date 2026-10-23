// src/services/ai/model-presets.ts
// The single table of model presets: which model id serves a preset on which provider, with what
// effort/sampling, what it costs, which roles it may take, and whether a measurement ever admitted it.
//
// A preset is a model PLUS the settings it was measured with. `glm53-flash-low` is GLM 5.3 Flash at
// low effort, temperature 1: the same id at another effort is a different, unmeasured model.
//
// Nothing here changes routing by itself. Chains still name providers. Role routing (AI_ROUTING=roles,
// added after this table) will read it and refuse a preset the gate below has not admitted.

import type { ProviderId } from './provider-ids.ts';

export const MODEL_ROLES = ['planner', 'executor', 'repair'] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high';

/** USD per million tokens as published by `source` on `asOf`. Billed cost may differ; prefer a reported cost. */
export interface TokenPrice {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  /** ISO date (YYYY-MM-DD) the price was read. */
  asOf: string;
  source: string;
}

/** What a qualification run measured, kept next to the preset it admits. */
export interface Qualification {
  /** Source revision of the harness and fixtures the run used. */
  sha: string;
  /** ISO date of the run. */
  measuredAt: string;
  /** Own-role task correctness, 0..1, per role the run covered. */
  rolePass: Partial<Record<ModelRole, number>>;
  /** Pass rate on the full labelled history, 0..1; null when no history run exists. */
  historyPass: number | null;
}

export interface ModelPreset {
  id: string;
  /** The model id to send, per provider that can serve this preset. */
  models: Partial<Record<ProviderId, string>>;
  effort?: ReasoningEffort;
  temperature?: number;
  maxOutputTokens?: number;
  /** Per provider: the same model costs different amounts on different hosts. Absent means unknown. */
  prices: Partial<Record<ProviderId, TokenPrice>>;
  /** Roles the preset may be measured for; admission still needs a qualification per provider and role. */
  roles: readonly ModelRole[];
  /** The measurement that admitted this preset, per provider it was measured through. Empty: none yet. */
  qualifications: Partial<Record<ProviderId, Qualification>>;
}

/** Own-role task correctness a preset needs before it may take that role. */
export const ROLE_PASS_MIN = 0.95;
/** Share of the full labelled history that must pass: every case. */
export const HISTORY_PASS_REQUIRED = 1;

const OPENROUTER_PRICE_SOURCE = 'OpenRouter /models list price; billed cost can differ, a reported usage.cost wins';

/**
 * Seeded from the 2026-09-27 benchmark (PR #429) and the OpenRouter model ids verified on 2026-10-23.
 * No preset is qualified: the benchmark was through another host, on reconstructed scenarios.
 */
export const MODEL_PRESETS: readonly ModelPreset[] = [
  {
    id: 'deepseek41-flash',
    models: { openrouter: 'deepseek/deepseek-v4.1-flash' },
    prices: {
      openrouter: {
        inputUsdPerMTok: 0.3,
        outputUsdPerMTok: 1.2,
        asOf: '2026-10-23',
        source: OPENROUTER_PRICE_SOURCE,
      },
    },
    roles: ['planner', 'executor'],
    qualifications: {},
  },
  {
    id: 'glm53-flash-low',
    models: { zai: 'glm-5.3-flash', openrouter: 'z-ai/glm-5.3-flash' },
    effort: 'low',
    temperature: 1,
    maxOutputTokens: 8192,
    prices: {
      openrouter: {
        inputUsdPerMTok: 0.0052,
        outputUsdPerMTok: 0.1985,
        asOf: '2026-10-23',
        source: OPENROUTER_PRICE_SOURCE,
      },
    },
    roles: ['planner', 'executor'],
    qualifications: {},
  },
  {
    id: 'glm53-low',
    models: { zai: 'glm-5.3', openrouter: 'z-ai/glm-5.3' },
    effort: 'low',
    prices: {
      openrouter: {
        inputUsdPerMTok: 0.079,
        outputUsdPerMTok: 1.4,
        asOf: '2026-10-23',
        source: OPENROUTER_PRICE_SOURCE,
      },
    },
    roles: ['repair'],
    qualifications: {},
  },
  {
    id: 'haiku',
    models: { claude: 'claude-haiku-5-5' },
    prices: {},
    roles: ['planner', 'executor'],
    qualifications: {},
  },
];

export function presetById(id: string): ModelPreset | null {
  return MODEL_PRESETS.find((preset) => preset.id === id) ?? null;
}

interface ExcludedModel {
  pattern: RegExp;
  reason: string;
}

/**
 * Models that must never serve a request, whatever `.env`, a preset or live-model discovery says.
 * Owner decisions of 2026-09-27: GPT-OSS is out of every role (7/16 strict on the real scenarios,
 * and Together's 120b answered 400 to a tool transcript), and a small Qwen gets no write rights
 * (it invented numeric ids and was four hours off on time zones).
 */
const EXCLUDED_MODELS: readonly ExcludedModel[] = [
  { pattern: /gpt-oss/i, reason: 'GPT-OSS is excluded by owner decision (2026-09-27)' },
  { pattern: /qwen3\.8-27b/i, reason: 'small Qwen invented ids and mis-set time zones (2026-09-27)' },
];

/** Why a model id must never be used, or null when it may be. */
export function excludedModelReason(model: string): string | null {
  return EXCLUDED_MODELS.find(({ pattern }) => pattern.test(model))?.reason ?? null;
}

/**
 * True when the preset was measured for `role` THROUGH `provider` at or above both thresholds. A model
 * measured on one host says nothing about another: the effort control, the upstream and the limits differ,
 * so z.ai serving a preset that was qualified through OpenRouter is a different, unmeasured route.
 */
export function isQualifiedFor(preset: ModelPreset, role: ModelRole, provider: ProviderId): boolean {
  const qualification = preset.qualifications[provider];
  if (!qualification || !preset.models[provider] || !preset.roles.includes(role)) return false;
  const rolePass = qualification.rolePass[role];
  // Positive tests: a NaN score (0 cases / 0) must not pass because `NaN < x` is false.
  if (rolePass === undefined || !Number.isFinite(rolePass) || !(rolePass >= ROLE_PASS_MIN)) return false;
  const { historyPass } = qualification;
  return historyPass !== null && Number.isFinite(historyPass) && historyPass >= HISTORY_PASS_REQUIRED;
}

/** Micro-USD in one USD: the unit of `ai_usage_events.cost_micro_usd`. */
export const MICRO_USD_PER_USD = 1_000_000;

/**
 * Cost in micro-USD (1e-6 USD) of one attempt from the dated list price of the preset that names this
 * provider and model: tokens times the per-million price. Used only when the provider reported no cost
 * itself. `null` is unknown, never zero: no price for the route, or a token count the provider did not
 * report. List price without cache discounts, so an upper bound.
 */
export function estimateCostMicroUsd(
  provider: ProviderId,
  model: string,
  promptTokens: number | null,
  completionTokens: number | null,
  presets: readonly ModelPreset[] = MODEL_PRESETS,
): number | null {
  if (promptTokens === null || completionTokens === null) return null;
  const price = presets.find((preset) => preset.models[provider] === model)?.prices[provider];
  if (!price) return null;
  const cost = Math.round(promptTokens * price.inputUsdPerMTok + completionTokens * price.outputUsdPerMTok);
  return Number.isSafeInteger(cost) && cost >= 0 ? cost : null;
}

/**
 * Request fields a preset's effort needs on `provider`. OpenRouter's `reasoning.effort` was verified
 * live on 2026-10-23; the other providers' controls were not, so they get nothing instead of a guess.
 */
export function presetRequestFields(
  provider: ProviderId,
  preset: ModelPreset,
): { reasoning?: { effort: ReasoningEffort } } {
  if (provider === 'openrouter' && preset.effort) return { reasoning: { effort: preset.effort } };
  return {};
}
