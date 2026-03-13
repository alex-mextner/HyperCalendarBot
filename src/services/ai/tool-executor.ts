import { logger } from '../../utils/logger.ts';
import {
  handleCreateEvent,
  handleDeleteEvent,
  handleGetEvents,
  handleSearchEvents,
  handleUpdateEvent,
} from './tool-handlers/events.ts';
import { handleGetHolidays, handleGetUserSettings, handleUpdateUserSettings } from './tool-handlers/meta.ts';
import { handleSetReminder } from './tool-handlers/reminders.ts';
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

      case 'set_reminder':
        return handleSetReminder(ctx, input as { event_id: number; minutes_before: number[] });

      case 'get_holidays':
        return handleGetHolidays(ctx, input as { limit?: number });

      case 'get_user_settings':
        return handleGetUserSettings(ctx);

      case 'update_user_settings':
        return handleUpdateUserSettings(ctx, input as { timezone?: string; language?: 'en' | 'ru' });

      default:
        return { success: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (error) {
    aiLogger.error({ tool: toolName, error: String(error) }, 'Tool execution error');
    return { success: false, error: `Tool execution failed: ${String(error)}` };
  }
}
