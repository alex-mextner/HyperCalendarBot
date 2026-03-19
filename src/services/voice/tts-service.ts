import { createHash } from 'node:crypto';
import { voiceLogger } from './types';

const LANG_MAP: Record<string, string> = {
  en: 'en',
  ru: 'ru',
};

const MAX_CACHE_ENTRIES = 100;
const MAX_CHUNK_LENGTH = 200;

function splitTextIntoChunks(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Split at sentence boundary
    const slice = remaining.slice(0, maxLen);
    const dotIdx = slice.lastIndexOf('.');
    const commaIdx = slice.lastIndexOf(',');
    const spaceIdx = slice.lastIndexOf(' ');
    const splitAt = dotIdx > 0 ? dotIdx + 1 : commaIdx > 0 ? commaIdx + 1 : spaceIdx > 0 ? spaceIdx : maxLen;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  return chunks;
}

export class TtsService {
  private cache = new Map<string, Buffer>();

  async synthesize(text: string, language: string): Promise<Buffer> {
    const cacheKey = this.getCacheKey(text, language);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const lang = LANG_MAP[language] ?? 'en';
    const chunks = splitTextIntoChunks(text, MAX_CHUNK_LENGTH);
    const audioChunks: Buffer[] = [];

    for (const chunk of chunks) {
      const encoded = encodeURIComponent(chunk);
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${lang}&client=tw-ob&q=${encoded}`;
      const response = await fetch(url);
      if (!response.ok) {
        voiceLogger.error({ status: response.status, chunk: chunk.slice(0, 50) }, 'Google TTS request failed');
        throw new Error(`TTS failed: HTTP ${response.status}`);
      }
      const arrayBuf = await response.arrayBuffer();
      audioChunks.push(Buffer.from(arrayBuf));
    }

    const result = Buffer.concat(audioChunks);
    voiceLogger.info(
      { engine: 'google', language: lang, textLen: text.length, audioBytes: result.length },
      'TTS synthesized',
    );

    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.set(cacheKey, result);
    return result;
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
