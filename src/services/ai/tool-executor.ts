import { logger } from '../../utils/logger.ts';
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
import {
  handleAddContact,
  handleAskUser,
  handleCalculate,
  handleFindContact,
  handleFindUser,
  handleGetBotInfo,
  handleGetContacts,
  handleGetGoogleCalendarStatus,
  handleGetHolidays,
  handleListGoogleCalendars,
  handleLookupStress,
  handleMakeCall,
  handlePickUsers,
  handleRenderDayImage,
  handleRenderWeekImage,
  handleUpdateContact,
} from './tool-handlers/meta.ts';
import type { ProposeInput } from './tool-handlers/proposals.ts';
import { handleProposeCalendarChange } from './tool-handlers/proposals.ts';
import { handleGetReminders, handleSetReminder } from './tool-handlers/reminders.ts';
import { handleListCalendarAccess, handleManageSecretaries } from './tool-handlers/secretary.ts';
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
import type { AgentContext, ToolResult } from './types.ts';

const aiLogger = logger.child({ module: 'ai' });

export async function executeTool(
  ctx: AgentContext,
  toolName: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  aiLogger.debug({ tool: toolName, input }, 'Executing tool');

  try {
    const result = await dispatchTool(ctx, toolName, input);

    // Track which event was touched, for last_mentioned_event resolution in intents
    if (result.success) {
      if (typeof input.event_id === 'number') {
        ctx.onEventMentioned?.(input.event_id);
      } else if (toolName === 'create_event' && result.output) {
        const m = /^id:\s*(\d+)/m.exec(result.output);
        if (m) ctx.onEventMentioned?.(Number.parseInt(m[1], 10));
      }
    }

    return result;
  } catch (outerError) {
    aiLogger.error({ tool: toolName, error: String(outerError) }, 'Tool execution error');
    return { success: false, error: `Tool execution failed: ${String(outerError)}` };
  }
}

async function dispatchTool(ctx: AgentContext, toolName: string, input: Record<string, unknown>): Promise<ToolResult> {
  try {
    switch (toolName) {
      case 'get_events':
        return handleGetEvents(ctx, input as { start_date: string; end_date: string; scope?: 'personal' | 'group' });

      case 'create_event':
        return handleCreateEvent(
          ctx,
          input as {
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
          },
        );

      case 'update_event':
        return handleUpdateEvent(
          ctx,
          input as {
            event_id: number;
            title?: string;
            start_at?: string;
            end_at?: string | null;
            description?: string | null;
            location?: string | null;
            recurrence_rule?: string | null;
            scope?: 'personal' | 'group';
          },
        );

      case 'delete_event':
        return handleDeleteEvent(ctx, input as { event_id: number; scope?: 'personal' | 'group' });

      case 'get_free_slots':
        return handleGetFreeSlots(ctx, input as { date: string; scope?: 'personal' | 'group' });

      case 'search_events':
        return handleSearchEvents(ctx, input as { query: string; scope?: 'personal' | 'group' });

      case 'get_upcoming':
        return handleGetUpcoming(ctx, input as { limit?: number; scope?: 'personal' | 'group' });

      case 'snooze_event':
        return handleSnoozeEvent(ctx, input as { event_id: number; minutes?: number; scope?: 'personal' | 'group' });

      case 'get_event':
        return handleGetEvent(ctx, input as { event_id: number; scope?: 'personal' | 'group' });

      case 'notify_participants':
        return handleNotifyParticipants(ctx, input as { event_id: number; message: string });

      case 'get_reminders':
        return handleGetReminders(ctx, input as { event_id: number; scope?: 'personal' | 'group' });

      case 'set_reminder':
        return handleSetReminder(
          ctx,
          input as { event_id: number; minutes_before: number[]; scope?: 'personal' | 'group' },
        );

      case 'find_user':
        return handleFindUser(ctx, input as { username: string });

      case 'ask_user':
        return handleAskUser(ctx, input as { question: string; options: string[] });

      case 'pick_users':
        return handlePickUsers(ctx, input as { event_id: number; prompt: string });

      case 'get_contacts':
        return handleGetContacts(ctx, input as { force?: boolean });

      case 'add_contact':
        return handleAddContact(ctx, input as { name: string; username?: string });

      case 'find_contact':
        return handleFindContact(ctx, input as { name: string });

      case 'update_contact':
        return handleUpdateContact(
          ctx,
          input as { search: string; name?: string; preferred_name?: string; username?: string },
        );

      case 'render_day_image':
        return handleRenderDayImage(ctx, input as { date: string; scope?: 'personal' | 'group'; owner_id?: number });

      case 'render_week_image':
        return handleRenderWeekImage(ctx, input as { week_start: string; owner_id?: number });

      case 'make_call':
        return handleMakeCall(ctx, input as { text: string });

      case 'get_holidays':
        return handleGetHolidays(ctx, input as { limit?: number });

      case 'manage_settings':
        return handleManageSettings(
          ctx,
          input as { action: 'get' | 'update'; category?: string; updates?: Record<string, unknown> },
        );

      case 'share_event':
        return handleShareEvent(ctx, input as { event_id: number; target_type: 'user' | 'group'; target_id: number });

      case 'send_invitation':
        return handleSendInvitation(ctx, input as { event_id: number; invitee_id: number; invitee_username?: string });

      case 'get_invitation_status':
        return handleGetInvitationStatus(ctx, input as { event_id: number });

      case 'share_agenda':
        return handleShareAgenda(
          ctx,
          input as {
            period: 'today' | 'tomorrow' | 'week';
            target_type: 'user' | 'group';
            target_id: number;
          },
        );

      case 'set_event_visibility':
        return handleSetEventVisibility(
          ctx,
          input as { event_id: number; visibility: 'private' | 'free_busy' | 'full'; owner_id?: number },
        );

      case 'propose_edit':
        return handleProposeEdit(
          ctx,
          input as { event_id: number; changes: Record<string, string | null>; reason?: string },
        );

      case 'cancel_invitation':
        return handleCancelInvitation(ctx, input as { invitation_id: number });

      case 'resend_invitation':
        return handleResendInvitation(ctx, input as { invitation_id: number; invitee_username?: string });

      case 'get_google_calendar_status':
        return handleGetGoogleCalendarStatus(ctx);

      case 'list_google_calendars':
        return handleListGoogleCalendars(ctx);

      case 'lookup_stress':
        return handleLookupStress(ctx, input as { words: string[] });

      case 'send_feedback':
        return handleSendFeedback(ctx, input as { type: 'bug' | 'feature' | 'question' | 'other'; message: string });

      case 'get_bot_info':
        return handleGetBotInfo();

      case 'calculate':
        return handleCalculate(input as { expression: string });

      case 'list_calendar_access':
        return handleListCalendarAccess(ctx);

      case 'manage_secretaries':
        return handleManageSecretaries(
          ctx,
          input as {
            action: 'invite' | 'revoke' | 'self_remove';
            secretary_telegram_id?: number;
            permission?: 'read' | 'write';
            secretary_access_id?: number;
          },
        );

      case 'propose_calendar_change':
        return handleProposeCalendarChange(ctx, input as ProposeInput);

      case 'get_history':
        return handleGetHistory(ctx, input as { limit?: number; search?: string; before?: string; after?: string });

      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (error) {
    aiLogger.error({ tool: toolName, err: error }, 'Tool execution error');
    return { success: false, error: `Tool execution failed: ${String(error)}` };
  }
}
