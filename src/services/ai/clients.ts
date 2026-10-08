// src/services/ai/clients.ts
// OpenAI SDK clients for all AI providers (z.ai, Groq, Gemini, HuggingFace Router).
// All use the same OpenAI SDK — only baseURL and apiKey differ.
// Base URLs and API keys are loaded from env via loadConfig() — no hardcoded values.

import OpenAI from 'openai';
import { z } from 'zod';
import { loadConfig } from '../../config/env.ts';

/**
 * Google's OpenAI-compatible endpoint can send its error as a one-element JSON
 * array, `[{ error: { code, message, status, details } }]`. The SDK reads only
 * `body.error`, so it would report `400 status code (no body)` and the chain
 * would retry a deterministic rejection as a dropped request. Extra fields
 * (quota `details`) are kept for the error consumer.
 */
const GeminiErrorArraySchema = z.tuple([
  z.looseObject({
    error: z.looseObject({ code: z.number().int(), message: z.string(), status: z.string() }),
  }),
]);

class GeminiClient extends OpenAI {
  protected override makeStatusError(status: number, error: unknown, message: string | undefined, headers: Headers) {
    const wrapped = GeminiErrorArraySchema.safeParse(error);
    if (wrapped.success) return super.makeStatusError(status, wrapped.data[0], message, headers);
    // An empty body arrives as undefined; `{}` likewise carries no `error` member.
    return super.makeStatusError(status, typeof error === 'object' && error !== null ? error : {}, message, headers);
  }
}

const ZAI_TIMEOUT_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 60_000;

let zai: OpenAI | null = null;
let groq: OpenAI | null = null;
let hf: OpenAI | null = null;
let gemini: OpenAI | null = null;

export function zaiClient(): OpenAI {
  if (!zai) {
    const cfg = loadConfig();
    zai = new OpenAI({
      apiKey: cfg.ZAI_API_KEY,
      baseURL: cfg.ZAI_BASE_URL,
      timeout: ZAI_TIMEOUT_MS,
      maxRetries: 0,
    });
  }
  return zai;
}

export function groqClient(): OpenAI {
  if (!groq) {
    const cfg = loadConfig();
    groq = new OpenAI({
      apiKey: cfg.GROQ_API_KEY!,
      baseURL: 'https://api.groq.com/openai/v1',
      timeout: DEFAULT_TIMEOUT_MS,
      maxRetries: 0,
    });
  }
  return groq;
}

export function hfClient(): OpenAI {
  if (!hf) {
    const cfg = loadConfig();
    hf = new OpenAI({
      apiKey: cfg.HF_TOKEN,
      baseURL: cfg.HF_BASE_URL,
      timeout: DEFAULT_TIMEOUT_MS,
      maxRetries: 0,
    });
  }
  return hf;
}

export function geminiClient(): OpenAI {
  if (!gemini) {
    const cfg = loadConfig();
    gemini = new GeminiClient({
      apiKey: cfg.GEMINI_API_KEY,
      baseURL: cfg.GEMINI_BASE_URL,
      timeout: DEFAULT_TIMEOUT_MS,
      maxRetries: 0,
    });
  }
  return gemini;
}

/** Reset all client singletons. For tests only. */
export function resetClients(): void {
  zai = null;
  groq = null;
  hf = null;
  gemini = null;
}
