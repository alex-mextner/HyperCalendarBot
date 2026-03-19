import { afterAll, describe, expect, mock, test } from 'bun:test';

// Mock Anthropic before importing TtsTranslationService
const mockCreate = mock(() =>
  Promise.resolve({
    content: [{ type: 'text', text: 'Привет, мир' }],
  }),
);

mock.module('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
  },
}));

const { TtsTranslationService } = await import('../../../src/services/voice/tts-translation');

afterAll(() => mock.restore());

describe('TtsTranslationService', () => {
  test('translate calls Anthropic and returns translated text', async () => {
    const service = new TtsTranslationService();
    const result = await service.translate('Hello, world', 'ru');
    expect(result).toBe('Привет, мир');
    expect(mockCreate).toHaveBeenCalled();
  });

  test('translate passes correct model and system prompt', async () => {
    const service = new TtsTranslationService();
    await service.translate('Good morning', 'ru');
    const callArgs = (
      mockCreate.mock.calls[mockCreate.mock.calls.length - 1] as unknown as [Record<string, unknown>]
    )[0];
    expect((callArgs as { model: string }).model).toBe('claude-haiku-4-5-20251001');
    expect((callArgs as { system: string }).system).toContain('ru');
    expect((callArgs as { system: string }).system).toContain('translator');
    expect((callArgs as { messages: { content: string }[] }).messages[0]!.content).toBe('Good morning');
  });

  test('translate caches results — second call does not call Anthropic', async () => {
    const service = new TtsTranslationService();
    const callsBefore = mockCreate.mock.calls.length;
    await service.translate('Unique cache text abc', 'en');
    await service.translate('Unique cache text abc', 'en');
    expect(mockCreate.mock.calls.length).toBe(callsBefore + 1);
    expect(service.cacheSize).toBeGreaterThan(0);
  });

  test('different languages produce different cache keys', async () => {
    const service = new TtsTranslationService();
    const callsBefore = mockCreate.mock.calls.length;
    await service.translate('Lang key text xyz', 'en');
    await service.translate('Lang key text xyz', 'ru');
    expect(mockCreate.mock.calls.length).toBe(callsBefore + 2);
    expect(service.cacheSize).toBe(2);
  });

  test('clearCache resets cache size to 0', async () => {
    const service = new TtsTranslationService();
    await service.translate('Cache clear test text', 'en');
    expect(service.cacheSize).toBeGreaterThan(0);
    service.clearCache();
    expect(service.cacheSize).toBe(0);
  });

  test('returns original text on error', async () => {
    const failCreate = mock(() => Promise.reject(new Error('API error')));
    mock.module('@anthropic-ai/sdk', () => ({
      default: class MockAnthropic {
        messages = { create: failCreate };
      },
    }));

    const { TtsTranslationService: Service } = await import('../../../src/services/voice/tts-translation');
    const service = new Service();
    const result = await service.translate('Fallback text', 'ru');
    expect(result).toBe('Fallback text');
  });
});
