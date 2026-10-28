// src/config/constants/messages/en/agent-status.ts
// AI-agent failure, degraded-mode, timeout and unverified-answer notices, plus rate limiting.

import { EN_AGENT_ERROR_PHRASES, EN_AI_COMMANDS_HINT } from '../../agent-phrases.ts';
import { pickPhrase } from '../../text-helpers.ts';

export const enAgentStatus = {
  agent_error: (exclude?: string) => pickPhrase(EN_AGENT_ERROR_PHRASES, exclude),
  ai_degraded: `🔧 AI unavailable — I can't answer in my own words right now.\n\n${EN_AI_COMMANDS_HINT}`,
  ai_still_down: (next: 'retry' | 'resend' | 'unsure') =>
    next === 'retry'
      ? "🔧 Not done yet: the AI is still unavailable. I'll retry this request myself shortly."
      : next === 'unsure'
        ? "🔧 Not done yet: the AI is still unavailable. If I haven't answered in a few minutes, send this again."
        : '🔧 Not done: the AI is still unavailable. Send this again in a few minutes.',
  agent_give_up: (promised: boolean) =>
    promised
      ? `🔧 Promised to come back — and the AI is still down. Devs are on it.\n\n${EN_AI_COMMANDS_HINT}`
      : `🔧 AI still down — devs are on it.\n\n${EN_AI_COMMANDS_HINT}`,
  agent_restarting: (willRetry: boolean) =>
    willRetry
      ? '🔄 Restarting for an update — I will answer this in a minute.'
      : '🔄 Restarting for an update — this request was not done, send it again in a minute.',
  agent_restarting_unconfirmed:
    '🔄 Restarting for an update — if I have not answered this in a few minutes, send it again.',
  agent_timeout: '⚠️ That took too long — timing out.',
  ai_response_blocked: 'The provider stopped this response. I will not automatically repeat the request.',
  ai_unanswered: '⚠️ I could not answer that — please ask again.',
  ai_unanswered_writes: (writes: string) => `⚠️ I could not put an answer together — here is what I did:\n${writes}`,
  weekdayDateMismatch: {
    fact: (date: string, actual: string, said: string, nearest: string) =>
      `${date} is a ${actual}, not a ${said}; ${said} is ${nearest}`,
    notice: (facts: readonly string[]) =>
      `⚠️ ${facts.join('\n')}\nThe answer mixed up weekdays and dates, so it was not sent. Tell me which day you mean and I will check again.`,
  },
  unverified_answer: 'Could not check this answer against your calendar. Open /today or name the date.',
  unverified_answer_with_events: (events: string) =>
    `Found in your calendar:\n${events}\n\nCould not check my own answer against this data, so here it is as is.`,
  unverified_more_events: (count: number) => `… and ${count} more`,
  rate_limited: 'Slow down, too many messages.',
  stale_update_skipped: '⏳ Missed your message while restarting — send it again if it still matters.',
} as const;
