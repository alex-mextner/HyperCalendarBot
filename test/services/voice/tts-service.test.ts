import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { TtsService } from '../../../src/services/voice/tts-service';

describe('TtsService', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Mock fetch — Bun's typeof fetch is a callable + the static `preconnect` method.
    // We replace only the callable behavior; preconnect comes from the original.
    const fakeAudio = new Uint8Array(300);
    const fakeResponse = {
      ok: true,
      status: 200,
      arrayBuffer: () => Promise.resolve(fakeAudio.buffer),
    } as Response;
    const mockFetch: typeof fetch = Object.assign(async () => fakeResponse, {
      preconnect: originalFetch.preconnect.bind(originalFetch),
    });
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('synthesize', () => {
    test('returns a Buffer with audio data', async () => {
      const service = new TtsService();
      const buffer = await service.synthesize('Hello', 'en');
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(100);
    });

    test('caches repeated calls', async () => {
      const service = new TtsService();
      const buf1 = await service.synthesize('Cache test', 'en');
      const buf2 = await service.synthesize('Cache test', 'en');
      expect(buf1).toBe(buf2);
    });

    test('different text produces different cache entries', async () => {
      const service = new TtsService();
      await service.synthesize('A', 'en');
      await service.synthesize('B', 'en');
      expect(service.cacheSize).toBe(2);
    });
  });

  describe('cache management', () => {
    test('clearCache empties the cache', async () => {
      const service = new TtsService();
      await service.synthesize('X', 'en');
      expect(service.cacheSize).toBe(1);
      service.clearCache();
      expect(service.cacheSize).toBe(0);
    });
  });
});
