// src/config/constants/limits.ts
// Per-user rate limits and account defaults.

// Rate limits
export const RATE_LIMIT = {
  MESSAGES_PER_MINUTE: 30,
  MESSAGES_PER_HOUR: 200,
  ADD_PER_HOUR: 20,
  EXPORT_PER_HOUR: 5,
  COOLDOWN_MS: 60_000,
  AI_PER_MINUTE: 10,
  AI_PER_HOUR: 60,
} as const;

// Defaults
export const DEFAULTS = {
  LANGUAGE: 'en' as const,
  TIMEZONE: 'UTC',
  REMINDER_MINUTES: 15,
  WEEK_STARTS_ON: 1 as const, // Monday
} as const;
