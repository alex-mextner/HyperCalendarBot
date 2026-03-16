import { createHash } from 'node:crypto';
import { tts } from 'edge-tts';

const VOICES: Record<string, string> = {
  en: 'en-US-AriaNeural',
  ru: 'ru-RU-SvetlanaNeural',
};

const MAX_CACHE_ENTRIES = 100;

export class TtsService {
  private cache = new Map<string, Buffer>();

  getVoice(language: string): string {
    return VOICES[language] ?? VOICES.en;
  }

  async synthesize(text: string, language: string): Promise<Buffer> {
    const cacheKey = this.getCacheKey(text, language);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const voice = this.getVoice(language);
    const buffer = await tts(text, { voice });
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(cacheKey, buffer);
    return buffer;
  }

  clearCache(): void {
    this.cache.clear();
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  private getCacheKey(text: string, language: string): string {
    return createHash('sha256').update(`${language}:${text}`).digest('hex');
  }
}
