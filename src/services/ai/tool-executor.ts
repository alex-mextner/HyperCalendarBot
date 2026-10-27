import type { z } from 'zod';
import type { FeatureKey } from '../../database/repositories/feature-usage.repository.ts';
import { logger } from '../../utils/logger.ts';
import { checkDayReferences, checkQuestionWeekdays } from './day-reference-guard.ts';
import { extractEventSummaries } from './event-summaries.ts';
import { dispatchTool } from './tool-dispatch.ts';
import { handleGetActionLog } from './tool-handlers/action-log.ts';
import { handleCalculate } from './tool-handlers/calculate.ts';
import { handleFindContact, handleGetContacts, handleGetUserInfo } from './tool-handlers/contacts.ts';
import { handleGetEvent, handleGetEvents, handleGetUpcoming, handleSearchEvents } from './tool-handlers/events.ts';
import { handleGetHistory } from './tool-handlers/history.ts';
import {
  handleAskUser,
  handleEndConversation,
  handleFindUser,
  handleGetBotInfo,
  handleGetGoogleCalendarStatus,
  handleGetHolidays,
  handleListGoogleCalendars,
  handleLookupStress,
  handlePickUsers,
} from './tool-handlers/meta.ts';
import type { ProposeInput } from './tool-handlers/proposals.ts';
import { handleGetReminders } from './tool-handlers/reminders.ts';
import {
  handleRenderDayImage,
  handleRenderMonthImage,
  handleRenderTable,
  handleRenderWeekImage,
} from './tool-handlers/render.ts';
import { handleCancelScene, handleResumeScene } from './tool-handlers/scenes.ts';
import {
  handleListTriggers,
  handleScheduleAiCallsList,
  type ScheduleAiCallInput,
  type TriggerIdInput,
  type TriggerInput,
} from './tool-handlers/scheduled.ts';
import { handleListCalendarAccess } from './tool-handlers/secretary.ts';
import type { ManageSettingsInput } from './tool-handlers/settings.ts';
import { handleConnectTelegramStatus, handleDismissConnectTelegramPrompt } from './tool-handlers/settings.ts';
import { handleGetInvitationStatus } from './tool-handlers/sharing.ts';
import { handleGetFreeSlots } from './tool-handlers/slots.ts';
import { handleConvertToTimezone, handleGetTimezoneInfoWithCityFallback } from './tool-handlers/timezone.ts';
import { toolSchemas } from './tool-schemas.ts';
import { withSchemaExcerpt } from './tools.ts';
import type { AgentContext, ToolResult } from './types.ts';

/**
 * Maps every known tool name to its expected input shape.
 * Tools with no input use `Record<never, never>`.
 */
export interface ToolInputMap {
  supplement_skip: Record<never, never>;
  end_conversation: Record<never, never>;
  get_events: { start_date: string; end_date: string; scope?: 'personal' | 'group' };
  create_event: {
    title: string;
    start_at: string;
    end_at?: string;
    description?: string;
    location?: string;
    all_day?: boolean;
    recurrence_rule?: string;
    reminder_minutes?: number[];
    force?: boolean;
    scope?: 'personal' | 'group';
  };
  update_event: {
    event_id: number;
    title?: string;
    start_at?: string;
    end_at?: string | null;
    description?: string | null;
    location?: string | null;
    recurrence_rule?: string | null;
    scope?: 'personal' | 'group';
  };
  attach_pending_location_to_event: { event_id: number };
  delete_event: { event_id: number; scope?: 'personal' | 'group' };
  get_free_slots: { date: string; scope?: 'personal' | 'group' };
  search_events: { query?: string; scope?: 'personal' | 'group'; event_type?: 'birthday' | 'regular' };
  create_birthday_event: {
    celebrant_id: number;
    date: { day: number; month: number };
    year?: number;
    custom_name?: string;
    group_id?: number;
  };
  get_upcoming: { limit?: number; scope?: 'personal' | 'group' };
  snooze_event: { event_id: number; minutes?: number; scope?: 'personal' | 'group' };
  get_event: { event_id: number; scope?: 'personal' | 'group' };
  notify_participants: { event_id: number; message: string };
  get_reminders: {
    event_id?: number;
    event_ids?: number[];
    query?: string;
    scope?: 'personal' | 'group';
    owner_id?: number;
  };
  set_reminder: { event_id: number; minutes_before: number[]; scope?: 'personal' | 'group'; owner_id?: number };
  find_user: { username: string };
  ask_user: { question: string; options: string[]; event_ids?: number[] };
  pick_users: { event_id: number; prompt: string };
  get_contacts: { force?: boolean };
  get_user_info: { telegram_id: number };
  delete_contact: { contact_id: number };
  add_contact: { name: string; username?: string };
  find_contact: { name: string };
  update_contact: { search: string; name?: string; preferred_name?: string; username?: string };
  render_day_image: { date: string; scope?: 'personal' | 'group'; owner_id?: number };
  render_week_image: { week_start: string; scope?: 'personal' | 'group'; owner_id?: number };
  render_month_image: { month: string; scope?: 'personal' | 'group'; owner_id?: number };
  render_table: { title: string; markdown: string; caption?: string };
  end_call: Record<never, never>;
  make_call: { text: string };
  get_holidays: { limit?: number };
  manage_settings: ManageSettingsInput;
  share_event: { event_id: number; target_type: 'user' | 'group'; target_id: number };
  send_invitation: { event_id: number; invitee_id?: number; invitee_username?: string; force?: boolean };
  get_invitation_status: { event_id: number };
  share_agenda: { period: 'today' | 'tomorrow' | 'week'; target_type: 'user' | 'group'; target_id: number };
  set_event_visibility: { event_id: number; visibility: 'private' | 'free_busy' | 'full'; owner_id?: number };
  propose_edit: { event_id: number; changes: Record<string, string | null>; reason?: string };
  cancel_invitation: { invitation_id: number };
  resend_invitation: { invitation_id: number; invitee_username?: string };
  get_google_calendar_status: Record<never, never>;
  list_google_calendars: Record<never, never>;
  lookup_stress: { words: string[] };
  send_feedback: { type: 'bug' | 'feature' | 'question' | 'other'; message: string };
  get_bot_info: Record<never, never>;
  calculate: { expression: string };
  get_timezone_info: { timezone: string | string[]; at?: string };
  convert_to_timezone: { datetime: string; timezone: string };
  list_calendar_access: Record<never, never>;
  manage_secretaries: {
    action: 'invite' | 'revoke' | 'self_remove';
    secretary_telegram_id?: number;
    permission?: 'read' | 'write';
    secretary_access_id?: number;
  };
  propose_calendar_change: ProposeInput;
  get_history: { limit?: number; search?: string; before?: string; after?: string };
  get_action_log: {
    event_id?: number;
    action_type?: string;
    action_name?: string;
    after?: string;
    before?: string;
    limit?: number;
  };
  schedule_ai_call: ScheduleAiCallInput;
  schedule_ai_calls_list: Record<never, never>;
  schedule_ai_call_cancel: TriggerIdInput;
  add_trigger: TriggerInput;
  list_triggers: Record<never, never>;
  remove_trigger: TriggerIdInput;
  set_reaction: { message_id?: number; emoji: string };
  remember_user_fact: { type: 'append' | 'rewrite'; content: string };
  connect_telegram_status: Record<never, never>;
  dismiss_connect_telegram_prompt: Record<never, never>;
  resume_scene: Record<never, never>;
  cancel_scene: Record<never, never>;
}

export type ToolName = keyof ToolInputMap;

const aiLogger = logger.child({ module: 'ai' });

// ── Cross-run time throttle ────────────────────────────────────────────────
const THROTTLE_TTL_MS = 5_000;
const THROTTLE_MAX_ENTRIES = 1_000;

const throttleMap = new Map<string, number>();

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const sorted = Object.keys(value as { [key: string]: unknown }).sort();
  const parts = sorted.map((k) => `${JSON.stringify(k)}:${stableStringify((value as { [key: string]: unknown })[k])}`);
  return `{${parts.join(',')}}`;
}

function buildThrottleKey(chatId: number, toolName: string, input: unknown): string {
  let canonicalArgs: string;
  if (input && typeof input === 'object') {
    const record = input as { [key: string]: unknown };
    const schema = toolSchemas[toolName as keyof typeof toolSchemas];
    const knownKeys =
      schema && 'shape' in schema ? Object.keys((schema as { shape: { [key: string]: unknown } }).shape) : null;
    const filteredKeys = knownKeys
      ? Object.keys(record)
          .filter((k) => knownKeys.includes(k))
          .sort()
      : Object.keys(record).sort();
    const canonical: { [key: string]: unknown } = {};
    for (const k of filteredKeys) canonical[k] = record[k];
    canonicalArgs = stableStringify(canonical);
  } else {
    canonicalArgs = JSON.stringify(input);
  }
  return `${chatId}:${toolName}:${canonicalArgs}`;
}

function evictStaleThrottleEntries(now: number): void {
  if (throttleMap.size < THROTTLE_MAX_ENTRIES) return;
  for (const [key, ts] of throttleMap) {
    if (now - ts >= THROTTLE_TTL_MS) throttleMap.delete(key);
  }
  if (throttleMap.size >= THROTTLE_MAX_ENTRIES) {
    const excess = throttleMap.size - THROTTLE_MAX_ENTRIES + 100;
    let removed = 0;
    for (const key of throttleMap.keys()) {
      if (removed >= excess) break;
      throttleMap.delete(key);
      removed++;
    }
  }
}

export function _resetToolThrottleForTest(): void {
  throttleMap.clear();
}

const THROTTLE_MARKER =
  'THROTTLED: this tool was just called with identical arguments (within the last 5 seconds). ' +
  'Use the previous result. Do NOT call it again — respond to the user or call a different tool.';

// biome-ignore lint/suspicious/noExplicitAny: handler functions have heterogeneous signatures — we only read .meta
const HANDLER_MAP: { [tool: string]: { meta?: import('./types.ts').ToolHandlerMeta } & ((...args: any[]) => any) } = {
  get_events: handleGetEvents,
  get_event: handleGetEvent,
  get_upcoming: handleGetUpcoming,
  get_free_slots: handleGetFreeSlots,
  search_events: handleSearchEvents,
  get_reminders: handleGetReminders,
  get_contacts: handleGetContacts,
  get_user_info: handleGetUserInfo,
  find_contact: handleFindContact,
  find_user: handleFindUser,
  get_history: handleGetHistory,
  get_holidays: handleGetHolidays,
  get_invitation_status: handleGetInvitationStatus,
  get_google_calendar_status: handleGetGoogleCalendarStatus,
  list_google_calendars: handleListGoogleCalendars,
  list_calendar_access: handleListCalendarAccess,
  get_timezone_info: handleGetTimezoneInfoWithCityFallback,
  convert_to_timezone: handleConvertToTimezone,
  get_bot_info: handleGetBotInfo,
  calculate: handleCalculate,
  lookup_stress: handleLookupStress,
  schedule_ai_calls_list: handleScheduleAiCallsList,
  list_triggers: handleListTriggers,
  get_action_log: handleGetActionLog,
  ask_user: handleAskUser,
  pick_users: handlePickUsers,
  end_conversation: handleEndConversation,
  render_day_image: handleRenderDayImage,
  render_week_image: handleRenderWeekImage,
  render_month_image: handleRenderMonthImage,
  render_table: handleRenderTable,
  resume_scene: handleResumeScene,
  cancel_scene: handleCancelScene,
  connect_telegram_status: handleConnectTelegramStatus,
  dismiss_connect_telegram_prompt: handleDismissConnectTelegramPrompt,
};

const INLINE_TOOL_META: { [tool: string]: import('./types.ts').ToolHandlerMeta } = {
  supplement_skip: { skipActionLog: true },
  set_reaction: { skipActionLog: true, silent: true },
};

function getToolMeta(toolName: string): import('./types.ts').ToolHandlerMeta | undefined {
  const handler = HANDLER_MAP[toolName];
  if (handler?.meta) return handler.meta;
  return INLINE_TOOL_META[toolName];
}

const THROTTLE_EXEMPT = new Set(
  [...Object.keys(HANDLER_MAP), ...Object.keys(INLINE_TOOL_META)].filter(
    (k) => getToolMeta(k)?.readonly || getToolMeta(k)?.throttleExempt,
  ),
);

const SKIP_ACTION_LOG = new Set(
  [...Object.keys(HANDLER_MAP), ...Object.keys(INLINE_TOOL_META)].filter((k) => getToolMeta(k)?.skipActionLog),
);

/** Known writes use the same metadata classification as the action log. */
export const WRITE_TOOLS = new Set(Object.keys(toolSchemas).filter((name) => !SKIP_ACTION_LOG.has(name)));

export function isMutationTool(toolName: string, input: unknown): boolean {
  if (!WRITE_TOOLS.has(toolName)) return false;
  return (
    toolName !== 'manage_settings' ||
    !(typeof input === 'object' && input !== null && Reflect.get(input, 'action') === 'get')
  );
}

/**
 * A call that only reads: its handler is marked readonly and this input writes nothing.
 * Tools outside the action log can still show something (a picture, a reaction).
 */
export function isReadOnlyCall(toolName: string, input: unknown): boolean {
  return getToolMeta(toolName)?.readonly === true && !isMutationTool(toolName, input);
}

/** Derived: tools that always result in [SKIP] — no status message or tool label. */
export const SILENT_TOOLS = new Set(
  [...Object.keys(HANDLER_MAP), ...Object.keys(INLINE_TOOL_META)].filter((k) => getToolMeta(k)?.silent),
);

/** Derived: tools that send the answer itself to the chat (a rendered image). */
export const DELIVERING_TOOLS = new Set(
  [...Object.keys(HANDLER_MAP), ...Object.keys(INLINE_TOOL_META)].filter((k) => getToolMeta(k)?.delivers),
);

/** Derived: tools whose results must NOT be saved to chat_history (meta/query tools). */
export const SKIP_PERSIST_TOOLS = new Set(
  [...Object.keys(HANDLER_MAP), ...Object.keys(INLINE_TOOL_META)].filter((k) => getToolMeta(k)?.skipPersist),
);

/** Maps tool names to feature keys for usage tracking. Only includes tools that map to a trackable feature. */
const TOOL_FEATURE_MAP: { [tool: string]: FeatureKey } = {
  create_event: 'events_create',
  create_birthday_event: 'events_create',
  update_event: 'events_edit',
  attach_pending_location_to_event: 'geolocation',
  delete_event: 'events_edit',
  snooze_event: 'events_edit',
  get_event: 'events_create',
  get_events: 'events_create',
  get_upcoming: 'events_create',
  search_events: 'events_create',
  set_reminder: 'reminders',
  get_reminders: 'reminders',
  get_free_slots: 'free_slots',
  share_event: 'sharing',
  send_invitation: 'sharing',
  share_agenda: 'sharing',
  set_event_visibility: 'sharing',
  cancel_invitation: 'sharing',
  resend_invitation: 'sharing',
  propose_edit: 'sharing',
  get_invitation_status: 'sharing',
  notify_participants: 'sharing',
  get_contacts: 'contacts',
  get_user_info: 'contacts',
  add_contact: 'contacts',
  find_contact: 'contacts',
  update_contact: 'contacts',
  delete_contact: 'contacts',
  get_holidays: 'holidays',
  get_google_calendar_status: 'google_calendar',
  list_google_calendars: 'google_calendar',
  make_call: 'voice_calls',
  end_call: 'voice_calls',
  schedule_ai_call: 'voice_calls',
  schedule_ai_call_cancel: 'voice_calls',
  manage_settings: 'settings',
  get_history: 'history',
  get_action_log: 'history',
  manage_secretaries: 'secretary',
  list_calendar_access: 'secretary',
  render_month_image: 'month_view',
  render_day_image: 'month_view',
  render_week_image: 'month_view',
  connect_telegram_status: 'telegram_connect',
  dismiss_connect_telegram_prompt: 'telegram_connect',
};

export type ExecutorDisposition = 'executed' | 'failed' | 'skipped' | 'waiting';
export type ExecutedToolResult = ToolResult & { disposition: ExecutorDisposition };

/**
 * Parse the raw model arguments against the tool's schema and run the day-reference guards.
 * Returns the (possibly coerced) input and, when the call must not run, the failure to report.
 */
function validateToolCall(
  ctx: AgentContext,
  toolName: string,
  rawInput: unknown,
): { input: unknown; error: ToolResult | undefined } {
  let input = rawInput;
  let error: ToolResult | undefined;
  const schema = toolSchemas[toolName as ToolName];
  if (schema) {
    const result = schema.safeParse(input);
    if (result.success) {
      input = result.data;
    } else {
      error = {
        success: false,
        mutationState: 'not_applied',
        error: `Invalid input: ${describeIssues(toolName, result.error.issues)}`,
      };
    }
  }
  // A date-bearing call for a day the user did not name is rejected before any write,
  // and a question pairing a weekday with a date on another weekday is never sent.
  error ??= checkDayReferences(ctx, toolName, input) ?? checkQuestionWeekdays(ctx, toolName, input);
  return { input, error };
}

/**
 * Time throttle: identical tool call within THROTTLE_TTL_MS returns a synthetic
 * THROTTLED result without invoking the handler. Prevents rapid cross-run
 * repeats (the in-run dedup in CalendarBotAgent handles within-run loops).
 * Only applied to tools with side-effects — purely read-only tools are exempt
 * so legitimate repeated queries within 5s don't get stale answers.
 * Returns the key used for the pre-check and the post-success write, or null when
 * the call is not subject to throttling.
 */
function throttleKeyFor(ctx: AgentContext, toolName: string, input: unknown): string | null {
  if (THROTTLE_EXEMPT.has(toolName)) return null;
  return buildThrottleKey(ctx.chatId, toolName, input);
}

function isThrottled(ctx: AgentContext, toolName: string, throttleKey: string): boolean {
  const now = Date.now();
  const lastCalledAt = throttleMap.get(throttleKey);
  if (lastCalledAt === undefined || now - lastCalledAt >= THROTTLE_TTL_MS) return false;
  aiLogger.warn(
    { tool: toolName, chatId: ctx.chatId, sinceMs: now - lastCalledAt },
    'Tool call throttled (identical within 5s)',
  );
  return true;
}

/** Record throttle entry only after a successful execution — failed calls must not poison the window. */
function recordThrottleEntry(throttleKey: string): void {
  const now = Date.now();
  evictStaleThrottleEntries(now);
  throttleMap.set(throttleKey, now);
}

/**
 * Track which event was touched, for last_mentioned_event resolution in intents,
 * and every event the model was shown, as evidence for the reply-time guard.
 */
function trackSurfacedEvents(ctx: AgentContext, input: ToolInputMap[ToolName], result: ToolResult): void {
  const eventId = extractEventId(input, result);
  if (eventId !== undefined) ctx.onEventMentioned?.(eventId);
  const surfaced = extractEventSummaries(result.data);
  if (surfaced) ctx.surfacedEvents = [...(ctx.surfacedEvents ?? []), ...surfaced];
}

/** Track feature usage for tip personalization. */
function recordFeatureUsage(ctx: AgentContext, toolName: string): void {
  const featureKey = TOOL_FEATURE_MAP[toolName];
  if (!ctx.featureUsageRepo || !featureKey) return;
  try {
    ctx.featureUsageRepo.record(ctx.user.telegram_id, featureKey);
  } catch (fuErr) {
    aiLogger.warn({ err: fuErr, tool: toolName }, 'Failed to record feature usage');
  }
}

/** Log mutating tool calls to user_action_log. */
function logToolAction(ctx: AgentContext, toolName: string, input: ToolInputMap[ToolName], result: ToolResult): void {
  if (!ctx.actionLogRepo || SKIP_ACTION_LOG.has(toolName)) return;
  try {
    ctx.actionLogRepo.insert({
      user_id: ctx.user.telegram_id,
      chat_id: ctx.chatId,
      action_type: 'ai_tool',
      action_name: toolName,
      message_id: ctx.incomingMessageId,
      chat_history_id: ctx.chatHistoryId,
      input_summary: summarizeInput(toolName, input),
      result_summary: result.output?.slice(0, 500) ?? result.error?.slice(0, 500),
      metadata: JSON.stringify({
        ...input,
        ...(ctx.inputMode && { _inputMode: ctx.inputMode }),
        ...(ctx.voiceFileId && { _voiceFileId: ctx.voiceFileId }),
      }),
      target_event_id: extractEventId(input, result),
      target_user_id: extractTargetUserId(input),
      success: result.success,
    });
  } catch (logErr) {
    aiLogger.warn({ err: logErr, tool: toolName }, 'Failed to log action');
  }
}

function resolveMutationState(
  toolName: string,
  input: unknown,
  result: ToolResult,
): NonNullable<ToolResult['mutationState']> {
  if (result.mutationState) return result.mutationState;
  if (result.awaitingInput || !isMutationTool(toolName, input)) return 'not_applied';
  return result.success ? 'confirmed' : 'uncertain';
}

function resolveDisposition(result: ToolResult): ExecutorDisposition {
  if (!result.success) return 'failed';
  return result.awaitingInput ? 'waiting' : 'executed';
}

export async function executeTool(ctx: AgentContext, toolName: string, input: unknown): Promise<ExecutedToolResult> {
  aiLogger.debug({ tool: toolName, input }, 'Executing tool');

  const validated = validateToolCall(ctx, toolName, input);
  input = validated.input;

  const throttleKey = validated.error ? null : throttleKeyFor(ctx, toolName, input);
  if (throttleKey && isThrottled(ctx, toolName, throttleKey)) {
    return { success: true, output: THROTTLE_MARKER, disposition: 'skipped' };
  }

  try {
    const result = validated.error ?? (await dispatchTool(ctx, toolName as ToolName, input as ToolInputMap[ToolName]));

    if (result.success) {
      if (throttleKey) recordThrottleEntry(throttleKey);
      trackSurfacedEvents(ctx, input as ToolInputMap[ToolName], result);
      recordFeatureUsage(ctx, toolName);
    }
    logToolAction(ctx, toolName, input as ToolInputMap[ToolName], result);

    return {
      ...result,
      mutationState: resolveMutationState(toolName, input, result),
      disposition: resolveDisposition(result),
    };
  } catch (outerError) {
    aiLogger.error({ tool: toolName, err: outerError }, 'Tool execution error');
    return {
      success: false,
      error: `Tool execution failed: ${String(outerError)}`,
      disposition: 'failed',
      mutationState: isMutationTool(toolName, input) ? 'uncertain' : 'not_applied',
    };
  }
}

function extractEventId(input: ToolInputMap[ToolName], result: ToolResult): number | undefined {
  if ('event_id' in input && typeof input.event_id === 'number') return input.event_id;
  // Handlers return structured EventSummary in result.data — use it instead of parsing text
  if (result.data && typeof result.data === 'object' && 'id' in result.data && typeof result.data.id === 'number') {
    return result.data.id;
  }
  return undefined;
}

function extractTargetUserId(input: ToolInputMap[ToolName]): number | undefined {
  if ('invitee_id' in input && typeof input.invitee_id === 'number') return input.invitee_id;
  if ('secretary_telegram_id' in input && typeof input.secretary_telegram_id === 'number')
    return input.secretary_telegram_id;
  if ('telegram_id' in input && typeof input.telegram_id === 'number') return input.telegram_id;
  if ('target_id' in input && typeof input.target_id === 'number') return input.target_id;
  return undefined;
}

function summarizeInput(toolName: string, input: ToolInputMap[ToolName]): string {
  if ('title' in input && typeof input.title === 'string') return input.title;
  if ('message' in input && typeof input.message === 'string') return input.message.slice(0, 200);
  if ('text' in input && typeof input.text === 'string') return input.text.slice(0, 200);
  if ('expression' in input && typeof input.expression === 'string') return input.expression;
  if ('event_id' in input && typeof input.event_id === 'number') return `event #${input.event_id}`;
  return toolName;
}

/** Zod prefixes invalid_type messages with this; the caller's own wrapper already says it. */
const ZOD_INVALID_INPUT_PREFIX = 'Invalid input: ';

/**
 * Render zod issues as `field: reason [schema: excerpt]` pairs.
 *
 * Naming the field matters: without it the model cannot tell which argument it got
 * wrong and retries the same call with the same broken arguments. The schema excerpt
 * (type, required/optional, description) matters just as much — a bare "name: Required"
 * tells the model WHAT is wrong but not what a valid value looks like, so it can guess
 * wrong again on the very next retry. The excerpt is shown once per root field: an
 * invalid array (e.g. three bad `reminder_minutes` entries) yields three issues but
 * would otherwise repeat the identical excerpt three times, bloating the tool result
 * the model has to re-read for no extra information.
 */
function describeIssues(toolName: string, issues: readonly z.core.$ZodIssue[]): string {
  const excerptShownFor = new Set<string>();
  return issues
    .map((issue) => {
      const reason = issue.message.startsWith(ZOD_INVALID_INPUT_PREFIX)
        ? issue.message.slice(ZOD_INVALID_INPUT_PREFIX.length)
        : issue.message;
      const field = issue.path.join('.');
      if (!field) return reason;
      const base = `${field}: ${reason}`;
      // field is non-empty here (the !field check above returned already), so
      // split('.')[0] is never empty at runtime; the `|| field` fallback exists
      // only to satisfy noUncheckedIndexedAccess's `string | undefined` type.
      const root = field.split('.')[0] || field;
      if (excerptShownFor.has(root)) return base;
      excerptShownFor.add(root);
      return withSchemaExcerpt(base, toolName, [root]);
    })
    .join(', ');
}
