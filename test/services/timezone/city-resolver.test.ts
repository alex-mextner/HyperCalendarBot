// test/services/timezone/city-resolver.test.ts
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type OpenAI from 'openai';
import type { StreamRoundOptions, StreamRoundResult } from '../../../src/services/ai/streaming.ts';
import { initCityResolverCache, resolveCity } from '../../../src/services/timezone/city-resolver.ts';

/** Build a stub streamImpl returning canned text (the "city" the AI would have suggested). */
function stubStream(text: string) {
  return mock(async (_opts: StreamRoundOptions): Promise<StreamRoundResult> => {
    const msg: OpenAI.ChatCompletionMessageParam = { role: 'assistant', content: text };
    return {
      text,
      toolCalls: [],
      finishReason: 'stop',
      assistantMessage: msg,
      providerUsed: 'stub',
    };
  });
}

describe('resolveCity', () => {
  let aiMock: ReturnType<typeof stubStream>;

  beforeEach(() => {
    // Reset Redis cache between tests so a previous test's cached entry
    // doesn't leak through and skip the AI / matcher path under test.
    initCityResolverCache({ get: async () => null, set: async () => 'OK' });
    aiMock = stubStream('Europe/Belgrade');
  });

  test('returns IANA key when user types it directly', async () => {
    expect(await resolveCity('Europe/Belgrade', aiMock)).toBe('Europe/Belgrade');
  });

  test('resolves Latin city name via library', async () => {
    const result = await resolveCity('Belgrade', aiMock);
    expect(result).toBe('Europe/Belgrade');
  });

  test('resolves partial/fuzzy city name via library', async () => {
    const result = await resolveCity('New Yor', aiMock);
    expect(result).toBeTruthy();
    expect(result).toContain('America/');
  });

  test('resolves Russian nominative via matcher without AI', async () => {
    expect(await resolveCity('москва', aiMock)).toBe('Europe/Moscow');
    expect(aiMock).not.toHaveBeenCalled();
  });

  test('resolves Russian case forms via matcher without AI', async () => {
    expect(await resolveCity('москве', aiMock)).toBe('Europe/Moscow');
    expect(await resolveCity('нижнем новгороде', aiMock)).toBe('Europe/Moscow');
    expect(aiMock).not.toHaveBeenCalled();
  });

  test('resolves abbreviations without AI', async () => {
    expect(await resolveCity('мск', aiMock)).toBe('Europe/Moscow');
    expect(await resolveCity('екб', aiMock)).toBe('Asia/Yekaterinburg');
    expect(aiMock).not.toHaveBeenCalled();
  });

  test('resolves case-insensitive', async () => {
    expect(await resolveCity('Москве', aiMock)).toBe('Europe/Moscow');
    expect(aiMock).not.toHaveBeenCalled();
  });

  test('falls back to AI for unknown input', async () => {
    const stub = stubStream('Europe/Moscow');
    const result = await resolveCity('глубокобыстрицк', stub);
    expect(result).toBe('Europe/Moscow');
    expect(stub).toHaveBeenCalledTimes(1);
  });

  test('resolves when AI returns a city name instead of IANA key', async () => {
    const stub = stubStream('Belgrade');
    const result = await resolveCity('глубокобыстрицк', stub);
    expect(result).toBe('Europe/Belgrade');
    expect(stub).toHaveBeenCalledTimes(1);
  });

  test('returns null when AI response has empty content', async () => {
    const stub = stubStream('');
    const result = await resolveCity('глубокобыстрицк', stub);
    expect(result).toBeNull();
  });

  test('AI makes only 1 attempt and rejects junk', async () => {
    const stub = stubStream('Fake/Zone');
    const result = await resolveCity('глубокобыстрицк', stub);
    expect(result).toBeNull();
    expect(stub).toHaveBeenCalledTimes(1);
  });

  test('returns null when AI returns UNKNOWN', async () => {
    const stub = stubStream('UNKNOWN');
    const result = await resolveCity('asdfasdf', stub);
    expect(result).toBeNull();
  });

  test('resolves relocant destination cities', async () => {
    expect(await resolveCity('батуми', aiMock)).toBe('Asia/Tbilisi');
    expect(await resolveCity('будве', aiMock)).toBe('Europe/Podgorica');
    expect(await resolveCity('лимасоле', aiMock)).toBe('Asia/Nicosia');
    expect(await resolveCity('анталье', aiMock)).toBe('Europe/Istanbul');
    expect(aiMock).not.toHaveBeenCalled();
  });

  test('resolves воронеж without AI (now in matcher)', async () => {
    expect(await resolveCity('воронеже', aiMock)).toBe('Europe/Moscow');
    expect(aiMock).not.toHaveBeenCalled();
  });
});

describe('Redis cache integration', () => {
  test('cache hit returns cached value without calling matcher or AI', async () => {
    const mockGet = mock(async () => 'Asia/Tokyo');
    const mockSet = mock(async () => 'OK');
    initCityResolverCache({ get: mockGet, set: mockSet });
    const aiMock = stubStream('Europe/Belgrade');

    const result = await resolveCity('какой-то город', aiMock);
    expect(result).toBe('Asia/Tokyo');
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(aiMock).not.toHaveBeenCalled();

    // Reset to no-cache for other tests
    initCityResolverCache({ get: async () => null, set: async () => 'OK' });
  });

  test('cache miss falls through to matcher', async () => {
    const mockGet = mock(async () => null);
    const mockSet = mock(async () => 'OK');
    initCityResolverCache({ get: mockGet, set: mockSet });
    const aiMock = stubStream('Europe/Belgrade');

    const result = await resolveCity('москве', aiMock);
    expect(result).toBe('Europe/Moscow');
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledTimes(1);

    initCityResolverCache({ get: async () => null, set: async () => 'OK' });
  });

  test('Redis error degrades gracefully — falls through to matcher', async () => {
    const mockGet = mock(async () => {
      throw new Error('Redis connection refused');
    });
    const mockSet = mock(async () => {
      throw new Error('Redis connection refused');
    });
    initCityResolverCache({ get: mockGet, set: mockSet });
    const aiMock = stubStream('Europe/Belgrade');

    const result = await resolveCity('москве', aiMock);
    expect(result).toBe('Europe/Moscow');

    initCityResolverCache({ get: async () => null, set: async () => 'OK' });
  });
});
