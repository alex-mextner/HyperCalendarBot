// test/services/ai/model-registry.test.ts
// Behavior tests for the AI model registry: detecting a deleted/renamed model,
// probing the provider's OpenAI-compatible /v1/models endpoint, picking a
// deterministic replacement, and caching the result.

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import OpenAI from 'openai';
import {
  getModelOverride,
  isModelNotFoundError,
  listModelOverrides,
  type ModelListingClient,
  onModelOverrideResolved,
  preferredModelsFor,
  resetModelRegistry,
  resolveModelOverride,
  selectReplacementModel,
} from '../../../src/services/ai/model-registry.ts';

/** Fake OpenAI-compatible client exposing only the models listing endpoint. */
function makeListingClient(ids: string[]) {
  const list = mock(async () => ({ data: ids.map((id) => ({ id })) }));
  const client: ModelListingClient = { models: { list } };
  return { client, list };
}

/** Fake client whose /v1/models call rejects. */
function makeFailingListingClient(error: Error) {
  const list = mock(async () => {
    throw error;
  });
  const client: ModelListingClient = { models: { list } };
  return { client, list };
}

function apiError(status: number, message: string, code?: string) {
  return new OpenAI.APIError(status, { error: { message, code } }, message, new Headers());
}

describe('isModelNotFoundError', () => {
  test('detects Groq 404 for a deleted model', () => {
    const error = apiError(404, 'The model `llama-3.3-70b-versatile` does not exist or you do not have access to it');
    expect(isModelNotFoundError(error)).toBe(true);
  });

  test('detects a 400 whose body says the model was decommissioned', () => {
    const error = apiError(400, 'The model `mixtral-8x7b-32768` has been decommissioned', 'model_decommissioned');
    expect(isModelNotFoundError(error)).toBe(true);
  });

  test('detects code=model_not_found regardless of status', () => {
    const error = apiError(400, 'unknown model', 'model_not_found');
    expect(isModelNotFoundError(error)).toBe(true);
  });

  test('does NOT treat the Groq Harmony tool-template 400 as model-not-found', () => {
    const error = apiError(400, 'failed to template request: HarmonyError: Tools should have a name!');
    expect(isModelNotFoundError(error)).toBe(false);
  });

  test('does NOT treat 429 quota exhaustion as model-not-found', () => {
    expect(isModelNotFoundError(apiError(429, 'Weekly Limit Exhausted'))).toBe(false);
  });

  test('does NOT treat a plain Error as model-not-found', () => {
    expect(isModelNotFoundError(new Error('connection closed'))).toBe(false);
  });
});

describe('selectReplacementModel', () => {
  const groqLive = [
    'whisper-large-v3',
    'meta-llama/llama-guard-4-12b',
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'qwen/qwen3.8-27b',
    'groq/compound',
  ];

  test('picks the first live id from the preference list, not the first id in the response', () => {
    const picked = selectReplacementModel({
      liveModels: groqLive,
      configuredModel: 'llama-3.3-70b-versatile',
      preferences: preferredModelsFor('groq', false),
    });
    expect(picked).toBe('openai/gpt-oss-120b');
  });

  test('fast tier prefers the small gpt-oss model', () => {
    const picked = selectReplacementModel({
      liveModels: groqLive,
      configuredModel: 'llama-3.1-8b-instant',
      preferences: preferredModelsFor('groq', true),
    });
    expect(picked).toBe('openai/gpt-oss-20b');
  });

  test('skips transcription, guard and other non-chat ids when no preference matches', () => {
    const picked = selectReplacementModel({
      liveModels: [
        'whisper-large-v3-turbo',
        'playai-tts',
        'meta-llama/llama-prompt-guard-2-86m',
        'text-embedding-3-large',
        'canopylabs/orpheus-3b',
        'gemini-2.5-flash',
      ],
      configuredModel: 'gemini-9.9-nonexistent',
      preferences: [],
    });
    expect(picked).toBe('gemini-2.5-flash');
  });

  test('prefers a model from the same family as the dead one when nothing is preferred', () => {
    const picked = selectReplacementModel({
      liveModels: ['zebra-1', 'llama-3.1-70b-versatile', 'aardvark-2'],
      configuredModel: 'llama-3.3-70b-versatile',
      preferences: [],
    });
    expect(picked).toBe('llama-3.1-70b-versatile');
  });

  test('never returns the configured (dead) model back', () => {
    const picked = selectReplacementModel({
      liveModels: ['llama-3.3-70b-versatile'],
      configuredModel: 'llama-3.3-70b-versatile',
      preferences: ['llama-3.3-70b-versatile'],
    });
    expect(picked).toBeNull();
  });

  test('excludes a replacement already proven dead, even if the listing still advertises it', () => {
    const picked = selectReplacementModel({
      liveModels: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'],
      configuredModel: 'llama-3.3-70b-versatile',
      preferences: preferredModelsFor('groq', false),
      excludeModels: ['openai/gpt-oss-120b'],
    });
    expect(picked).toBe('openai/gpt-oss-20b');
  });

  test('returns null when nothing usable is live', () => {
    const picked = selectReplacementModel({
      liveModels: ['whisper-large-v3', 'playai-tts'],
      configuredModel: 'dead-model',
      preferences: ['openai/gpt-oss-120b'],
    });
    expect(picked).toBeNull();
  });
});

describe('resolveModelOverride', () => {
  beforeEach(() => {
    resetModelRegistry();
  });

  test('probes /v1/models and returns a live replacement', async () => {
    const { client, list } = makeListingClient(['whisper-large-v3', 'openai/gpt-oss-120b']);

    const resolved = await resolveModelOverride({
      provider: 'groq',
      client,
      configuredModel: 'llama-3.3-70b-versatile',
    });

    expect(resolved).toBe('openai/gpt-oss-120b');
    expect(list).toHaveBeenCalledTimes(1);
  });

  test('caches the resolution: repeated failures probe /v1/models only once', async () => {
    const { client, list } = makeListingClient(['openai/gpt-oss-120b']);

    const first = await resolveModelOverride({ provider: 'groq', client, configuredModel: 'dead-model' });
    const second = await resolveModelOverride({ provider: 'groq', client, configuredModel: 'dead-model' });
    const third = await resolveModelOverride({ provider: 'groq', client, configuredModel: 'dead-model' });

    expect([first, second, third]).toEqual(['openai/gpt-oss-120b', 'openai/gpt-oss-120b', 'openai/gpt-oss-120b']);
    expect(list).toHaveBeenCalledTimes(1);
  });

  test('getModelOverride returns the cached replacement so later requests skip the dead model', async () => {
    const { client } = makeListingClient(['openai/gpt-oss-120b']);
    expect(getModelOverride('groq', 'dead-model')).toBeNull();

    await resolveModelOverride({ provider: 'groq', client, configuredModel: 'dead-model' });

    expect(getModelOverride('groq', 'dead-model')).toBe('openai/gpt-oss-120b');
    expect(getModelOverride('groq', 'some-other-model')).toBeNull();
    expect(getModelOverride('gemini', 'dead-model')).toBeNull();
  });

  test('forceRefresh re-probes when the previously resolved replacement also died', async () => {
    const { client, list } = makeListingClient(['openai/gpt-oss-120b']);
    await resolveModelOverride({ provider: 'groq', client, configuredModel: 'dead-model' });

    const { client: newer, list: newerList } = makeListingClient(['openai/gpt-oss-20b']);
    const resolved = await resolveModelOverride({
      provider: 'groq',
      client: newer,
      configuredModel: 'dead-model',
      forceRefresh: true,
    });

    expect(resolved).toBe('openai/gpt-oss-20b');
    expect(list).toHaveBeenCalledTimes(1);
    expect(newerList).toHaveBeenCalledTimes(1);
    expect(getModelOverride('groq', 'dead-model')).toBe('openai/gpt-oss-20b');
  });

  test('deadModel keeps a lying listing from handing back the id that just failed', async () => {
    const { client } = makeListingClient(['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);

    const resolved = await resolveModelOverride({
      provider: 'groq',
      client,
      configuredModel: 'llama-3.3-70b-versatile',
      deadModel: 'openai/gpt-oss-120b',
    });

    expect(resolved).toBe('openai/gpt-oss-20b');
  });

  test('returns null and never throws when /v1/models errors', async () => {
    const { client, list } = makeFailingListingClient(new Error('models endpoint unreachable'));

    const resolved = await resolveModelOverride({ provider: 'groq', client, configuredModel: 'dead-model' });

    expect(resolved).toBeNull();
    expect(list).toHaveBeenCalledTimes(1);
    expect(getModelOverride('groq', 'dead-model')).toBeNull();
  });

  test('returns null when the endpoint yields nothing usable, and does not re-probe within the TTL', async () => {
    const { client, list } = makeListingClient(['whisper-large-v3']);

    expect(await resolveModelOverride({ provider: 'groq', client, configuredModel: 'dead-model' })).toBeNull();
    expect(await resolveModelOverride({ provider: 'groq', client, configuredModel: 'dead-model' })).toBeNull();

    expect(list).toHaveBeenCalledTimes(1);
  });

  test('records the override and notifies listeners so the admin can be told the config is stale', async () => {
    const seen: { provider: string; configuredModel: string; resolvedModel: string }[] = [];
    onModelOverrideResolved((override) => {
      seen.push({
        provider: override.provider,
        configuredModel: override.configuredModel,
        resolvedModel: override.resolvedModel,
      });
    });

    const { client } = makeListingClient(['openai/gpt-oss-120b']);
    await resolveModelOverride({ provider: 'groq', client, configuredModel: 'llama-3.3-70b-versatile' });
    // A cached second call must not re-notify.
    await resolveModelOverride({ provider: 'groq', client, configuredModel: 'llama-3.3-70b-versatile' });

    expect(seen).toEqual([
      { provider: 'groq', configuredModel: 'llama-3.3-70b-versatile', resolvedModel: 'openai/gpt-oss-120b' },
    ]);
    expect(listModelOverrides()).toHaveLength(1);
    expect(listModelOverrides()[0]?.resolvedModel).toBe('openai/gpt-oss-120b');
  });

  test('concurrent resolutions share a single /v1/models probe', async () => {
    const { client, list } = makeListingClient(['openai/gpt-oss-120b']);

    const results = await Promise.all([
      resolveModelOverride({ provider: 'groq', client, configuredModel: 'dead-model' }),
      resolveModelOverride({ provider: 'groq', client, configuredModel: 'dead-model' }),
    ]);

    expect(results).toEqual(['openai/gpt-oss-120b', 'openai/gpt-oss-120b']);
    expect(list).toHaveBeenCalledTimes(1);
  });

  test('concurrent forced refreshes share one probe instead of racing each other', async () => {
    // Two user messages arriving together both hit the dead cached replacement.
    // Each asks for a refresh; they must join the same probe, not start two that
    // finish out of order and leave the cache holding the older answer.
    const { client } = makeListingClient(['openai/gpt-oss-120b']);
    await resolveModelOverride({ provider: 'groq', client, configuredModel: 'dead-model' });

    const { client: refreshed, list: refreshedList } = makeListingClient(['openai/gpt-oss-20b']);
    const results = await Promise.all([
      resolveModelOverride({ provider: 'groq', client: refreshed, configuredModel: 'dead-model', forceRefresh: true }),
      resolveModelOverride({ provider: 'groq', client: refreshed, configuredModel: 'dead-model', forceRefresh: true }),
    ]);

    expect(results).toEqual(['openai/gpt-oss-20b', 'openai/gpt-oss-20b']);
    expect(refreshedList).toHaveBeenCalledTimes(1);
    expect(getModelOverride('groq', 'dead-model')).toBe('openai/gpt-oss-20b');
  });

  test('a slow probe does not clear a newer probe started for the same model', async () => {
    // The first probe resolves after a forced refresh already started a second
    // one. Its cleanup must not drop the newer probe's in-flight entry, or a
    // third caller would start yet another redundant /v1/models request.
    let releaseFirst = () => {};
    const firstList = mock(async () => {
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return { data: [{ id: 'openai/gpt-oss-120b' }] };
    });
    const slow: ModelListingClient = { models: { list: firstList } };

    const first = resolveModelOverride({ provider: 'groq', client: slow, configuredModel: 'dead-model' });
    const { client: second, list: secondList } = makeListingClient(['openai/gpt-oss-20b']);
    const forced = resolveModelOverride({
      provider: 'groq',
      client: second,
      configuredModel: 'dead-model',
      forceRefresh: true,
    });

    releaseFirst();
    await Promise.all([first, forced]);

    const third = await resolveModelOverride({ provider: 'groq', client: second, configuredModel: 'dead-model' });

    expect(third).toBe('openai/gpt-oss-20b');
    expect(secondList).toHaveBeenCalledTimes(1);
  });
});
