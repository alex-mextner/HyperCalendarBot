import { describe, expect, mock, test } from 'bun:test';
import type OpenAI from 'openai';
import type { StreamRoundOptions, StreamRoundResult } from '../../../src/services/ai/streaming.ts';
import { TtsTranslationService } from '../../../src/services/voice/tts-translation.ts';

/** Build a scripted streamImpl that returns a fixed translation string. */
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

describe('TtsTranslationService', () => {
  test('translate calls the stream impl and returns translated text', async () => {
    const streamImpl = stubStream('Привет, мир');
    const service = new TtsTranslationService({ streamImpl });
    const result = await service.translate('Hello, world', 'ru');
    expect(result).toBe('Привет, мир');
    expect(streamImpl).toHaveBeenCalled();
  });

  test('translate forwards the language into the system prompt', async () => {
    const streamImpl = stubStream('Доброе утро');
    const service = new TtsTranslationService({ streamImpl });
    await service.translate('Good morning', 'ru');

    const call = streamImpl.mock.calls[streamImpl.mock.calls.length - 1]!;
    const opts = call[0] as StreamRoundOptions;
    expect(opts.fast).toBe(true);
    const system = opts.messages[0];
    expect(system?.role).toBe('system');
    expect(system?.content as string).toContain('ru');
    expect(system?.content as string).toContain('translator');
    const user = opts.messages[1];
    expect(user?.role).toBe('user');
    expect(user?.content).toBe('Good morning');
  });

  test('translate caches results — second call does not hit the stream impl', async () => {
    const streamImpl = stubStream('кешированный');
    const service = new TtsTranslationService({ streamImpl });
    await service.translate('cache-text', 'ru');
    await service.translate('cache-text', 'ru');
    expect(streamImpl).toHaveBeenCalledTimes(1);
    expect(service.cacheSize).toBeGreaterThan(0);
  });

  test('different languages produce different cache keys', async () => {
    const streamImpl = stubStream('translated');
    const service = new TtsTranslationService({ streamImpl });
    await service.translate('same text', 'en');
    await service.translate('same text', 'ru');
    expect(streamImpl).toHaveBeenCalledTimes(2);
    expect(service.cacheSize).toBe(2);
  });

  test('clearCache resets cache size to 0', async () => {
    const streamImpl = stubStream('x');
    const service = new TtsTranslationService({ streamImpl });
    await service.translate('Cache clear test text', 'en');
    expect(service.cacheSize).toBeGreaterThan(0);
    service.clearCache();
    expect(service.cacheSize).toBe(0);
  });

  test('returns original text on streaming error', async () => {
    const streamImpl = mock(async () => {
      throw new Error('all providers failed');
    });
    const service = new TtsTranslationService({ streamImpl });
    const result = await service.translate('Fallback text', 'ru');
    expect(result).toBe('Fallback text');
  });

  test('calls onDelta incrementally when provided', async () => {
    // Stream impl that fires onTextDelta twice before returning.
    const streamImpl = mock(async (_opts: StreamRoundOptions, cbs: { onTextDelta?: (t: string) => void } = {}) => {
      cbs.onTextDelta?.('Привет ');
      cbs.onTextDelta?.('мир');
      const msg: OpenAI.ChatCompletionMessageParam = { role: 'assistant', content: 'Привет мир' };
      return {
        text: 'Привет мир',
        toolCalls: [],
        finishReason: 'stop' as const,
        assistantMessage: msg,
        providerUsed: 'stub',
      };
    });

    const chunks: string[] = [];
    const service = new TtsTranslationService({ streamImpl });
    const result = await service.translate('Hello world', 'ru', (chunk) => {
      chunks.push(chunk);
    });
    expect(result).toBe('Привет мир');
    expect(chunks).toEqual(['Привет ', 'мир']);
  });

  test('cache hit fires onDelta once with the cached text', async () => {
    const streamImpl = stubStream('Привет');
    const service = new TtsTranslationService({ streamImpl });
    await service.translate('hi', 'ru'); // prime the cache

    const chunks: string[] = [];
    const result = await service.translate('hi', 'ru', (chunk) => {
      chunks.push(chunk);
    });
    expect(result).toBe('Привет');
    expect(chunks).toEqual(['Привет']);
  });
});
