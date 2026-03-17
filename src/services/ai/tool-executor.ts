import { logger } from '../../utils/logger.ts';
import {
  handleCreateEvent,
  handleDeleteEvent,
  handleGetEvent,
  handleGetEvents,
  handleGetUpcoming,
  handleSearchEvents,
  handleSnoozeEvent,
  handleUpdateEvent,
} from './tool-handlers/events.ts';
import {
  handleAddContact,
  handleAskUser,
  handleFindContact,
  handleFindUser,
  handleGetCallSettings,
  handleGetContacts,
  handleGetGoogleCalendarStatus,
  handleGetHolidays,
  handleGetNotificationSettings,
  handleGetUserSettings,
  handleListGoogleCalendars,
  handleLookupStress,
  handleMakeCall,
  handlePickUsers,
  handleRenderDayImage,
  handleRenderWeekImage,
  handleUpdateCallSettings,
  handleUpdateNotificationSettings,
  handleUpdateUserSettings,
} from './tool-handlers/meta.ts';
import { handleGetReminders, handleSetReminder } from './tool-handlers/reminders.ts';
import {
  handleCancelInvitation,
  handleGetInvitationStatus,
  handleResendInvitation,
  handleSendInvitation,
  handleSetEventVisibility,
  handleShareAgenda,
  handleShareEvent,
  handleUpdateSharingSettings,
} from './tool-handlers/sharing.ts';
import { handleGetFreeSlots } from './tool-handlers/slots.ts';
import type { AgentContext, ToolResult } from './types.ts';

const aiLogger = logger.child({ module: 'ai' });

export function executeTool(ctx: AgentContext, toolName: string, input: Record<string, unknown>): ToolResult {
  aiLogger.debug({ tool: toolName, input }, 'Executing tool');

  try {
    switch (toolName) {
      case 'get_events':
        return handleGetEvents(ctx, input as { start_date: string; end_date: string });

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
          },
        );

      case 'delete_event':
        return handleDeleteEvent(ctx, input as { event_id: number });

      case 'get_free_slots':
        return handleGetFreeSlots(ctx, input as { date: string });

      case 'search_events':
        return handleSearchEvents(ctx, input as { query: string });

      case 'get_upcoming':
        return handleGetUpcoming(ctx, input as { limit?: number });

      case 'snooze_event':
        return handleSnoozeEvent(ctx, input as { event_id: number; minutes?: number });

      case 'get_event':
        return handleGetEvent(ctx, input as { event_id: number });

      case 'get_reminders':
        return handleGetReminders(ctx, input as { event_id: number });

      case 'set_reminder':
        return handleSetReminder(ctx, input as { event_id: number; minutes_before: number[] });

      case 'find_user':
        return handleFindUser(ctx, input as { username: string });

      case 'ask_user':
        return handleAskUser(ctx, input as { question: string; options: string[] });

      case 'pick_users':
        return handlePickUsers(ctx, input as { event_id: number; prompt: string });

      case 'get_contacts':
        return handleGetContacts(ctx);

      case 'add_contact':
        return handleAddContact(ctx, input as { name: string; username?: string });

      case 'find_contact':
        return handleFindContact(ctx, input as { name: string });

      case 'render_day_image':
        return handleRenderDayImage(ctx, input as { date: string });

      case 'render_week_image':
        return handleRenderWeekImage(ctx, input as { week_start: string });

      case 'get_notification_settings':
        return handleGetNotificationSettings(ctx);

      case 'update_notification_settings':
        return handleUpdateNotificationSettings(ctx, input);

      case 'make_call':
        return handleMakeCall(ctx, input as { text: string });

      case 'get_call_settings':
        return handleGetCallSettings(ctx);

      case 'update_call_settings':
        return handleUpdateCallSettings(ctx, input as { enabled?: boolean; language?: string });

      case 'get_holidays':
        return handleGetHolidays(ctx, input as { limit?: number });

      case 'get_user_settings':
        return handleGetUserSettings(ctx);

      case 'update_user_settings':
        return handleUpdateUserSettings(ctx, input as { timezone?: string; language?: 'en' | 'ru' });

      case 'share_event':
        return handleShareEvent(ctx, input as { event_id: number; target_type: 'user' | 'group'; target_id: number });

      case 'send_invitation':
        return handleSendInvitation(ctx, input as { event_id: number; invitee_id: number });

      case 'get_invitation_status':
        return handleGetInvitationStatus(ctx, input as { event_id: number });

      case 'update_sharing_settings':
        return handleUpdateSharingSettings(
          ctx,
          input as {
            default_visibility?: 'private' | 'free_busy' | 'full';
            inline_mode_enabled?: boolean;
            allow_invitations?: boolean;
          },
        );

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
          input as { event_id: number; visibility: 'private' | 'free_busy' | 'full' },
        );

      case 'cancel_invitation':
        return handleCancelInvitation(ctx, input as { invitation_id: number });

      case 'resend_invitation':
        return handleResendInvitation(ctx, input as { invitation_id: number });

      case 'get_google_calendar_status':
        return handleGetGoogleCalendarStatus(ctx);

      case 'list_google_calendars':
        return handleListGoogleCalendars(ctx);

      case 'lookup_stress':
        return handleLookupStress(ctx, input as { words: string[] });

      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (error) {
    aiLogger.error({ tool: toolName, error: String(error) }, 'Tool execution error');
    return { success: false, error: `Tool execution failed: ${String(error)}` };
  }
}
