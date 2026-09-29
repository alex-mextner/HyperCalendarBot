// src/services/ai/event-summaries.ts
// Reads the events a tool result carries in its structured `data` side channel.
// Shared by the intent executor (fast-path rendering) and the agent's tool
// executor (reply-time guard evidence) so both agree on what counts as an event.

import type { EventSummary } from '../intent/variable-resolver.ts';
import type { ScheduledAiCall, Trigger } from '../scheduled/types.ts';
import type { ContactMatch, FreeSlotsData, TelegramSessionData, ToolResultData, UserInspection } from './types.ts';

type ToolResultElement =
  | UserInspection
  | EventSummary
  | { telegram_id: number; name: string }
  | { contact_id: number; deleted: boolean }
  | { matches: ContactMatch[] }
  | FreeSlotsData
  | ScheduledAiCall
  | Trigger
  | TelegramSessionData;

/** Type guard: checks if a ToolResultData element has the full EventSummary shape. */
export function isEventSummary(obj: ToolResultElement): obj is EventSummary {
  // All ToolResultData element types have 'id', but only EventSummary has 'date' and 'all_day'
  return 'date' in obj && 'all_day' in obj;
}

/**
 * Every event behind a result: a list of events, or a single event (e.g. get_event's result,
 * which is not array-wrapped). Undefined when the data holds no event at all.
 */
export function extractEventSummaries(data: ToolResultData | undefined): EventSummary[] | undefined {
  if (data === undefined) return undefined;
  if (!Array.isArray(data)) return isEventSummary(data) ? [data] : undefined;
  if (data.length === 0) return undefined;
  const events: EventSummary[] = [];
  for (const item of data) {
    if (!isEventSummary(item)) return undefined;
    events.push(item);
  }
  return events;
}
