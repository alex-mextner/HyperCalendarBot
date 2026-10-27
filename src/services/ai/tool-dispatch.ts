// src/services/ai/tool-dispatch.ts
// Table-driven routing of a validated tool call to its handler. One entry per tool name,
// typed against ToolInputMap so a handler cannot be wired to the wrong input shape.

import { logger } from '../../utils/logger.ts';
import type { ToolInputMap, ToolName } from './tool-executor.ts';
import { handleGetActionLog } from './tool-handlers/action-log.ts';
import { handleCreateBirthdayEvent } from './tool-handlers/birthdays.ts';
import { handleCalculate } from './tool-handlers/calculate.ts';
import {
  handleAddContact,
  handleDeleteContact,
  handleFindContact,
  handleGetContacts,
  handleGetUserInfo,
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
} from './tool-handlers/scheduled.ts';
import { handleListCalendarAccess, handleManageSecretaries } from './tool-handlers/secretary.ts';
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
import { makeCallSchema } from './tool-schemas.ts';
import type { AgentContext, ToolResult } from './types.ts';

const aiLogger = logger.child({ module: 'ai' });

type ToolHandler<K extends ToolName> = (ctx: AgentContext, input: ToolInputMap[K]) => ToolResult | Promise<ToolResult>;

const SCENE_PAUSE_UNAVAILABLE: ToolResult = { success: false, error: 'Scene pause not available' };

function deleteContactFromInput(ctx: AgentContext, input: ToolInputMap['delete_contact']): ToolResult {
  if ('contact_id' in input && typeof input.contact_id === 'number') {
    return handleDeleteContact(ctx, { contact_id: input.contact_id });
  }
  return { success: false, error: 'A contact_id from your address book is required.' };
}

function resumeScene(ctx: AgentContext): ToolResult | Promise<ToolResult> {
  const scenePauseService = ctx.scene?.scenePauseService;
  if (!scenePauseService) return SCENE_PAUSE_UNAVAILABLE;
  return handleResumeScene(ctx, scenePauseService);
}

function cancelScene(ctx: AgentContext): ToolResult | Promise<ToolResult> {
  const scenePauseService = ctx.scene?.scenePauseService;
  if (!scenePauseService) return SCENE_PAUSE_UNAVAILABLE;
  return handleCancelScene(ctx, scenePauseService);
}

const DISPATCH_TABLE: { [K in ToolName]: ToolHandler<K> } = {
  supplement_skip: () => ({ success: true, stopLoop: true }),
  end_conversation: () => handleEndConversation(),
  get_events: handleGetEvents,
  create_event: handleCreateEvent,
  update_event: handleUpdateEvent,
  attach_pending_location_to_event: handleAttachPendingLocationToEvent,
  delete_event: handleDeleteEvent,
  get_free_slots: handleGetFreeSlots,
  search_events: handleSearchEvents,
  create_birthday_event: handleCreateBirthdayEvent,
  get_upcoming: handleGetUpcoming,
  snooze_event: handleSnoozeEvent,
  get_event: handleGetEvent,
  notify_participants: handleNotifyParticipants,
  get_reminders: handleGetReminders,
  set_reminder: handleSetReminder,
  find_user: handleFindUser,
  ask_user: handleAskUser,
  pick_users: handlePickUsers,
  get_user_info: handleGetUserInfo,
  get_contacts: handleGetContacts,
  add_contact: handleAddContact,
  find_contact: handleFindContact,
  update_contact: handleUpdateContact,
  delete_contact: deleteContactFromInput,
  render_day_image: handleRenderDayImage,
  render_week_image: handleRenderWeekImage,
  render_month_image: handleRenderMonthImage,
  render_table: handleRenderTable,
  end_call: handleEndCall,
  make_call: (ctx, input) => handleMakeCall(ctx, makeCallSchema.parse(input)),
  get_holidays: handleGetHolidays,
  manage_settings: handleManageSettings,
  connect_telegram_status: handleConnectTelegramStatus,
  dismiss_connect_telegram_prompt: handleDismissConnectTelegramPrompt,
  share_event: handleShareEvent,
  send_invitation: handleSendInvitation,
  get_invitation_status: handleGetInvitationStatus,
  share_agenda: handleShareAgenda,
  set_event_visibility: handleSetEventVisibility,
  propose_edit: handleProposeEdit,
  cancel_invitation: handleCancelInvitation,
  resend_invitation: handleResendInvitation,
  get_google_calendar_status: handleGetGoogleCalendarStatus,
  list_google_calendars: handleListGoogleCalendars,
  lookup_stress: handleLookupStress,
  send_feedback: handleSendFeedback,
  get_bot_info: () => handleGetBotInfo(),
  calculate: (_ctx, input) => handleCalculate(input),
  get_timezone_info: (_ctx, input) => handleGetTimezoneInfoWithCityFallback(input),
  convert_to_timezone: (_ctx, input) => handleConvertToTimezone(input),
  list_calendar_access: handleListCalendarAccess,
  manage_secretaries: handleManageSecretaries,
  propose_calendar_change: handleProposeCalendarChange,
  get_history: handleGetHistory,
  get_action_log: handleGetActionLog,
  schedule_ai_call: handleScheduleAiCall,
  schedule_ai_calls_list: handleScheduleAiCallsList,
  schedule_ai_call_cancel: handleScheduleAiCallCancel,
  add_trigger: handleAddTrigger,
  list_triggers: handleListTriggers,
  remove_trigger: handleRemoveTrigger,
  set_reaction: handleSetReaction,
  remember_user_fact: handleRememberUserFact,
  resume_scene: resumeScene,
  cancel_scene: cancelScene,
};

/** Runs one handler; the generic key keeps the table entry and its input shape correlated. */
function runHandler<K extends ToolName>(
  ctx: AgentContext,
  toolName: K,
  input: ToolInputMap[K],
): ToolResult | Promise<ToolResult> | undefined {
  if (!Object.hasOwn(DISPATCH_TABLE, toolName)) return undefined;
  return DISPATCH_TABLE[toolName](ctx, input);
}

export async function dispatchTool(
  ctx: AgentContext,
  toolName: ToolName,
  input: ToolInputMap[ToolName],
): Promise<ToolResult> {
  try {
    // Not awaited on purpose: a handler's async rejection propagates to the caller's catch,
    // only synchronous throws are converted to a failed result here.
    return runHandler(ctx, toolName, input) ?? { success: false, error: `Unknown tool: ${toolName}` };
  } catch (error) {
    aiLogger.error({ tool: toolName, err: error }, 'Tool execution error');
    return { success: false, error: `Tool execution failed: ${String(error)}` };
  }
}
