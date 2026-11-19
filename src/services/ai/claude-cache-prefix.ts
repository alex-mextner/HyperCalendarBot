// Preserve a trusted static system-prefix boundary without changing compatible JSON requests.
import type OpenAI from 'openai';

const CACHE_PREFIX = Symbol('claudeCachePrefix');
interface CacheableSystemMessage extends OpenAI.ChatCompletionSystemMessageParam {
  content: string;
  [CACHE_PREFIX]: string;
}

/** Internal metadata is not serialized to other providers or debug logs. */
export function cacheableSystemMessage(content: string, prefix: string): CacheableSystemMessage {
  if (!prefix || !content.startsWith(prefix)) throw new TypeError('Invalid system cache prefix');
  return { role: 'system', content, [CACHE_PREFIX]: prefix };
}

export function systemCachePrefix(message: OpenAI.ChatCompletionMessageParam): string | null {
  if (!(CACHE_PREFIX in message)) return null;
  const prefix = message[CACHE_PREFIX];
  return typeof prefix === 'string' && typeof message.content === 'string' && message.content.startsWith(prefix)
    ? prefix
    : null;
}
