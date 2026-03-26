import type { AgentCommand } from '../../agent/protocol.ts';
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
import { handleRenderDayImage, handleRenderTable, handleRenderWeekImage } from './tool-handlers/render.ts';
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
import { handleManageSettings } from './tool-handlers/settings.ts';
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
import { handleConvertToTimezone, handleGetTimezoneInfo } from './tool-handlers/timezone.ts';
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
  get_reminders: { event_id: number; scope?: 'personal' | 'group' };
  set_reminder: { event_id: number; minutes_before: number[]; scope?: 'personal' | 'group' };
  find_user: { username: string };
  ask_user: { question: string; options: string[] };
  pick_users: { event_id: number; prompt: string };
  get_contacts: { force?: boolean };
  add_contact: { name: string; username?: string };
  find_contact: { name: string };
  update_contact: { search: string; name?: string; preferred_name?: string; username?: string };
  render_day_image: { date: string; scope?: 'personal' | 'group'; owner_id?: number };
  render_week_image: { week_start: string; owner_id?: number };
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
  resume_scene: Record<never, never>;
  cancel_scene: Record<never, never>;
}

export type ToolName = keyof ToolInputMap;

const aiLogger = logger.child({ module: 'ai' });

/** Tools that are read-only or meta — not worth logging as user actions. */
const SKIP_ACTION_LOG = new Set<string>([
  'supplement_skip',
  'end_conversation',
  'get_events',
  'get_event',
  'get_upcoming',
  'get_free_slots',
  'search_events',
  'get_reminders',
  'get_contacts',
  'find_contact',
  'find_user',
  'get_history',
  'get_holidays',
  'get_invitation_status',
  'get_google_calendar_status',
  'list_google_calendars',
  'list_calendar_access',
  'get_timezone_info',
  'convert_to_timezone',
  'get_bot_info',
  'calculate',
  'lookup_stress',
  'schedule_ai_calls_list',
  'list_triggers',
  'set_reaction',
  'ask_user',
  'pick_users',
  'render_day_image',
  'render_week_image',
  'render_table',
  'resume_scene',
  'cancel_scene',
  'get_action_log',
]);

export async function executeTool(ctx: AgentContext, toolName: string, input: unknown): Promise<ToolResult> {
  aiLogger.debug({ tool: toolName, input }, 'Executing tool');

  try {
    const result = await dispatchTool(ctx, toolName as ToolName, input as ToolInputMap[ToolName]);

    // Track which event was touched, for last_mentioned_event resolution in intents
    if (result.success) {
      const eventId = extractEventId(input as ToolInputMap[ToolName], result);
      if (eventId !== undefined) ctx.onEventMentioned?.(eventId);
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
        output: `Invalid input: ${result.error.issues.map((i) => i.message).join(', ')}`,
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
        return handleGetTimezoneInfo(input as ToolInputMap['get_timezone_info']);

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
