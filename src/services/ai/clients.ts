// src/services/ai/clients.ts
// OpenAI SDK clients for all AI providers (z.ai, HuggingFace Router, Gemini).
// All use the same OpenAI SDK — only baseURL and apiKey differ.
// Base URLs and API keys are loaded from env via loadConfig() — no hardcoded values.

import OpenAI from 'openai';
import { loadConfig } from '../../config/env.ts';

const ZAI_TIMEOUT_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 60_000;

let zai: OpenAI | null = null;
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
    gemini = new OpenAI({
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
  hf = null;
  gemini = null;
}
