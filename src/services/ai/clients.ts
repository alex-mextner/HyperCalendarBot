// src/services/ai/clients.ts
// OpenAI SDK clients for all AI providers (z.ai, Groq, Gemini, HuggingFace Router).
// All use the same OpenAI SDK — only baseURL and apiKey differ.
// Base URLs and API keys are loaded from env via loadConfig() — no hardcoded values.

import OpenAI from 'openai';
import { loadConfig } from '../../config/env.ts';

const ZAI_TIMEOUT_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 60_000;

let zai: OpenAI | null = null;
let groq: OpenAI | null = null;
let hf: OpenAI | null = null;
let gemini: OpenAI | null = null;
let cerebras: OpenAI | null = null;
let together: OpenAI | null = null;

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
    gemini = new OpenAI({
      apiKey: cfg.GEMINI_API_KEY,
      baseURL: cfg.GEMINI_BASE_URL,
      timeout: DEFAULT_TIMEOUT_MS,
      maxRetries: 0,
    });
  }
  return gemini;
}

export function cerebrasClient(): OpenAI {
  if (!cerebras) {
    const cfg = loadConfig();
    cerebras = new OpenAI({
      apiKey: cfg.CEREBRAS_KEY!,
      baseURL: cfg.CEREBRAS_BASE_URL,
      timeout: DEFAULT_TIMEOUT_MS,
      maxRetries: 0,
    });
  }
  return cerebras;
}

export function togetherClient(): OpenAI {
  if (!together) {
    const cfg = loadConfig();
    together = new OpenAI({
      apiKey: cfg.TOGETHER_KEY!,
      baseURL: cfg.TOGETHER_BASE_URL,
      timeout: DEFAULT_TIMEOUT_MS,
      maxRetries: 0,
    });
  }
  return together;
}

/** Reset all client singletons. For tests only. */
export function resetClients(): void {
  zai = null;
  groq = null;
  hf = null;
  gemini = null;
  cerebras = null;
  together = null;
}
