import { describe, expect, mock, test } from 'bun:test';

// Mock edge-tts before importing TtsService
const mockTts = mock(async (_text: string, _options?: { voice?: string }) => {
  return Buffer.from('fake-audio-data');
});
mock.module('edge-tts', () => ({
  tts: mockTts,
}));

const { TtsService } = await import('../../../src/services/voice/tts-service');

describe('TtsService', () => {
  describe('getVoice', () => {
    test('returns English voice for "en"', () => {
      const service = new TtsService();
      expect(service.getVoice('en')).toBe('en-US-AriaNeural');
    });

    test('returns Russian voice for "ru"', () => {
      const service = new TtsService();
      expect(service.getVoice('ru')).toBe('ru-RU-SvetlanaNeural');
    });

    test('falls back to English voice for unknown language', () => {
      const service = new TtsService();
      expect(service.getVoice('fr')).toBe('en-US-AriaNeural');
      expect(service.getVoice('')).toBe('en-US-AriaNeural');
    });
  });

  describe('synthesize', () => {
    test('returns a Buffer', async () => {
      const service = new TtsService();
      const buffer = await service.synthesize('Hello world', 'en');
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(0);
    });

    test('calls edge-tts with correct voice', async () => {
      mockTts.mockClear();
      const service = new TtsService();
      await service.synthesize('Привет', 'ru');
      expect(mockTts).toHaveBeenCalledWith('Привет', {
        voice: 'ru-RU-SvetlanaNeural',
      });
    });

    test('caches repeated calls — same reference returned', async () => {
      const service = new TtsService();
      const buf1 = await service.synthesize('Test phrase', 'en');
      const buf2 = await service.synthesize('Test phrase', 'en');
      expect(buf1).toBe(buf2);
    });

    test('different text produces different cache entries', async () => {
      const service = new TtsService();
      await service.synthesize('Text A', 'en');
      await service.synthesize('Text B', 'en');
      expect(service.cacheSize).toBe(2);
    });

    test('same text with different language produces different cache entries', async () => {
      const service = new TtsService();
      await service.synthesize('Hello', 'en');
      await service.synthesize('Hello', 'ru');
      expect(service.cacheSize).toBe(2);
    });
  });

  describe('cache management', () => {
    test('clearCache empties the cache', async () => {
      const service = new TtsService();
      await service.synthesize('Some text', 'en');
      expect(service.cacheSize).toBe(1);
      service.clearCache();
      expect(service.cacheSize).toBe(0);
    });

    test('cacheSize reflects number of cached entries', async () => {
      const service = new TtsService();
      expect(service.cacheSize).toBe(0);
      await service.synthesize('One', 'en');
      expect(service.cacheSize).toBe(1);
      await service.synthesize('Two', 'en');
      expect(service.cacheSize).toBe(2);
    });
  });
});
