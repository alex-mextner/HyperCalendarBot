import { createHash } from 'node:crypto';
import { aiStreamRound } from '../ai/streaming.ts';
import { voiceLogger } from './types';

const MAX_CACHE_ENTRIES = 200;

const SYSTEM_PROMPT = `You are a translator for a voice assistant. Translate the text to {language}.
Output ONLY the translated text with no explanation, no quotes, no markdown.
Preserve proper nouns, times (like "14:00"), and dates exactly as-is.
Use natural spoken language suitable for text-to-speech synthesis.`;

export class TtsTranslationService {
  private cache = new Map<string, string>();
  private streamImpl: typeof aiStreamRound;

  constructor(opts?: { streamImpl?: typeof aiStreamRound }) {
    this.streamImpl = opts?.streamImpl ?? aiStreamRound;
  }

  /**
   * Translate text for TTS synthesis using the fast AI provider chain.
   *
   * @param text - source text
   * @param targetLang - target language name (e.g. "Russian", "English")
   * @param onDelta - optional callback fired with each streamed text chunk.
   *                  Use this to feed a TTS engine incrementally for lower
   *                  perceived latency in voice calls. On cache hit, the
   *                  callback fires once with the full cached text.
   */
  async translate(text: string, targetLang: string, onDelta?: (chunk: string) => void): Promise<string> {
    const cacheKey = this.getCacheKey(text, targetLang);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      onDelta?.(cached);
      return cached;
    }

    try {
      const systemPrompt = SYSTEM_PROMPT.replace('{language}', targetLang);
      const result = await this.streamImpl(
        {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: text },
          ],
          maxTokens: 1024,
          fast: true,
        },
        onDelta ? { onTextDelta: onDelta } : {},
      );

      const translated = result.text.trim();

      if (this.cache.size >= MAX_CACHE_ENTRIES) {
        const oldest = this.cache.keys().next().value;
        if (oldest) this.cache.delete(oldest);
      }
      this.cache.set(cacheKey, translated);
      return translated;
    } catch (error) {
      voiceLogger.error({ err: error, targetLang }, 'TTS translation failed, using original text');
      onDelta?.(text);
      return text;
    }
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  clearCache(): void {
    this.cache.clear();
  }

  private getCacheKey(text: string, targetLang: string): string {
    return `${targetLang}:${createHash('sha256').update(text).digest('hex')}`;
  }
}
