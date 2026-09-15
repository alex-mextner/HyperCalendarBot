// src/services/ai/provider-ids.ts
//
// A leaf on purpose: it imports nothing. Both the config layer (which validates
// the chain order named in the environment) and the AI layer (which owns the
// clients) need this list, and a shared constant that imports either of them
// could be undefined at startup depending on which module loads first.

/**
 * Every provider the bot can talk to, and the source the rest of the code
 * derives from: the chain order in the environment is validated against this
 * list, so a provider added here becomes nameable in AI_SMART_CHAIN with no
 * second edit — and one that is not here cannot be named by accident.
 */
export const PROVIDER_IDS = ['zai', 'groq', 'gemini', 'hf', 'mimo'] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];
