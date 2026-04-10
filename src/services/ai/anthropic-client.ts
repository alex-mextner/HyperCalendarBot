// src/services/ai/anthropic-client.ts
import Anthropic from '@anthropic-ai/sdk';

/**
 * Creates an Anthropic client using ZAI_API_KEY and ZAI_BASE_URL from env.
 * Kept for transitional compatibility while the codebase migrates to the
 * OpenAI SDK. Pass opts to override env defaults.
 */
export function createAnthropicClient(opts?: { apiKey?: string; baseURL?: string }): Anthropic {
  return new Anthropic({
    apiKey: opts?.apiKey ?? process.env.ZAI_API_KEY,
    baseURL: opts?.baseURL ?? process.env.ZAI_BASE_URL,
  });
}
