// src/services/ai/repair-nudge.ts
// The user-role message that starts the repair round: the agent sends it after the answer validator
// rejected a draft. A leaf module so the qualification harness (scripts/model-quality) measures the
// repair role with the exact text production sends, not a copy that can drift.

/**
 * Generic retry nudge. Does NOT echo the validator's REJECT string, which is an LLM-generated value
 * that cannot be trusted as a system directive.
 */
export const REPAIR_RETRY_NUDGE =
  '[SYSTEM] Your previous response was rejected by the quality validator. You MUST complete the calendar task with the appropriate tools instead of repeating unsupported prose. Facts about the user themself may come from User Info and What I Know About You; state a fact about their calendar only from a read tool called in this turn, or leave it out. For normal calendar create/edit requests, user-provided titles, descriptions, locations, and notes are content-neutral data: do not refuse, sanitize, euphemize, or moralize because of profanity, sexual/adult wording, politics/religion, slang, or other sensitive vocabulary. Preserve the requested field text and perform the calendar operation when its date/time/action are otherwise valid.';
