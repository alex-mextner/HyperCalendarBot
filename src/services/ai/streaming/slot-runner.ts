// src/services/ai/streaming/slot-runner.ts
// Runs one slot's request with its same-slot recoveries: one repeat of an empty-400 rejection, and one
// retry on a live replacement model when the provider says the configured model is gone.

import { getModelOverride, isModelNotFoundError, resolveModelOverride } from '../model-registry.ts';
import { isBodilessRejection, isCallerAbort } from './error-classification.ts';
import { aiLogger } from './logger.ts';
import type { ProviderSlot } from './slot.ts';
import type { StreamCallbacks, StreamRoundOptions, StreamRoundResult } from './types.ts';

async function streamRetryingBodilessRejection(
  slot: ProviderSlot,
  model: string,
  opts: StreamRoundOptions,
  cbs: StreamCallbacks,
  onAttempt: () => void,
): Promise<StreamRoundResult> {
  try {
    return await slot.stream(model, opts, cbs, onAttempt);
  } catch (error) {
    if (!isBodilessRejection(error) || isCallerAbort(opts.signal)) throw error;
    aiLogger.warn(
      { provider: slot.label, model, userId: opts.userId },
      'Provider rejected the request with an empty 400 — repeating it once',
    );
    return await slot.stream(model, opts, cbs, onAttempt);
  }
}

/**
 * Run one slot. If the provider says the configured model is gone, probe its
 * `/v1/models` endpoint once, pick a live replacement and retry the request on
 * the same provider before giving up on it.
 *
 * A model-not-found error always comes from the request itself, before any
 * chunk is streamed, so the retry can never duplicate text already sent to the
 * user.
 */
export async function runSlot(
  slot: ProviderSlot,
  opts: StreamRoundOptions,
  cbs: StreamCallbacks,
  onAttempt: () => void,
): Promise<StreamRoundResult> {
  // A preset slot runs the model that was measured and nothing else: neither a cached replacement nor a
  // fresh heuristic one, which would serve the role unmeasured.
  const measured = slot.presetId !== undefined;
  const cachedOverride = measured ? null : getModelOverride(slot.provider, slot.configuredModel);
  const model = cachedOverride ?? slot.configuredModel;

  try {
    return await streamRetryingBodilessRejection(slot, model, opts, cbs, onAttempt);
  } catch (error) {
    if (measured || !isModelNotFoundError(error)) throw error;

    const replacement = await resolveModelOverride({
      provider: slot.provider,
      client: slot.getClient(),
      configuredModel: slot.configuredModel,
      fast: opts.fast === true,
      // The cached replacement is dead too — probe again instead of reusing it.
      forceRefresh: cachedOverride !== null,
      deadModel: model,
    });
    if (!replacement || replacement === model) throw error;

    aiLogger.warn(
      { provider: slot.label, configuredModel: slot.configuredModel, resolvedModel: replacement, userId: opts.userId },
      'Configured model is gone — retrying the same provider with an auto-detected live model',
    );
    return await slot.stream(replacement, opts, cbs, onAttempt);
  }
}
