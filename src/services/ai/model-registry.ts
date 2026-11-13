// src/services/ai/model-registry.ts
// Live-model discovery for the AI provider chain.
//
// Providers delete models without notice (a provider removed its chat models on
// 2026-09-01, which returned 404 for every request).
// When that happens the bot must not stay dead until a human edits `.env`: it
// probes the provider's OpenAI-compatible `GET /v1/models` endpoint once, picks a
// live replacement by a deterministic, explainable rule, and caches the override
// in memory. Nothing here ever mutates `.env` or the config object, and nothing
// here ever throws into the request path.

import OpenAI from 'openai';
import { logger } from '../../utils/logger.ts';
import { reportTimeout } from '../incident/timeout-reporter.ts';
import { withClaudeCredentials } from './claude-client-pool.ts';
import { CredentialsCoolingDownError } from './claude-credential-pool.ts';
import { excludedModelReason } from './model-presets.ts';
import type { ProviderId } from './provider-ids.ts';
import { classifyProviderError } from './usage-classification.ts';

const registryLogger = logger.child({ module: 'ai-model-registry' });

/** How long a successful override is trusted before the endpoint is probed again. */
const OVERRIDE_TTL_MS = 30 * 60 * 1000;
/** Negative results expire faster so a recovering provider is picked up quickly. */
const NEGATIVE_TTL_MS = 5 * 60 * 1000;
/** The models listing must never hold up a user request for long. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * The slice of the OpenAI client this module needs. Declared structurally so the
 * real `OpenAI` instance satisfies it without a cast and tests can pass a stub.
 */
export interface ModelListingClient {
  models: {
    list(options?: { timeout?: number; signal?: AbortSignal }): Promise<{ data: { id: string }[] }>;
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
  /** A replacement must come from these lists: the family/alphabetical fallback is off. */
  preferredOnly?: true;
}

interface ModelPreferenceTable {
  zai: ProviderPreferences;
  hf: ProviderPreferences;
  claude: ProviderPreferences;
  openrouter: ProviderPreferences;
}

/**
 * Known-good chat model ids per provider, best first. Claude is pinned to the 5.5 models by
 * owner decision (2026-10-10): no older fallbacks. It is the primary provider and every id
 * shares the `claude` family, so the heuristic would pick `claude-fable-*`/`claude-opus-*`;
 * it is preferred-only and never switches to a pricier tier on its own. Other
 * providers with an empty list fall back to the heuristic in `selectReplacementModel`.
 */
const PREFERRED_MODELS: ModelPreferenceTable = {
  zai: { smart: [], fast: [] },
  hf: { smart: [], fast: [] },
  claude: {
    smart: ['claude-sonnet-5-5'],
    fast: ['claude-haiku-5-5'],
    preferredOnly: true,
  },
  // OpenRouter lists hundreds of models at very different prices, so a dead configured id is
  // never swapped for a guessed one: with no preferred ids the replacement stays off.
  openrouter: { smart: [], fast: [], preferredOnly: true },
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
  /** When the probe's own budget ends (`performance.now()` clock); it reports its own timeout. */
  deadlineAt: number;
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
 * path is fixed and correct for every provider, so the model id is what the
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
 * excluded, as are the configured model, anything in `excludeModels` and every model on the
 * owner's excluded list (`model-presets.ts`): a dead model is never replaced by one the owner banned.
 */
export function selectReplacementModel({
  liveModels,
  configuredModel,
  preferences,
  excludeModels = [],
}: ReplacementSelection): string | null {
  const excluded = new Set([configuredModel, ...excludeModels]);
  const candidates = liveModels.filter(
    (id) => !excluded.has(id) && isChatModelId(id) && excludedModelReason(id) === null,
  );
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
  /** The original provider/round cancellation, retained during catalog discovery. */
  signal?: AbortSignal;
  providerDeadlineAt?: number;
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

/**
 * A catalogue listing that ran out of its budget. Counted as recovered on purpose: whether the user's request was
 * served is decided by the next slot, and a round that fails is reported by the streaming round itself.
 */
function reportListingTimeout(startedAt: number, limitMs: number): void {
  reportTimeout({ kind: 'model_listing', elapsedMs: performance.now() - startedAt, limitMs, recovered: true });
}

async function listLiveModels(
  client: ModelListingClient,
  signal?: AbortSignal,
  deadlineAt = performance.now() + PROBE_TIMEOUT_MS,
): Promise<string[] | null> {
  const timeoutMs = Math.floor(Math.min(PROBE_TIMEOUT_MS, deadlineAt - performance.now()));
  if (timeoutMs <= 0) throw new DOMException('Catalog probe timed out', 'TimeoutError');
  const startedAt = performance.now();
  try {
    const page =
      client instanceof OpenAI
        ? await withClaudeCredentials(
            client,
            (candidate, signal) => candidate.models.list({ timeout: timeoutMs, signal }),
            { timeoutMs, signal },
          )
        : await client.models.list({ timeout: timeoutMs, signal });
    return page.data.map((model) => model.id);
  } catch (err) {
    if (err instanceof CredentialsCoolingDownError) throw err;
    if (
      signal?.aborted ||
      (err instanceof Error && err.name === 'AbortError') ||
      err instanceof OpenAI.APIUserAbortError
    )
      throw err;
    if (classifyProviderError(err, false).errorClass === 'timeout') reportListingTimeout(startedAt, timeoutMs);
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

/**
 * The probe's signal is its own budget (a caller's signal only owns its waiter), so an abort that reaches
 * `probeAndCache` is the listing running out of time.
 */
function reportProbeAbort(options: ResolveModelOverrideOptions, err: unknown, startedAt: number): void {
  const timedOut = options.signal?.aborted || (err instanceof DOMException && err.name === 'TimeoutError');
  if (timedOut)
    reportListingTimeout(startedAt, (options.providerDeadlineAt ?? startedAt + PROBE_TIMEOUT_MS) - startedAt);
}

async function probeAndCache(
  options: ResolveModelOverrideOptions,
  key: string,
  sequence: number,
): Promise<string | null> {
  const { provider, configuredModel, fast } = options;
  // Nothing can be chosen from an empty preferred-only list, so the catalogue is not worth listing.
  if (PREFERRED_MODELS[provider].preferredOnly && preferredModelsFor(provider, fast === true).length === 0) {
    return commitProbeResult(key, sequence, { override: null, expiresAt: Date.now() + NEGATIVE_TTL_MS, sequence });
  }
  let liveModels: string[] | null;
  const startedAt = performance.now();
  try {
    liveModels = await listLiveModels(options.client, options.signal, options.providerDeadlineAt);
  } catch (err) {
    reportProbeAbort(options, err, startedAt);
    return null;
  } // Aborted shared probes are unknown, never a negative catalog result.
  if (
    options.signal?.aborted ||
    (options.providerDeadlineAt !== undefined && options.providerDeadlineAt <= performance.now())
  )
    return null;
  if (!liveModels) {
    return commitProbeResult(key, sequence, { override: null, expiresAt: Date.now() + NEGATIVE_TTL_MS, sequence });
  }

  const preferences = preferredModelsFor(provider, fast === true);
  const resolvedModel = selectReplacementModel({
    liveModels: PREFERRED_MODELS[provider].preferredOnly
      ? liveModels.filter((id) => preferences.includes(id))
      : liveModels,
    configuredModel,
    preferences,
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
/** Each caller may stop waiting; the bounded shared lookup remains useful to other live callers. */
async function waitForCatalog(
  probe: InFlightProbe,
  options: ResolveModelOverrideOptions,
  joined: boolean,
): Promise<string | null> {
  if (options.signal?.aborted) return null;
  const remaining =
    options.providerDeadlineAt === undefined ? undefined : options.providerDeadlineAt - performance.now();
  if (remaining !== undefined && remaining <= 0) return null;
  const waitStartedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let deadlineExpired = false;
  const stopped = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (remaining !== undefined) {
      timer = setTimeout(() => {
        deadlineExpired = true;
        resolve(null);
      }, remaining);
    }
  });
  try {
    const result = await Promise.race([probe.promise, stopped]);
    // The caller that started the probe never reports: the probe's budget is its own deadline and the probe
    // reports that expiry itself. A joiner whose deadline ended before the probe's own would otherwise leave
    // the expiry unreported (its slot fails with the model-not-found error, which says nothing about time).
    if (
      joined &&
      deadlineExpired &&
      result === null &&
      remaining !== undefined &&
      options.providerDeadlineAt !== undefined &&
      options.providerDeadlineAt < probe.deadlineAt
    ) {
      reportListingTimeout(waitStartedAt, remaining);
    }
    return result;
  } finally {
    clearTimeout(timer);
    if (onAbort) options.signal?.removeEventListener('abort', onAbort);
  }
}

function shouldSkipModelLookup(options: ResolveModelOverrideOptions): boolean {
  // The HF catalog lists base ids without provider pins. Replacing an explicit
  // route from that list would silently change its provider; use normal failover.
  if (options.provider === 'hf' && options.configuredModel.includes(':')) return true;
  return (
    options.signal?.aborted === true ||
    (options.providerDeadlineAt !== undefined && options.providerDeadlineAt <= performance.now())
  );
}

export async function resolveModelOverride(options: ResolveModelOverrideOptions): Promise<string | null> {
  if (shouldSkipModelLookup(options)) return null;
  const key = cacheKey(options.provider, options.configuredModel);
  const pending = inFlight.get(key);
  const forced = options.forceRefresh === true;

  if (forced) {
    // Join another forced probe — it also knows the cached replacement is dead.
    // An older ordinary probe is not joinable: it would hand back the very model
    // this caller just found to be gone.
    if (pending?.forced) return waitForCatalog(pending, options, true);
  } else {
    const entry = cache.get(key);
    if (entry && entry.expiresAt > Date.now()) return entry.override?.resolvedModel ?? null;
    if (pending) return waitForCatalog(pending, options, true);
  }

  const budget = Math.min(
    PROBE_TIMEOUT_MS,
    options.providerDeadlineAt === undefined ? PROBE_TIMEOUT_MS : options.providerDeadlineAt - performance.now(),
  );
  if (budget <= 0) return null;
  // A caller signal only owns its waiter. The probe retains the original admitted budget.
  const deadlineAt = performance.now() + budget;
  const sharedOptions = {
    ...options,
    providerDeadlineAt: deadlineAt,
    signal: AbortSignal.timeout(Math.max(1, Math.ceil(budget))),
  };
  probeSequence += 1;
  const sequence = probeSequence;
  const probe: InFlightProbe = {
    forced,
    sequence,
    deadlineAt,
    promise: probeAndCache(sharedOptions, key, sequence).finally(() => {
      // Only clear our own entry: a newer probe may already have replaced it.
      if (inFlight.get(key)?.sequence === sequence) inFlight.delete(key);
    }),
  };
  inFlight.set(key, probe);
  return waitForCatalog(probe, options, false);
}
