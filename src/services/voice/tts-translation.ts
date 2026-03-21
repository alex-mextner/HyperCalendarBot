import { createHash } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { createAnthropicClient } from '../ai/anthropic-client.ts';
import { voiceLogger } from './types';

const MAX_CACHE_ENTRIES = 200;

const SYSTEM_PROMPT = `You are a translator for a voice assistant. Translate the text to {language}.
Output ONLY the translated text with no explanation, no quotes, no markdown.
Preserve proper nouns, times (like "14:00"), and dates exactly as-is.
Use natural spoken language suitable for text-to-speech synthesis.`;

export class TtsTranslationService {
  private client: Anthropic;
  private model: string;
  private cache = new Map<string, string>();

  constructor(opts?: { apiKey?: string; baseUrl?: string; model?: string }) {
    this.client = createAnthropicClient({ apiKey: opts?.apiKey, baseURL: opts?.baseUrl });
    this.model = opts?.model ?? 'claude-haiku-4-5-20251001';
  }

  async translate(text: string, targetLang: string): Promise<string> {
    const cacheKey = this.getCacheKey(text, targetLang);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    try {
      const systemPrompt = SYSTEM_PROMPT.replace('{language}', targetLang);
      const message = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: text }],
      });

      const block = message.content[0];
      const translated = block && block.type === 'text' ? block.text.trim() : text;

      if (this.cache.size >= MAX_CACHE_ENTRIES) {
        const oldest = this.cache.keys().next().value;
        if (oldest) this.cache.delete(oldest);
      }
      this.cache.set(cacheKey, translated);
      return translated;
    } catch (error) {
      voiceLogger.error({ err: error, targetLang }, 'TTS translation failed, using original text');
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
