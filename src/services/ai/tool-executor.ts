import type { AgentCommand } from '../../agent/protocol.ts';
import type { FeatureKey } from '../../database/repositories/feature-usage.repository.ts';
import { logger } from '../../utils/logger.ts';
import { handleGetActionLog } from './tool-handlers/action-log.ts';
import { handleAssistantTool } from './tool-handlers/assistant.ts';
import { handleCreateBirthdayEvent } from './tool-handlers/birthdays.ts';
import { handleCalculate } from './tool-handlers/calculate.ts';
import {
  handleAddContact,
  handleFindContact,
  handleGetContacts,
  handleUpdateContact,
} from './tool-handlers/contacts.ts';
import {
  handleAttachPendingLocationToEvent,
  handleCreateEvent,
  handleDeleteEvent,
  handleGetEvent,
  handleGetEvents,
  handleGetUpcoming,
  handleNotifyParticipants,
  handleSearchEvents,
  handleSnoozeEvent,
  handleUpdateEvent,
} from './tool-handlers/events.ts';
import { handleSendFeedback } from './tool-handlers/feedback.ts';
import { handleGetHistory } from './tool-handlers/history.ts';
import { handleRememberUserFact, handleSetReaction } from './tool-handlers/memory.ts';
import {
  handleAskUser,
  handleEndCall,
  handleEndConversation,
  handleFindUser,
  handleGetBotInfo,
  handleGetGoogleCalendarStatus,
  handleGetHolidays,
  handleListGoogleCalendars,
  handleLookupStress,
  handleMakeCall,
  handlePickUsers,
} from './tool-handlers/meta.ts';
import type { ProposeInput } from './tool-handlers/proposals.ts';
import { handleProposeCalendarChange } from './tool-handlers/proposals.ts';
import { handleGetReminders, handleSetReminder } from './tool-handlers/reminders.ts';
import {
  handleRenderDayImage,
  handleRenderMonthImage,
  handleRenderTable,
  handleRenderWeekImage,
} from './tool-handlers/render.ts';
import { handleCancelScene, handleResumeScene } from './tool-handlers/scenes.ts';
import {
  handleAddTrigger,
  handleListTriggers,
  handleRemoveTrigger,
  handleScheduleAiCall,
  handleScheduleAiCallCancel,
  handleScheduleAiCallsList,
  type ScheduleAiCallInput,
  type TriggerIdInput,
  type TriggerInput,
} from './tool-handlers/scheduled.ts';
import { handleListCalendarAccess, handleManageSecretaries } from './tool-handlers/secretary.ts';
import type { ManageSettingsInput } from './tool-handlers/settings.ts';
import {
  handleConnectTelegramStatus,
  handleDismissConnectTelegramPrompt,
  handleManageSettings,
} from './tool-handlers/settings.ts';
import {
  handleCancelInvitation,
  handleGetInvitationStatus,
  handleProposeEdit,
  handleResendInvitation,
  handleSendInvitation,
  handleSetEventVisibility,
  handleShareAgenda,
  handleShareEvent,
} from './tool-handlers/sharing.ts';
import { handleGetFreeSlots } from './tool-handlers/slots.ts';
import { handleConvertToTimezone, handleGetTimezoneInfoWithCityFallback } from './tool-handlers/timezone.ts';
import { toolSchemas } from './tool-schemas.ts';
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
  ask_user: { question: string; options: string[] };
  pick_users: { event_id: number; prompt: string };
  get_contacts: { force?: boolean };
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
  send_invitation: { event_id: number; invitee_id: number; invitee_username?: string };
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
  claude_chat: AgentCommand['payload'];
  claude_new_chat: AgentCommand['payload'];
  claude_list_chats: AgentCommand['payload'];
  claude_open_chat: AgentCommand['payload'];
  claude_list_projects: AgentCommand['payload'];
  claude_artifact: AgentCommand['payload'];
  bash_execute: AgentCommand['payload'];
  playwright_action: AgentCommand['payload'];
  applescript_run: AgentCommand['payload'];
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
  [...Object.keys(HANDLER_MAP), ...Object.keys(INLINE_TOOL_META)].filter((k) => getToolMeta(k)?.readonly),
);

const SKIP_ACTION_LOG = new Set(
  [...Object.keys(HANDLER_MAP), ...Object.keys(INLINE_TOOL_META)].filter((k) => getToolMeta(k)?.skipActionLog),
);

/** Derived: tools that always result in [SKIP] — no status message or tool label. */
export const SILENT_TOOLS = new Set(
  [...Object.keys(HANDLER_MAP), ...Object.keys(INLINE_TOOL_META)].filter((k) => getToolMeta(k)?.silent),
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
  add_contact: 'contacts',
  find_contact: 'contacts',
  update_contact: 'contacts',
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

export async function executeTool(ctx: AgentContext, toolName: string, input: unknown): Promise<ToolResult> {
  aiLogger.debug({ tool: toolName, input }, 'Executing tool');

  // Time throttle: identical tool call within THROTTLE_TTL_MS returns a synthetic
  // THROTTLED result without invoking the handler. Prevents rapid cross-run
  // repeats (the in-run dedup in CalendarBotAgent handles within-run loops).
  // Only applied to tools with side-effects — purely read-only tools are exempt
  // so legitimate repeated queries within 5s don't get stale answers.
  // Build the throttle key before dispatch — used both for the pre-check and
  // the post-success write.
  let throttleKey: string | null = null;
  if (!THROTTLE_EXEMPT.has(toolName)) {
    const now = Date.now();
    throttleKey = buildThrottleKey(ctx.chatId, toolName, input);
    const lastCalledAt = throttleMap.get(throttleKey);
    if (lastCalledAt !== undefined && now - lastCalledAt < THROTTLE_TTL_MS) {
      aiLogger.warn(
        { tool: toolName, chatId: ctx.chatId, sinceMs: now - lastCalledAt },
        'Tool call throttled (identical within 5s)',
      );
      return { success: true, output: THROTTLE_MARKER };
    }
  }

  try {
    const result = await dispatchTool(ctx, toolName as ToolName, input as ToolInputMap[ToolName]);

    // Record throttle entry only after a successful execution — failed calls
    // must not poison the throttle window so retries get a real attempt.
    if (result.success && throttleKey) {
      const now = Date.now();
      evictStaleThrottleEntries(now);
      throttleMap.set(throttleKey, now);
    }

    // Track which event was touched, for last_mentioned_event resolution in intents
    if (result.success) {
      const eventId = extractEventId(input as ToolInputMap[ToolName], result);
      if (eventId !== undefined) ctx.onEventMentioned?.(eventId);
    }

    // Track feature usage for tip personalization
    if (result.success && ctx.featureUsageRepo) {
      const featureKey = TOOL_FEATURE_MAP[toolName];
      if (featureKey) {
        try {
          ctx.featureUsageRepo.record(ctx.user.telegram_id, featureKey);
        } catch (fuErr) {
          aiLogger.warn({ err: fuErr, tool: toolName }, 'Failed to record feature usage');
        }
      }
    }

    // Log mutating tool calls to user_action_log
    if (ctx.actionLogRepo && !SKIP_ACTION_LOG.has(toolName)) {
      try {
        const inputObj = input as ToolInputMap[ToolName];
        const eventId = extractEventId(inputObj, result);
        const targetUserId = extractTargetUserId(inputObj);
        ctx.actionLogRepo.insert({
          user_id: ctx.user.telegram_id,
          chat_id: ctx.chatId,
          action_type: 'ai_tool',
          action_name: toolName,
          message_id: ctx.incomingMessageId,
          chat_history_id: ctx.chatHistoryId,
          input_summary: summarizeInput(toolName, inputObj),
          result_summary: result.output?.slice(0, 500) ?? result.error?.slice(0, 500),
          metadata: JSON.stringify({
            ...inputObj,
            ...(ctx.inputMode && { _inputMode: ctx.inputMode }),
            ...(ctx.voiceFileId && { _voiceFileId: ctx.voiceFileId }),
          }),
          target_event_id: eventId,
          target_user_id: targetUserId,
          success: result.success,
        });
      } catch (logErr) {
        aiLogger.warn({ err: logErr, tool: toolName }, 'Failed to log action');
      }
    }

    return result;
  } catch (outerError) {
    aiLogger.error({ tool: toolName, err: outerError }, 'Tool execution error');
    return { success: false, error: `Tool execution failed: ${String(outerError)}` };
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

async function dispatchTool(ctx: AgentContext, toolName: ToolName, input: ToolInputMap[ToolName]): Promise<ToolResult> {
  const schema = toolSchemas[toolName];
  if (schema) {
    const result = schema.safeParse(input);
    if (!result.success) {
      return {
        success: false,
        error: `Invalid input: ${result.error.issues.map((i) => i.message).join(', ')}`,
      };
    }
    input = result.data as ToolInputMap[ToolName];
  }

  try {
    switch (toolName) {
      case 'supplement_skip':
        return { success: true, stopLoop: true };

      case 'end_conversation':
        return handleEndConversation();

      case 'get_events':
        return handleGetEvents(ctx, input as ToolInputMap['get_events']);

      case 'create_event':
        return handleCreateEvent(ctx, input as ToolInputMap['create_event']);

      case 'update_event':
        return handleUpdateEvent(ctx, input as ToolInputMap['update_event']);

      case 'attach_pending_location_to_event':
        return handleAttachPendingLocationToEvent(ctx, input as ToolInputMap['attach_pending_location_to_event']);

      case 'delete_event':
        return handleDeleteEvent(ctx, input as ToolInputMap['delete_event']);

      case 'get_free_slots':
        return handleGetFreeSlots(ctx, input as ToolInputMap['get_free_slots']);

      case 'search_events':
        return handleSearchEvents(ctx, input as ToolInputMap['search_events']);

      case 'create_birthday_event':
        return handleCreateBirthdayEvent(ctx, input as ToolInputMap['create_birthday_event']);

      case 'get_upcoming':
        return handleGetUpcoming(ctx, input as ToolInputMap['get_upcoming']);

      case 'snooze_event':
        return handleSnoozeEvent(ctx, input as ToolInputMap['snooze_event']);

      case 'get_event':
        return handleGetEvent(ctx, input as ToolInputMap['get_event']);

      case 'notify_participants':
        return handleNotifyParticipants(ctx, input as ToolInputMap['notify_participants']);

      case 'get_reminders':
        return handleGetReminders(ctx, input as ToolInputMap['get_reminders']);

      case 'set_reminder':
        return handleSetReminder(ctx, input as ToolInputMap['set_reminder']);

      case 'find_user':
        return handleFindUser(ctx, input as ToolInputMap['find_user']);

      case 'ask_user':
        return handleAskUser(ctx, input as ToolInputMap['ask_user']);

      case 'pick_users':
        return handlePickUsers(ctx, input as ToolInputMap['pick_users']);

      case 'get_contacts':
        return handleGetContacts(ctx, input as ToolInputMap['get_contacts']);

      case 'add_contact':
        return handleAddContact(ctx, input as ToolInputMap['add_contact']);

      case 'find_contact':
        return handleFindContact(ctx, input as ToolInputMap['find_contact']);

      case 'update_contact':
        return handleUpdateContact(ctx, input as ToolInputMap['update_contact']);

      case 'render_day_image':
        return handleRenderDayImage(ctx, input as ToolInputMap['render_day_image']);

      case 'render_week_image':
        return handleRenderWeekImage(ctx, input as ToolInputMap['render_week_image']);

      case 'render_month_image':
        return handleRenderMonthImage(ctx, input as ToolInputMap['render_month_image']);

      case 'render_table':
        return handleRenderTable(ctx, input as ToolInputMap['render_table']);

      case 'end_call':
        return handleEndCall(ctx);

      case 'make_call':
        return handleMakeCall(ctx, input as ToolInputMap['make_call']);

      case 'get_holidays':
        return handleGetHolidays(ctx, input as ToolInputMap['get_holidays']);

      case 'manage_settings':
        return handleManageSettings(ctx, input as ToolInputMap['manage_settings']);

      case 'connect_telegram_status':
        return handleConnectTelegramStatus(ctx);

      case 'dismiss_connect_telegram_prompt':
        return handleDismissConnectTelegramPrompt(ctx);

      case 'share_event':
        return handleShareEvent(ctx, input as ToolInputMap['share_event']);

      case 'send_invitation':
        return handleSendInvitation(ctx, input as ToolInputMap['send_invitation']);

      case 'get_invitation_status':
        return handleGetInvitationStatus(ctx, input as ToolInputMap['get_invitation_status']);

      case 'share_agenda':
        return handleShareAgenda(ctx, input as ToolInputMap['share_agenda']);

      case 'set_event_visibility':
        return handleSetEventVisibility(ctx, input as ToolInputMap['set_event_visibility']);

      case 'propose_edit':
        return handleProposeEdit(ctx, input as ToolInputMap['propose_edit']);

      case 'cancel_invitation':
        return handleCancelInvitation(ctx, input as ToolInputMap['cancel_invitation']);

      case 'resend_invitation':
        return handleResendInvitation(ctx, input as ToolInputMap['resend_invitation']);

      case 'get_google_calendar_status':
        return handleGetGoogleCalendarStatus(ctx);

      case 'list_google_calendars':
        return handleListGoogleCalendars(ctx);

      case 'lookup_stress':
        return handleLookupStress(ctx, input as ToolInputMap['lookup_stress']);

      case 'send_feedback':
        return handleSendFeedback(ctx, input as ToolInputMap['send_feedback']);

      case 'get_bot_info':
        return handleGetBotInfo();

      case 'calculate':
        return handleCalculate(input as ToolInputMap['calculate']);

      case 'get_timezone_info':
        return handleGetTimezoneInfoWithCityFallback(input as ToolInputMap['get_timezone_info']);

      case 'convert_to_timezone':
        return handleConvertToTimezone(input as ToolInputMap['convert_to_timezone']);

      case 'list_calendar_access':
        return handleListCalendarAccess(ctx);

      case 'manage_secretaries':
        return handleManageSecretaries(ctx, input as ToolInputMap['manage_secretaries']);

      case 'propose_calendar_change':
        return handleProposeCalendarChange(ctx, input as ToolInputMap['propose_calendar_change']);

      case 'get_history':
        return handleGetHistory(ctx, input as ToolInputMap['get_history']);

      case 'get_action_log':
        return handleGetActionLog(ctx, input as ToolInputMap['get_action_log']);

      case 'schedule_ai_call':
        return handleScheduleAiCall(ctx, input as ToolInputMap['schedule_ai_call']);
      case 'schedule_ai_calls_list':
        return handleScheduleAiCallsList(ctx);
      case 'schedule_ai_call_cancel':
        return handleScheduleAiCallCancel(ctx, input as ToolInputMap['schedule_ai_call_cancel']);
      case 'add_trigger':
        return handleAddTrigger(ctx, input as ToolInputMap['add_trigger']);
      case 'list_triggers':
        return handleListTriggers(ctx);
      case 'remove_trigger':
        return handleRemoveTrigger(ctx, input as ToolInputMap['remove_trigger']);
      case 'set_reaction':
        return handleSetReaction(ctx, input as ToolInputMap['set_reaction']);
      case 'remember_user_fact':
        return handleRememberUserFact(ctx, input as ToolInputMap['remember_user_fact']);

      case 'claude_chat':
      case 'claude_new_chat':
      case 'claude_list_chats':
      case 'claude_open_chat':
      case 'claude_list_projects':
      case 'claude_artifact':
      case 'bash_execute':
      case 'playwright_action':
      case 'applescript_run':
        return handleAssistantTool(ctx, toolName as AgentCommand['type'], input as AgentCommand['payload']);

      case 'resume_scene':
        if (!ctx.scene?.scenePauseService) return { success: false, error: 'Scene pause not available' };
        return handleResumeScene(ctx, ctx.scene?.scenePauseService);

      case 'cancel_scene':
        if (!ctx.scene?.scenePauseService) return { success: false, error: 'Scene pause not available' };
        return handleCancelScene(ctx, ctx.scene?.scenePauseService);

      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (error) {
    aiLogger.error({ tool: toolName, err: error }, 'Tool execution error');
    return { success: false, error: `Tool execution failed: ${String(error)}` };
  }
}
