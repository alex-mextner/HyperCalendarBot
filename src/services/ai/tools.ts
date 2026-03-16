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
  {
    name: 'get_notification_settings',
    description:
      "Get the user's notification preferences: morning agenda, evening review, quiet hours, default reminders.",
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'update_notification_settings',
    description: 'Update notification preferences. Only pass fields that need to change.',
    input_schema: {
      type: 'object' as const,
      properties: {
        morning_agenda_enabled: { type: 'boolean', description: 'Enable/disable morning agenda digest' },
        morning_agenda_time: {
          type: 'string',
          description: 'Time for morning agenda in HH:MM format (local time, e.g., "08:00")',
        },
        evening_review_enabled: { type: 'boolean', description: 'Enable/disable evening review' },
        evening_review_time: { type: 'string', description: 'Time for evening review in HH:MM format (e.g., "21:00")' },
        quiet_hours_enabled: { type: 'boolean', description: 'Enable/disable quiet hours (no notifications)' },
        quiet_hours_start: { type: 'string', description: 'Quiet hours start in HH:MM (e.g., "23:00")' },
        quiet_hours_end: { type: 'string', description: 'Quiet hours end in HH:MM (e.g., "07:00")' },
        default_reminder_minutes: {
          type: 'array',
          items: { type: 'number' },
          description: 'Default reminder intervals in minutes (e.g., [15, 60])',
        },
      },
      required: [],
    },
  },
  {
    name: 'make_call',
    description:
      'Make a voice call to the user with a spoken message (TTS). Use when the user asks you to call them or for voice reminders.',
    input_schema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Text to speak during the call (will be converted to speech)' },
      },
      required: ['text'],
    },
  },
  {
    name: 'get_upcoming',
    description:
      'Get the next upcoming events from now. Useful when user asks "what do I have next?" or "upcoming events".',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of events to return. Default: 5.',
        },
      },
      required: [],
    },
  },
  {
    name: 'snooze_event',
    description: 'Snooze/postpone an event by a specified number of minutes. Shifts start and end times.',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: { type: 'number', description: 'ID of the event to snooze' },
        minutes: { type: 'number', description: 'Minutes to postpone by. Default: 10.' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'get_event',
    description: 'Get details of a single event by its ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: { type: 'number', description: 'ID of the event' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'get_reminders',
    description: 'Get the current reminder settings for an event.',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: { type: 'number', description: 'ID of the event' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'share_event',
    description: 'Share an event with a user or group. Records the sharing action.',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: { type: 'number', description: 'ID of the event to share' },
        target_type: {
          type: 'string',
          enum: ['user', 'group'],
          description: 'Whether sharing with a user or group',
        },
        target_id: { type: 'number', description: 'Telegram ID of the user or group to share with' },
      },
      required: ['event_id', 'target_type', 'target_id'],
    },
  },
  {
    name: 'send_invitation',
    description: 'Send an invitation for an event to another user.',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: { type: 'number', description: 'ID of the event to invite to' },
        invitee_id: { type: 'number', description: 'Telegram ID of the user to invite' },
      },
      required: ['event_id', 'invitee_id'],
    },
  },
  {
    name: 'get_invitation_status',
    description: 'Get invitation statuses for an event. Returns all invitations and their current status.',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: { type: 'number', description: 'ID of the event to check invitations for' },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'update_sharing_settings',
    description:
      "Update the CURRENT USER's privacy settings. These control how OTHER people see and interact with this user. This does NOT affect the user's ability to send invitations — sending is always allowed.",
    input_schema: {
      type: 'object' as const,
      properties: {
        default_visibility: {
          type: 'string',
          enum: ['private', 'free_busy', 'full'],
          description: "Default visibility of this user's events when shared. Optional.",
        },
        inline_mode_enabled: {
          type: 'boolean',
          description: 'Whether this user can be found via inline mode. Optional.',
        },
        allow_invitations: {
          type: 'boolean',
          description: 'Whether OTHER users can send invitations TO this user. Does NOT control sending. Optional.',
        },
      },
      required: [],
    },
  },
  {
    name: 'share_agenda',
    description: 'Share agenda for a time period with a user or group.',
    input_schema: {
      type: 'object' as const,
      properties: {
        period: {
          type: 'string',
          enum: ['today', 'tomorrow', 'week'],
          description: 'Time period to share agenda for',
        },
        target_type: {
          type: 'string',
          enum: ['user', 'group'],
          description: 'Whether sharing with a user or group',
        },
        target_id: { type: 'number', description: 'Telegram ID of the user or group' },
      },
      required: ['period', 'target_type', 'target_id'],
    },
  },
  {
    name: 'find_user',
    description:
      'Find a bot user by their Telegram @username. Returns their telegram_id which can be used with send_invitation. Only finds users who have interacted with the bot.',
    input_schema: {
      type: 'object' as const,
      properties: {
        username: {
          type: 'string',
          description: 'Telegram username (with or without @ prefix)',
        },
      },
      required: ['username'],
    },
  },
  {
    name: 'get_contacts',
    description: "List all contacts from the user's address book.",
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'add_contact',
    description: "Save a person to the user's address book. Use after learning someone's username.",
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Display name (e.g., "Лена")' },
        username: { type: 'string', description: 'Telegram @username (without @). Optional.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'find_contact',
    description: "Look up a person by name in the user's address book. Returns username and telegram_id if known.",
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Name to search for' },
      },
      required: ['name'],
    },
  },
  {
    name: 'ask_user',
    description:
      'Send a question to the user with clickable button options. Use when you need a yes/no or choice answer. After calling, STOP and wait for the user to respond.',
    input_schema: {
      type: 'object' as const,
      properties: {
        question: { type: 'string', description: 'The question text' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Short button labels (e.g., ["Да", "Нет"])',
        },
      },
      required: ['question', 'options'],
    },
  },
  {
    name: 'pick_users',
    description:
      'Open a Telegram user picker modal so the user can select people to invite to an event. Use after creating an event when some participants could not be found in the address book. In the prompt, explain WHO specifically needs to be found and why (e.g., "Вова не найден в контактах. Выберите его из списка контактов Telegram"). After calling, STOP and wait.',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: { type: 'number', description: 'Event ID to invite users to' },
        prompt: {
          type: 'string',
          description:
            'Explain who needs to be found and why. Mention names not found in address book. E.g., "Вова не найден в контактах. Выберите его в Telegram, чтобы отправить приглашение."',
        },
      },
      required: ['event_id', 'prompt'],
    },
  },
  {
    name: 'render_day_image',
    description:
      'Generate and send a beautiful calendar image for a specific date. Use when showing events for a day (today, tomorrow, specific date) — always send an image alongside text. Users love visual schedules.',
    input_schema: {
      type: 'object' as const,
      properties: {
        date: {
          type: 'string',
          description: 'Date in YYYY-MM-DD format (e.g., "2026-03-17")',
        },
      },
      required: ['date'],
    },
  },
  {
    name: 'render_week_image',
    description:
      'Generate and send a beautiful weekly calendar image starting from a specific date. Use when showing events for a week. Users love visual schedules.',
    input_schema: {
      type: 'object' as const,
      properties: {
        week_start: {
          type: 'string',
          description: 'Monday date in YYYY-MM-DD format (e.g., "2026-03-16")',
        },
      },
      required: ['week_start'],
    },
  },
  {
    name: 'set_event_visibility',
    description: 'Set visibility for a specific event (overrides default settings).',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: { type: 'number', description: 'ID of the event' },
        visibility: {
          type: 'string',
          enum: ['private', 'free_busy', 'full'],
          description: 'Visibility level for the event',
        },
      },
      required: ['event_id', 'visibility'],
    },
  },
];
