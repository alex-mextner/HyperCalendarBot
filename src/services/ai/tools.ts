import type Anthropic from '@anthropic-ai/sdk';

type ToolDefinition = Anthropic.Tool;

export const toolDefinitions: ToolDefinition[] = [
  {
    name: 'get_events',
    description: 'Get events for a date range. Returns a list of events with their details.',
    input_schema: {
      type: 'object' as const,
      properties: {
        start_date: {
          type: 'string',
          description: 'Start date in ISO 8601 UTC (e.g., "2026-03-15T00:00:00Z")',
        },
        end_date: {
          type: 'string',
          description: 'End date in ISO 8601 UTC (e.g., "2026-03-15T23:59:59Z")',
        },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'create_event',
    description: 'Create a new calendar event. Returns the created event.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Event title' },
        start_at: {
          type: 'string',
          description: 'Start time in ISO 8601 UTC (e.g., "2026-03-15T14:00:00Z")',
        },
        end_at: {
          type: 'string',
          description: 'End time in ISO 8601 UTC. Optional.',
        },
        description: { type: 'string', description: 'Event description. Optional.' },
        location: { type: 'string', description: 'Event location. Optional.' },
        all_day: {
          type: 'boolean',
          description: 'Whether this is an all-day event. Optional.',
        },
        recurrence_rule: {
          type: 'string',
          description: 'RRULE string for recurring events (e.g., "FREQ=WEEKLY;INTERVAL=2"). Optional.',
        },
        reminder_minutes: {
          type: 'array',
          items: { type: 'number' },
          description: 'Minutes before event to send reminders (e.g., [15, 60]). Optional.',
        },
      },
      required: ['title', 'start_at'],
    },
  },
  {
    name: 'update_event',
    description: 'Update an existing calendar event. Only pass fields that need to change.',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: { type: 'number', description: 'ID of the event to update' },
        title: { type: 'string', description: 'New title. Optional.' },
        start_at: {
          type: 'string',
          description: 'New start time in ISO 8601 UTC. Optional.',
        },
        end_at: {
          type: 'string',
          description: 'New end time in ISO 8601 UTC. Pass null to remove. Optional.',
        },
        description: {
          type: 'string',
          description: 'New description. Pass null to remove. Optional.',
        },
        location: {
          type: 'string',
          description: 'New location. Pass null to remove. Optional.',
        },
        recurrence_rule: {
          type: 'string',
          description: 'New RRULE string. Pass null to remove recurrence. Optional.',
        },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'delete_event',
    description: 'Delete a calendar event by its ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: {
          type: 'number',
          description: 'ID of the event to delete',
        },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'get_free_slots',
    description: 'Get available free time slots for a specific date. Returns gaps between existing events.',
    input_schema: {
      type: 'object' as const,
      properties: {
        date: {
          type: 'string',
          description: 'Date in ISO 8601 UTC (e.g., "2026-03-15T00:00:00Z")',
        },
      },
      required: ['date'],
    },
  },
  {
    name: 'search_events',
    description: 'Search events by title. Returns matching events.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query to match against event titles',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'set_reminder',
    description: 'Set reminder(s) for an event. Replaces existing reminders.',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: {
          type: 'number',
          description: 'ID of the event',
        },
        minutes_before: {
          type: 'array',
          items: { type: 'number' },
          description: 'Array of minutes before event to send reminders (e.g., [15, 60])',
        },
      },
      required: ['event_id', 'minutes_before'],
    },
  },
  {
    name: 'get_holidays',
    description: "Get upcoming holidays for the user's subscribed countries.",
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of holidays to return. Default: 10.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_user_settings',
    description: "Get the user's current settings (timezone, language, country).",
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'update_user_settings',
    description: 'Update user settings. Only pass fields that need to change.',
    input_schema: {
      type: 'object' as const,
      properties: {
        timezone: {
          type: 'string',
          description: 'IANA timezone (e.g., "Europe/Kyiv"). Optional.',
        },
        language: {
          type: 'string',
          enum: ['en', 'ru'],
          description: 'Interface language. Optional.',
        },
      },
      required: [],
    },
  },
];
