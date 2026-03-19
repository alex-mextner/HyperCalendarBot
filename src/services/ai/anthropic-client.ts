// src/services/ai/anthropic-client.ts
import Anthropic from '@anthropic-ai/sdk';

/**
 * Creates an Anthropic client using AI_BASE_URL and ANTHROPIC_API_KEY from env.
 * Pass opts to override env defaults.
 */
export function createAnthropicClient(opts?: { apiKey?: string; baseURL?: string }): Anthropic {
  return new Anthropic({
    apiKey: opts?.apiKey ?? process.env.ANTHROPIC_API_KEY,
    baseURL: opts?.baseURL ?? process.env.AI_BASE_URL,
  });
}
