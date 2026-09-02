// src/services/ai/model-registry.ts
// Live-model discovery for the AI provider chain.
//
// Providers delete models without notice (Groq removed `llama-3.3-70b-versatile`
// and `llama-3.1-8b-instant` on 2026-09-01, which returned 404 for every request).
// When that happens the bot must not stay dead until a human edits `.env`: it
// probes the provider's OpenAI-compatible `GET /v1/models` endpoint once, picks a
// live replacement by a deterministic, explainable rule, and caches the override
// in memory. Nothing here ever mutates `.env` or the config object, and nothing
// here ever throws into the request path.

import OpenAI from 'openai';
import { logger } from '../../utils/logger.ts';

const registryLogger = logger.child({ module: 'ai-model-registry' });

/** How long a successful override is trusted before the endpoint is probed again. */
const OVERRIDE_TTL_MS = 30 * 60 * 1000;
/** Negative results expire faster so a recovering provider is picked up quickly. */
const NEGATIVE_TTL_MS = 5 * 60 * 1000;
/** The models listing must never hold up a user request for long. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Every provider the bot can talk to, and the source the rest of the code
 * derives from: the chain order in the environment is validated against this
 * list, so a provider added here becomes nameable in AI_SMART_CHAIN with no
 * second edit — and one that is not here cannot be named by accident.
 */
export const PROVIDER_IDS = ['zai', 'groq', 'gemini', 'hf'] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * The slice of the OpenAI client this module needs. Declared structurally so the
 * real `OpenAI` instance satisfies it without a cast and tests can pass a stub.
 */
export interface ModelListingClient {
  models: {
    list(options?: { timeout?: number }): Promise<{ data: { id: string }[] }>;
  };
}

export interface ModelOverride {
  provider: ProviderId;
  /** The model id configured in `.env` that turned out to be dead. */
  configuredModel: string;
  /** The live model id used instead. */
  resolvedModel: string;
  resolvedAt: number;
}

export type ModelOverrideListener = (override: ModelOverride) => void;

interface ProviderPreferences {
  smart: string[];
  fast: string[];
}

interface ModelPreferenceTable {
  zai: ProviderPreferences;
  groq: ProviderPreferences;
  gemini: ProviderPreferences;
  hf: ProviderPreferences;
}

/**
 * Known-good chat model ids per provider, best first. Only Groq is populated:
 * these ids were verified live on 2026-09-01. The `qwen3.x-27b` ids are live on
 * the same account but capped at 8000 tokens per minute, which rejects the bot's
 * ~11.5k-token tool payload with 413 — so they are deliberately not listed.
 * Providers with an empty list fall back to the heuristic in
 * `selectReplacementModel`.
 */
const PREFERRED_MODELS: ModelPreferenceTable = {
  zai: { smart: [], fast: [] },
  groq: {
    smart: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'groq/compound'],
    fast: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'groq/compound-mini'],
  },
  gemini: { smart: [], fast: [] },
  hf: { smart: [], fast: [] },
};

/** Model ids that cannot serve a chat completion, matched case-insensitively. */
const NON_CHAT_MODEL_PATTERNS: RegExp[] = [
  /whisper/,
  /transcrib/,
  /\btts\b|tts-|-tts/,
  /speech/,
  /embed/,
  /rerank/,
  /guard/,
  /moderation/,
  /orpheus/,
  /allam/,
  /stable-diffusion|sdxl|flux/,
];

interface CacheEntry {
  override: ModelOverride | null;
  expiresAt: number;
  /** Probe sequence number that produced this entry; a slower older probe never overwrites it. */
  sequence: number;
}

interface InFlightProbe {
  promise: Promise<string | null>;
  /** A forced probe already knows the cached replacement is dead. */
  forced: boolean;
  sequence: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, InFlightProbe>();
const listeners: ModelOverrideListener[] = [];
let probeSequence = 0;

function cacheKey(provider: ProviderId, configuredModel: string): string {
  return `${provider}:${configuredModel}`;
}

/** Ordered preference list for a provider and chain tier. */
export function preferredModelsFor(provider: ProviderId, fast: boolean): string[] {
  const prefs = PREFERRED_MODELS[provider];
  return fast ? prefs.fast : prefs.smart;
}

// ── Error classification ───────────────────────────────────────────────────

const MODEL_GONE_PHRASES = ['does not exist', 'not found', 'decommissioned', 'no longer available', 'unknown model'];

/**
 * True when the provider is telling us the requested model id is gone — as
 * opposed to any other client error (bad tool schema, oversized payload, quota).
 *
 * A bare 404 counts, even without a body naming the model: the chat-completions
 * path is fixed and correct for all four providers, so the model id is what the
 * server did not find. A misconfigured base URL would also 404 here, but the
 * cost of guessing wrong is one cached `/v1/models` probe that finds nothing and
 * falls through — cheaper than staying dead because a provider returned a 404
 * with an empty body.
 */
export function isModelNotFoundError(error: unknown): boolean {
  if (!(error instanceof OpenAI.APIError)) return false;
  if (error.code === 'model_not_found' || error.code === 'model_decommissioned') return true;
  if (error.status === 404) return true;
  if (error.status !== 400) return false;
  const message = error.message.toLowerCase();
  if (!message.includes('model')) return false;
  return MODEL_GONE_PHRASES.some((phrase) => message.includes(phrase));
}

// ── Replacement selection ──────────────────────────────────────────────────

function isChatModelId(id: string): boolean {
  const lower = id.toLowerCase();
  return !NON_CHAT_MODEL_PATTERNS.some((pattern) => pattern.test(lower));
}

/** `openai/gpt-oss-120b` → `gpt`, `llama-3.3-70b-versatile` → `llama`. */
function modelFamily(id: string): string {
  const withoutVendor = id.split('/').pop() ?? id;
  return (withoutVendor.split('-')[0] ?? withoutVendor).toLowerCase();
}

export interface ReplacementSelection {
  liveModels: string[];
  configuredModel: string;
  preferences: string[];
  /** Ids already proven dead this round — a listing that still advertises them lies. */
  excludeModels?: string[];
}

/**
 * Pick a replacement for a dead model. Deterministic and explainable, in order:
 *   1. the first entry of the provider's preference list that is actually live;
 *   2. otherwise the alphabetically first live model of the same family as the
 *      dead one (`llama-3.3-70b-versatile` → another `llama-*`);
 *   3. otherwise the alphabetically first remaining live chat model.
 * Transcription, text-to-speech, embedding, rerank, guard and image ids are
 * excluded, as are the configured model and anything in `excludeModels`.
 */
export function selectReplacementModel({
  liveModels,
  configuredModel,
  preferences,
  excludeModels = [],
}: ReplacementSelection): string | null {
  const excluded = new Set([configuredModel, ...excludeModels]);
  const candidates = liveModels.filter((id) => !excluded.has(id) && isChatModelId(id));
  if (candidates.length === 0) return null;

  for (const preferred of preferences) {
    if (candidates.includes(preferred)) return preferred;
  }

  const family = modelFamily(configuredModel);
  const sameFamily = candidates.filter((id) => modelFamily(id) === family).sort();
  if (sameFamily.length > 0) return sameFamily[0] ?? null;

  return [...candidates].sort()[0] ?? null;
}

// ── Cache / listeners ──────────────────────────────────────────────────────

/** The cached live replacement for a configured model, or null if there is none. */
export function getModelOverride(provider: ProviderId, configuredModel: string): string | null {
  const entry = cache.get(cacheKey(provider, configuredModel));
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry.override?.resolvedModel ?? null;
}

/** Every currently active override — the configured ids in `.env` that are stale. */
export function listModelOverrides(): ModelOverride[] {
  const now = Date.now();
  const active: ModelOverride[] = [];
  for (const entry of cache.values()) {
    if (entry.override && entry.expiresAt > now) active.push(entry.override);
  }
  return active;
}

/**
 * Register a callback fired once per newly resolved override. Used by the admin
 * alerting layer to report that `.env` names a model the provider deleted.
 */
export function onModelOverrideResolved(listener: ModelOverrideListener): void {
  listeners.push(listener);
}

function notify(override: ModelOverride): void {
  for (const listener of listeners) {
    try {
      listener(override);
    } catch (err) {
      registryLogger.warn({ err, provider: override.provider }, 'Model override listener threw');
    }
  }
}

/** Drop all cached overrides and listeners. For tests only. */
export function resetModelRegistry(): void {
  cache.clear();
  inFlight.clear();
  listeners.length = 0;
  probeSequence = 0;
}

// ── Resolution ─────────────────────────────────────────────────────────────

export interface ResolveModelOverrideOptions {
  provider: ProviderId;
  client: ModelListingClient;
  /** The model id from `.env` that the provider rejected. */
  configuredModel: string;
  /** Use the fast-tier preference list. Default: false. */
  fast?: boolean;
  /** Ignore a cached override (the previously resolved replacement died too). */
  forceRefresh?: boolean;
  /**
   * The model id the provider just rejected. Excluded from the replacement even
   * if `/v1/models` still advertises it — otherwise a lying listing hands back
   * the same dead id and every later request pays for another probe.
   */
  deadModel?: string;
}

async function listLiveModels(client: ModelListingClient): Promise<string[] | null> {
  try {
    const page = await client.models.list({ timeout: PROBE_TIMEOUT_MS });
    return page.data.map((model) => model.id);
  } catch (err) {
    registryLogger.warn({ err }, 'Could not list live models from provider');
    return null;
  }
}

/**
 * Store a probe's outcome unless a newer probe already answered for this model.
 * Returns what the cache now holds, so an out-of-order straggler reports the
 * fresher answer instead of its own stale one.
 */
function commitProbeResult(key: string, sequence: number, entry: CacheEntry): string | null {
  const current = cache.get(key);
  if (current && current.sequence > sequence) return current.override?.resolvedModel ?? null;
  cache.set(key, entry);
  return entry.override?.resolvedModel ?? null;
}

async function probeAndCache(
  options: ResolveModelOverrideOptions,
  key: string,
  sequence: number,
): Promise<string | null> {
  const { provider, configuredModel, fast } = options;
  const liveModels = await listLiveModels(options.client);
  if (!liveModels) {
    return commitProbeResult(key, sequence, { override: null, expiresAt: Date.now() + NEGATIVE_TTL_MS, sequence });
  }

  const resolvedModel = selectReplacementModel({
    liveModels,
    configuredModel,
    preferences: preferredModelsFor(provider, fast === true),
    excludeModels: options.deadModel ? [options.deadModel] : [],
  });

  if (!resolvedModel) {
    registryLogger.warn(
      { provider, configuredModel, liveModelCount: liveModels.length },
      'Provider has no usable chat model to replace the configured one',
    );
    return commitProbeResult(key, sequence, { override: null, expiresAt: Date.now() + NEGATIVE_TTL_MS, sequence });
  }

  const override: ModelOverride = { provider, configuredModel, resolvedModel, resolvedAt: Date.now() };
  const stored = commitProbeResult(key, sequence, { override, expiresAt: Date.now() + OVERRIDE_TTL_MS, sequence });
  if (stored !== resolvedModel) return stored;

  registryLogger.warn(
    { provider, configuredModel, resolvedModel },
    'Configured AI model is gone — using an auto-detected replacement; update .env',
  );
  notify(override);
  return resolvedModel;
}

/**
 * Find a live model to use instead of a configured one the provider rejected.
 * Result (including "nothing usable") is cached per provider+configured model, so
 * `/v1/models` is probed once rather than per request. Never throws: on any
 * failure it returns null and the caller falls through to the next provider.
 */
export async function resolveModelOverride(options: ResolveModelOverrideOptions): Promise<string | null> {
  const key = cacheKey(options.provider, options.configuredModel);
  const pending = inFlight.get(key);
  const forced = options.forceRefresh === true;

  if (forced) {
    // Join another forced probe — it also knows the cached replacement is dead.
    // An older ordinary probe is not joinable: it would hand back the very model
    // this caller just found to be gone.
    if (pending?.forced) return pending.promise;
  } else {
    const entry = cache.get(key);
    if (entry && entry.expiresAt > Date.now()) return entry.override?.resolvedModel ?? null;
    if (pending) return pending.promise;
  }

  probeSequence += 1;
  const sequence = probeSequence;
  const probe: InFlightProbe = {
    forced,
    sequence,
    promise: probeAndCache(options, key, sequence).finally(() => {
      // Only clear our own entry: a newer probe may already have replaced it.
      if (inFlight.get(key)?.sequence === sequence) inFlight.delete(key);
    }),
  };
  inFlight.set(key, probe);
  return probe.promise;
}
