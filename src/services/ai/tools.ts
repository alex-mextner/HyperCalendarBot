import type OpenAI from 'openai';

/**
 * Internal tool definition format — the shape we author tools in.
 * Converted to OpenAI.ChatCompletionTool on the way out via toOpenAITool().
 * Keeping this intermediate form lets each tool stay a flat object (no
 * `{ type: 'function', function: {...} }` wrapping in every declaration).
 */
interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: { [key: string]: unknown };
    required?: string[];
  };
}

/** Wrap an internal ToolDefinition into the OpenAI SDK format. */
function toOpenAITool(t: ToolDefinition): OpenAI.ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  };
}

const toolDefinitions: ToolDefinition[] = [
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
        scope: {
          type: 'string',
          enum: ['personal', 'group'],
          description: 'Calendar scope. In groups defaults to "group", in DMs defaults to "personal".',
        },
        owner_id: {
          type: 'number',
          description:
            "Telegram ID of a user whose calendar to operate on. Only works if you have active secretary access to that user's calendar.",
        },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'create_event',
    description:
      'Create a new calendar event. Returns the created event. ' +
      'If the event time is in the past, the tool will reject with PAST_EVENT error — ' +
      'you must ask the user to confirm via ask_user, then retry with force: true.',
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
        location_abstract: {
          type: 'boolean',
          description:
            'Set to true when the location is abstract or relative — not a concrete venue or street address. Examples of abstract: "У Иры", "дома", "на работе", "у метро", "у нас", "на районе". Examples of concrete (leave false): "Кофемания", "ул. Ленина 10", "ТЦ Мега", "Парк Горького". When true, the location is stored as plain text without geocoding or Google Maps links. Defaults to false.',
        },
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
        force: {
          type: 'boolean',
          description: 'Set to true to create event in the past after user confirmed. Do NOT set without asking first.',
        },
        scope: {
          type: 'string',
          enum: ['personal', 'group'],
          description: 'Calendar scope. In groups defaults to "group", in DMs defaults to "personal".',
        },
        owner_id: {
          type: 'number',
          description:
            "Telegram ID of a user whose calendar to operate on. Only works if you have active secretary access to that user's calendar.",
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
        location: { type: 'string', description: 'New location. Pass null to remove. Optional.' },
        location_abstract: {
          type: 'boolean',
          description:
            'Set to true when the new location is abstract/relative (see create_event for examples). Skips geocoding. Defaults to false.',
        },
        recurrence_rule: {
          type: 'string',
          description: 'New RRULE string. Pass null to remove recurrence. Optional.',
        },
        scope: {
          type: 'string',
          enum: ['personal', 'group'],
          description: 'Calendar scope. In groups defaults to "group", in DMs defaults to "personal".',
        },
        owner_id: {
          type: 'number',
          description:
            "Telegram ID of a user whose calendar to operate on. Only works if you have active secretary access to that user's calendar.",
        },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'attach_pending_location_to_event',
    description:
      "Attach the user's most recently sent 📍 geolocation pin to a specific event. " +
      'Use this when the user has sent a Telegram location pin (visible in the system prompt under "Pending Location Pin") ' +
      'and confirms which event it belongs to. The pin is auto-resolved to a street address via Google Maps. ' +
      'Returns an error if no pending pin is found (pin expired after 30 min, or user never sent one).',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: {
          type: 'number',
          description: 'ID of the event to attach the pin to',
        },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'delete_event',
    description:
      'Delete a calendar event by its ID. If the user is a participant (not the creator), this declines the invitation instead of deleting — the event stays for the creator and other participants.',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: {
          type: 'number',
          description: 'ID of the event to delete',
        },
        scope: {
          type: 'string',
          enum: ['personal', 'group'],
          description: 'Calendar scope. In groups defaults to "group", in DMs defaults to "personal".',
        },
        owner_id: {
          type: 'number',
          description:
            "Telegram ID of a user whose calendar to operate on. Only works if you have active secretary access to that user's calendar.",
        },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'notify_participants',
    description:
      'Send a message to all accepted participants of an event you own. Use when you updated an event and the AI output mentioned participants. Only the event creator can use this.',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: { type: 'number', description: 'ID of the event whose participants to notify' },
        message: {
          type: 'string',
          description: 'Message describing the change (e.g., "Meeting moved to 11:00", "Location changed to Room 3")',
        },
      },
      required: ['event_id', 'message'],
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
        scope: {
          type: 'string',
          enum: ['personal', 'group'],
          description: 'Calendar scope. In groups defaults to "group", in DMs defaults to "personal".',
        },
        owner_id: {
          type: 'number',
          description:
            "Telegram ID of a user whose calendar to operate on. Only works if you have active secretary access to that user's calendar.",
        },
      },
      required: ['date'],
    },
  },
  {
    name: 'search_events',
    description: 'Search events by title. Returns matching events. Can also filter by event type (e.g. birthday).',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query to match against event titles. Optional when using event_type filter.',
        },
        scope: {
          type: 'string',
          enum: ['personal', 'group'],
          description: 'Calendar scope. In groups defaults to "group", in DMs defaults to "personal".',
        },
        owner_id: {
          type: 'number',
          description:
            "Telegram ID of a user whose calendar to operate on. Only works if you have active secretary access to that user's calendar.",
        },
        event_type: {
          type: 'string',
          enum: ['birthday', 'regular'],
          description: "Filter by event type. Use 'birthday' to list all birthday events.",
        },
      },
      required: [],
    },
  },
  {
    name: 'create_birthday_event',
    description: 'Create a birthday event for a Telegram user. Auto-fetches their name from the database.',
    input_schema: {
      type: 'object' as const,
      properties: {
        celebrant_id: { type: 'number', description: 'Telegram user ID of the birthday person' },
        date: {
          type: 'object' as const,
          properties: {
            day: { type: 'number', description: 'Day of month' },
            month: { type: 'number', description: 'Month number (1-12)' },
          },
          required: ['day', 'month'],
        },
        year: { type: 'number', description: 'Birth year (optional)' },
        custom_name: { type: 'string', description: 'Override auto-fetched name' },
        group_id: { type: 'number', description: 'Group calendar ID. Omit for personal calendar.' },
      },
      required: ['celebrant_id', 'date'],
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
        scope: {
          type: 'string',
          enum: ['personal', 'group'],
          description: 'Calendar scope. In groups defaults to "group", in DMs defaults to "personal".',
        },
        owner_id: {
          type: 'number',
          description:
            "Telegram ID of a user whose calendar to operate on. Only works if you have active secretary access to that user's calendar.",
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
    name: 'manage_settings',
    description:
      'Get or update user settings. ' +
      'IMPORTANT: When user asks to change language (e.g. "switch to English", "speak Russian"), ' +
      'you MUST call this tool with action=update, category=general, updates={language: "en"/"ru"} ' +
      'BEFORE responding in the new language. Do not just say you switched — persist it. ' +
      'Categories: general (timezone, language, country_code, default_event_duration_minutes), ' +
      'notifications (morning agenda, evening review, quiet hours, reminders), ' +
      'calls (enabled, language), privacy (default visibility, inline mode, invitations), ' +
      'voice (voice response enabled/disabled). Use action "get" without category to return all settings.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['get', 'update'], description: 'Action to perform' },
        category: {
          type: 'string',
          enum: ['general', 'notifications', 'calls', 'privacy', 'voice', 'assistant'],
          description: 'Settings category. Required for update, optional for get (omit to get all).',
        },
        updates: {
          type: 'object',
          description:
            'Fields to update. For general: timezone (IANA string), language (en/ru), country_code (ISO 3166-1 alpha-2 string), default_event_duration_minutes (1–1440 minutes). For notifications: morning_agenda_enabled (bool), morning_agenda_time (HH:MM), evening_review_enabled (bool), evening_review_time (HH:MM), quiet_hours_enabled (bool), quiet_hours_start (HH:MM), quiet_hours_end (HH:MM), default_reminder_minutes (number[]). For calls: enabled (bool), language (string). For privacy: default_visibility (private/free_busy/full), inline_mode_enabled (bool), allow_invitations (bool). For voice: voice_response_enabled (bool).',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'end_call',
    description:
      'End the current live phone call. Use ONLY during a live_call session when the user says goodbye (ciao, bye, пока, до свидания, etc.) or explicitly asks to hang up. Speak a short farewell first, then call this tool.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'make_call',
    description:
      'Make a voice call to the user with a spoken message (TTS). Use when the user asks you to call them. If this tool returns an error, tell the user voice calls are temporarily unavailable — do NOT suggest changing settings, the issue is server-side.',
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
        scope: {
          type: 'string',
          enum: ['personal', 'group'],
          description: 'Calendar scope. In groups defaults to "group", in DMs defaults to "personal".',
        },
        owner_id: {
          type: 'number',
          description:
            "Telegram ID of a user whose calendar to operate on. Only works if you have active secretary access to that user's calendar.",
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
        scope: {
          type: 'string',
          enum: ['personal', 'group'],
          description: 'Calendar scope. In groups defaults to "group", in DMs defaults to "personal".',
        },
        owner_id: {
          type: 'number',
          description:
            "Telegram ID of a user whose calendar to operate on. Only works if you have active secretary access to that user's calendar.",
        },
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
        scope: {
          type: 'string',
          enum: ['personal', 'group'],
          description: 'Calendar scope. In groups defaults to "group", in DMs defaults to "personal".',
        },
        owner_id: {
          type: 'number',
          description:
            "Telegram ID of a user whose calendar to operate on. Only works if you have active secretary access to that user's calendar.",
        },
      },
      required: ['event_id'],
    },
  },
  {
    name: 'get_reminders',
    description:
      'Get upcoming reminders for one or more events. Provide event_id for a single event, event_ids for multiple, or query to search by title.',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: { type: 'number', description: 'ID of a single event' },
        event_ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Array of event IDs to check reminders for',
        },
        query: {
          type: 'string',
          description: 'Search events by title and show their reminders',
        },
        scope: {
          type: 'string',
          enum: ['personal', 'group'],
          description: 'Calendar scope. In groups defaults to "group", in DMs defaults to "personal".',
        },
        owner_id: {
          type: 'number',
          description:
            "Telegram ID of a user whose calendar to operate on. Only works if you have active secretary access to that user's calendar.",
        },
      },
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
    description:
      'Create an invitation record and attempt delivery to another user. ' +
      'Provide invitee_id (from find_contact, find_user, or pick_users) or invitee_username — at least one is required. ' +
      'If only username is provided, the bot resolves the ID automatically. If resolve fails, a user picker opens. ' +
      'Success means the record was created and delivery is in progress; it does NOT mean the message was received.',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: { type: 'number', description: 'ID of the event to invite to' },
        invitee_id: {
          type: 'number',
          description:
            'Telegram ID of the user to invite. From find_contact, find_user, or pick_users. ' +
            'Optional if invitee_username is provided.',
        },
        invitee_username: {
          type: 'string',
          description:
            'Telegram @username of the invitee (without @). If invitee_id is not provided, the bot resolves it automatically.',
        },
      },
      required: ['event_id'],
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
    description:
      "List all contacts from the user's address book. PRIVATE DATA: in group chats, always use ask_user to clarify what the user wants before calling this (they may mean group members, not personal contacts). Only call with force: true after the user explicitly confirmed they want their private contacts shown in the group.",
    input_schema: {
      type: 'object' as const,
      properties: {
        force: {
          type: 'boolean',
          description:
            'Set to true only after the user explicitly confirmed they want their private contact list shown in a group chat.',
        },
      },
      required: [],
    },
  },
  {
    name: 'add_contact',
    description:
      "Save a person to the user's address book. Use after learning someone's name or username. ALWAYS use the name form the user used as preferred_name.",
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Full display name (e.g., "Elena Larichkina")' },
        username: { type: 'string', description: 'Telegram @username (without @). Optional.' },
        preferred_name: {
          type: 'string',
          description:
            'How the user refers to this person (e.g., "Лена", "Вова", "Alex"). Always save the exact form used by the user.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'find_contact',
    description:
      "Look up a person by name or @username in the user's address book. Returns up to 5 candidates ranked by match confidence (exact > prefix > substring). If the top result is not clearly the right person, call ask_user to disambiguate — never guess.",
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Name to search for' },
      },
      required: ['name'],
    },
  },
  {
    name: 'update_contact',
    description:
      "Update an existing contact's name, preferred_name, or username. Use when user wants to rename or correct a contact.",
    input_schema: {
      type: 'object' as const,
      properties: {
        search: { type: 'string', description: 'Current name or @username to find the contact' },
        name: { type: 'string', description: 'New display name (optional)' },
        preferred_name: {
          type: 'string',
          description: 'New preferred name — how the user refers to this person (optional)',
        },
        username: { type: 'string', description: 'New Telegram @username without @ (optional)' },
      },
      required: ['search'],
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
      'Generate and send a visual calendar image for a specific date. Use when the user explicitly asks to see their schedule as an image, OR when showing a full-day overview with multiple events and a visual layout would be genuinely helpful. Do NOT use for single event operations, confirmations, or quick replies.',
    input_schema: {
      type: 'object' as const,
      properties: {
        date: {
          type: 'string',
          description: 'Date in YYYY-MM-DD format (e.g., "2026-03-17")',
        },
        scope: {
          type: 'string',
          enum: ['personal', 'group'],
          description: 'Calendar scope. In groups defaults to "group", in DMs defaults to "personal".',
        },
        owner_id: {
          type: 'number',
          description:
            "Telegram ID of a user whose calendar to operate on. Only works if you have active secretary access to that user's calendar.",
        },
      },
      required: ['date'],
    },
  },
  {
    name: 'render_week_image',
    description:
      'Generate and send a visual weekly calendar image. Use when the user explicitly asks to see their week as an image, or when showing a week overview with many events.',
    input_schema: {
      type: 'object' as const,
      properties: {
        week_start: {
          type: 'string',
          description: 'Monday date in YYYY-MM-DD format (e.g., "2026-03-16")',
        },
        scope: {
          type: 'string',
          enum: ['personal', 'group'],
          description: 'Calendar scope. In groups defaults to "group", in DMs defaults to "personal".',
        },
        owner_id: {
          type: 'number',
          description:
            "Telegram ID of a user whose calendar to operate on. Only works if you have active secretary access to that user's calendar.",
        },
      },
      required: ['week_start'],
    },
  },
  {
    name: 'render_month_image',
    description:
      'Generate and send a visual monthly calendar image. Use when the user asks to see a full month overview, e.g. "show April", "calendar for next month", "monthly view".',
    input_schema: {
      type: 'object' as const,
      properties: {
        month: {
          type: 'string',
          description: 'Month in YYYY-MM format (e.g., "2026-04")',
        },
        scope: {
          type: 'string',
          enum: ['personal', 'group'],
          description: 'Calendar scope. In groups defaults to "group", in DMs defaults to "personal".',
        },
        owner_id: {
          type: 'number',
          description:
            "Telegram ID of a user whose calendar to operate on. Only works if you have active secretary access to that user's calendar.",
        },
      },
      required: ['month'],
    },
  },
  {
    name: 'render_table',
    description: `Renders a Markdown table as a styled image and sends it to the chat.

ALWAYS call this tool when you have tabular data (comparisons, schedules, lists with multiple attributes) — never skip it.
Call it IN PARALLEL with your text response. In the text, present the same data as a bullet list — never write raw Markdown table syntax there.

During a voice call the table is still sent to chat; you MUST mention it verbally (e.g. "I've sent a table to the chat — take a look").`,
    input_schema: {
      type: 'object' as const,
      properties: {
        title: {
          type: 'string',
          description: 'Table heading shown above the image.',
        },
        markdown: {
          type: 'string',
          description: 'Markdown table syntax. Example: "| Plan | Price |\\n|---|---|\\n| Basic | $5 |"',
        },
        caption: {
          type: 'string',
          description: 'Optional explanatory note shown below the table.',
        },
      },
      required: ['title', 'markdown'],
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
        owner_id: {
          type: 'number',
          description:
            "Telegram ID of a user whose calendar to operate on. Only works if you have active secretary access to that user's calendar.",
        },
      },
      required: ['event_id', 'visibility'],
    },
  },
  {
    name: 'propose_edit',
    description:
      'Propose changes to a shared event you participate in (but do not own). The event creator will receive the proposal with Accept/Reject buttons. Use when the invitee wants to suggest time, title, or other changes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: { type: 'number', description: 'ID of the shared event to propose changes to' },
        changes: {
          type: 'object',
          description:
            'Key-value pairs of fields to change (e.g., {"start_at": "2026-03-20T11:00:00Z", "title": "Renamed"}). Pass null to remove a field.',
        },
        reason: {
          type: 'string',
          description: 'Short explanation of why the change is needed. Optional.',
        },
      },
      required: ['event_id', 'changes'],
    },
  },
  {
    name: 'cancel_invitation',
    description: 'Cancel a pending invitation. Use when the user wants to revoke/cancel an invitation they sent.',
    input_schema: {
      type: 'object' as const,
      properties: {
        invitation_id: { type: 'number', description: 'ID of the invitation to cancel' },
      },
      required: ['invitation_id'],
    },
  },
  {
    name: 'resend_invitation',
    description:
      'Re-send a pending invitation notification to the invitee. Use when the user wants to remind/nudge someone about an unanswered invitation.',
    input_schema: {
      type: 'object' as const,
      properties: {
        invitation_id: { type: 'number', description: 'ID of the invitation to resend' },
        invitee_username: {
          type: 'string',
          description: 'Telegram @username of the invitee (without @). Pass if known.',
        },
      },
      required: ['invitation_id'],
    },
  },
  {
    name: 'get_google_calendar_status',
    description:
      'Check if Google Calendar is connected for this user. Returns connection status and list of synced calendars. If not connected, suggest /connect_google command.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'list_google_calendars',
    description:
      'List all Google Calendars for this user with their sync status (enabled/disabled). Requires Google Calendar to be connected.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'send_feedback',
    description:
      'Send feedback to the bot developer. Creates a feedback thread for two-way communication. Use when user wants to report a bug, suggest a feature, or ask the developer a question.',
    input_schema: {
      type: 'object' as const,
      properties: {
        type: { type: 'string', enum: ['bug', 'feature', 'question', 'other'], description: 'Feedback type' },
        message: { type: 'string', description: 'Feedback message text' },
      },
      required: ['type', 'message'],
    },
  },
  {
    name: 'lookup_stress',
    description:
      'Look up correct stress marks for Russian words in the stress dictionary (555K+ forms). Returns words with + before the stressed vowel (e.g., "молоко" → "молок+о"). For words NOT FOUND, the tool returns similar dictionary entries as reference. You should also proactively include word variations in the same request: different cases (молоком, молока), infinitives (бежать for бегу), nominative forms (встреча for встречей), singular/plural. Pass ALL words and their variations in a single call for efficiency. The tool handles hundreds of words instantly.',
    input_schema: {
      type: 'object' as const,
      properties: {
        words: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Russian words to look up (lowercase, no punctuation). Include the original word AND likely variations: other cases, base forms, related forms. E.g., for "алексом" also try "алекс", "алексей", "алексея".',
        },
      },
      required: ['words'],
    },
  },
  {
    name: 'get_bot_info',
    description:
      'Get information about non-obvious bot capabilities that are not derivable from other tools. Call when user asks what the bot can do, asks for help, or wants to know about features.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'list_calendar_access',
    description:
      'List all calendars this user has access to. Returns their own calendar and any ' +
      'calendars they can manage as a secretary. Also returns secretaries the user has ' +
      'added to their own calendar. Call when the user asks about their secretaries or asks ' +
      'about calendars they manage as secretary for someone else, or when context is ambiguous.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'manage_secretaries',
    description:
      'Manage secretary access to your calendar. Actions: ' +
      '"invite" — send an invite to a user to become your secretary; ' +
      '"revoke" — remove a secretary (you are the owner); ' +
      '"self_remove" — remove yourself from being a secretary for someone else. ' +
      'For "invite", requires secretary_telegram_id and permission ("read" or "write"). ' +
      'For "revoke" and "self_remove", requires secretary_access_id (from list_calendar_access).',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['invite', 'revoke', 'self_remove'] },
        secretary_telegram_id: {
          type: 'number',
          description: 'Telegram ID of the user to invite as secretary. Required for invite.',
        },
        permission: { type: 'string', enum: ['read', 'write'], description: 'Access level. Required for invite.' },
        secretary_access_id: {
          type: 'number',
          description: 'ID of the secretary access record. Required for revoke and self_remove.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'propose_calendar_change',
    description:
      'Propose a calendar change to another member of this group chat. ' +
      'The target receives a DM with Accept/Decline buttons — you cannot modify their calendar directly. ' +
      'Supported actions: "create" (new event), "update" (change fields of existing event), "delete" (remove event). ' +
      'For "update" and "delete", event_id must be known from a calendar view shared earlier in the chat. ' +
      'Use find_user first to resolve @username/name to telegram_id. ' +
      'After calling, STOP — the group chat will be notified of the outcome automatically.',
    input_schema: {
      type: 'object' as const,
      properties: {
        target_telegram_id: {
          type: 'number',
          description: 'telegram_id of the group member to propose the change to.',
        },
        action: { type: 'string', enum: ['create', 'update', 'delete'] },
        event: { type: 'object', description: 'Full event data. Required for action "create".' },
        event_id: { type: 'number', description: 'ID of the existing event. Required for "update" and "delete".' },
        changes: { type: 'object', description: 'Fields to change. Required for action "update".' },
        summary: {
          type: 'string',
          description:
            'Human-readable description shown in the DM. Example: "добавить встречу «Ретро» — пятница 15:00–16:00".',
        },
      },
      required: ['target_telegram_id', 'action', 'summary'],
    },
  },
  {
    name: 'calculate',
    description:
      'Arithmetic calculator. ALWAYS use this tool for any math — never compute in your head. Supports: numbers (+,-,*,/), HH:MM ± N min/hours, ISO datetime ± N min/hours/days/weeks/months/years, YYYY-MM-DD ± N days/weeks/months/years, ISO datetime - ISO datetime (returns human-readable duration).',
    input_schema: {
      type: 'object' as const,
      properties: {
        expression: {
          type: 'string',
          description:
            'Expression to evaluate. Examples: "2 + 31", "22:34 + 31min", "2026-03-18T22:34:00Z + 31min", "2026-03-18T22:34:00Z + 2weeks", "2026-03-18T22:34:00Z + 1month", "2026-03-18T22:34:00Z + 1year", "2026-03-18 + 7days", "2026-03-18 + 2weeks", "2026-03-18 + 1month", "23:50 - 1hour", "2026-03-21T18:00:00Z - 2026-03-21T17:00:00Z"',
        },
      },
      required: ['expression'],
    },
  },
  {
    name: 'get_timezone_info',
    description:
      'Get accurate UTC offset, DST status, and local time for one or more IANA timezones. ' +
      'ALWAYS use this tool — never guess offsets from memory. Training data about timezones is stale: ' +
      'countries change DST rules, cancel DST, or shift permanently. ' +
      'Pass `at` when scheduling a future event — the offset may differ from today due to DST transitions. ' +
      'Example: scheduling a New York meeting in July while it is currently March — ' +
      'the offset changes from -05:00 (winter) to -04:00 (summer). Without `at` you get the wrong offset. ' +
      'Pass an ARRAY of timezones to compare them: the response includes each offset, which is ahead, ' +
      'and (for exactly 2) the difference in hours — all pre-computed, no extra calculate call needed.',
    input_schema: {
      type: 'object' as const,
      properties: {
        timezone: {
          oneOf: [
            { type: 'string', description: 'Single IANA timezone (e.g. "America/New_York")' },
            {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of IANA timezones to compare (e.g. ["Europe/Moscow", "America/New_York"])',
            },
          ],
          description: 'IANA timezone name(s). Use array to compare multiple zones in one call.',
        },
        at: {
          type: 'string',
          description:
            'ISO 8601 datetime to check offset at (default: now). ' +
            'IMPORTANT: always pass the event datetime here when scheduling — DST may differ from today.',
        },
      },
      required: ['timezone'],
    },
  },
  {
    name: 'convert_to_timezone',
    description:
      'Convert a UTC (or offset-aware) datetime to local time in any IANA timezone. ' +
      'DST is applied automatically based on the exact datetime. ' +
      'Use when the user gives a time in their timezone and you need the UTC equivalent, ' +
      'or when showing a foreign time in local terms.',
    input_schema: {
      type: 'object' as const,
      properties: {
        datetime: {
          type: 'string',
          description: 'ISO 8601 datetime — UTC (e.g. "2026-07-15T14:00:00Z") or with offset',
        },
        timezone: {
          type: 'string',
          description: 'IANA timezone name (e.g. "America/New_York")',
        },
      },
      required: ['datetime', 'timezone'],
    },
  },
  {
    name: 'get_history',
    description:
      'Search conversation history — past messages, button presses, commands, and bot replies. Use ONLY for chat message history, NOT for calendar events. For questions about past schedule or activities ("what did I do last week?"), use get_events instead. Use this tool when you need context from before the visible conversation window or to find something the user said earlier.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Max number of entries to return (default 50)',
        },
        search: {
          type: 'string',
          description: 'Filter entries containing this text',
        },
        before: {
          type: 'string',
          description:
            'Return entries before this datetime. Accepts ISO 8601 (e.g. "2026-03-18T10:30:00Z", "2026-03-18T10:30:00+05:00") or date only ("2026-03-18"). Ignored in group chats.',
        },
        after: {
          type: 'string',
          description:
            'Return entries after this datetime. Accepts ISO 8601 (e.g. "2026-03-18T10:30:00Z", "2026-03-18T10:30:00+05:00") or date only ("2026-03-18"). Ignored in group chats.',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_action_log',
    description:
      'Query the user action log — a structured audit trail of all mutating actions performed through commands, AI tools, ' +
      'callbacks, and intent matches. Use this to answer "why was event X deleted?", "who changed my calendar?", ' +
      '"what did I do yesterday?". Each entry includes a Telegram message link when available.',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: {
          type: 'number',
          description: 'Filter by target event ID — shows all actions that affected this event',
        },
        action_type: {
          type: 'string',
          enum: ['command', 'ai_tool', 'callback', 'intent_match', 'scene'],
          description: 'Filter by action type',
        },
        action_name: {
          type: 'string',
          description: 'Filter by action name (e.g. "create_event", "/add", "delete_event")',
        },
        after: {
          type: 'string',
          description: 'Return entries after this datetime (ISO 8601)',
        },
        before: {
          type: 'string',
          description: 'Return entries before this datetime (ISO 8601)',
        },
        limit: {
          type: 'number',
          description: 'Max entries to return (default 30)',
        },
      },
      required: [],
    },
  },
  {
    name: 'schedule_ai_call',
    description:
      'Schedule a one-time or recurring message to be injected into the AI pipeline on your behalf at a future time. The bot will process it as if you sent it. Use run_at for one-time, cron for recurring. Always convert user local time to UTC using their timezone before calling.',
    input_schema: {
      type: 'object' as const,
      properties: {
        message: { type: 'string', description: 'Message to inject (e.g. "call me", "show today events")' },
        run_at: { type: 'string', description: 'ISO 8601 UTC datetime for one-time execution' },
        cron: { type: 'string', description: 'Cron expression in UTC for recurring execution (e.g. "0 8 * * *")' },
        label: { type: 'string', description: 'Human-readable description' },
      },
      required: ['message'],
    },
  },
  {
    name: 'schedule_ai_calls_list',
    description: 'List all active scheduled AI calls for the user.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'schedule_ai_call_cancel',
    description: 'Cancel a scheduled AI call by id.',
    input_schema: {
      type: 'object' as const,
      properties: { id: { type: 'string', description: 'Schedule id from schedule_ai_calls_list' } },
      required: ['id'],
    },
  },
  {
    name: 'add_trigger',
    description: `Add an event-driven trigger. When the specified topic fires (and optional condition is true), the action message is injected into the AI pipeline.
Available topics: myCalendar.newEvent, myCalendar.updatedEvent, myCalendar.deletedEvent, myCalendar.conflictDetected, myCalendar.eventStarting, myInvitations.accepted, myInvitations.rejected, myGroup.newEvent.
Condition is an expression using dot-notation on the event payload (e.g. "newEvent.title == \\"standup\\"").`,
    input_schema: {
      type: 'object' as const,
      properties: {
        topic: { type: 'string', description: 'Domain event topic to listen for' },
        action: { type: 'string', description: 'Message to inject when trigger fires' },
        condition: { type: 'string', description: 'Optional filter expression evaluated against event payload' },
        label: { type: 'string', description: 'Human-readable description' },
        once: { type: 'boolean', description: 'If true, trigger auto-disables after first fire' },
      },
      required: ['topic', 'action'],
    },
  },
  {
    name: 'list_triggers',
    description: 'List all triggers for the user.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'remove_trigger',
    description: 'Remove a trigger by id.',
    input_schema: {
      type: 'object' as const,
      properties: { id: { type: 'string', description: 'Trigger id from list_triggers' } },
      required: ['id'],
    },
  },
  {
    name: 'resume_scene',
    description:
      'Resume the wizard the user was filling in before asking for AI help. ' +
      'Call this when you have answered the question and they should continue the wizard from where they left off.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'cancel_scene',
    description:
      'Cancel and discard the wizard the user was filling in. ' +
      'Call this when you have completed the action via AI tools (e.g., created the event directly) ' +
      'and the wizard is no longer needed, OR if the user wants to abort.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'set_reaction',
    description:
      'Put an emoji reaction on a Telegram message. Use in group chats to react silently. If message_id is omitted, reacts to the current incoming message.',
    input_schema: {
      type: 'object' as const,
      properties: {
        message_id: {
          type: 'number',
          description:
            'Telegram message_id to react to. Defaults to the current message if omitted. Only specify when reacting to a different message whose msg_id you see in the history prefix.',
        },
        emoji: {
          type: 'string',
          description:
            'ONLY one of these Telegram reaction emojis (no others will work): ' +
            '👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂ 🤷 🤷‍♀ 😡. ' +
            'Pick the closest match from this list.',
        },
      },
      required: ['emoji'],
    },
  },
  {
    name: 'remember_user_fact',
    description:
      'Save a fact about the user to long-term memory. Use to remember preferences, habits, important people, or anything useful for future conversations. Keep facts compact and specific. type=append adds a new fact; type=rewrite replaces all existing facts (use to consolidate or correct).',
    input_schema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          enum: ['append', 'rewrite'],
          description:
            'append: add a new fact (preferred). rewrite: DESTRUCTIVE — deletes all existing facts and replaces with this one. Use rewrite only to correct wrong information or consolidate many facts into one.',
        },
        content: { type: 'string', description: 'The fact to remember. Be concise.' },
      },
      required: ['type', 'content'],
    },
  },
  {
    name: 'connect_telegram_status',
    description: 'Check if user has connected their Telegram account for direct invitation delivery',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'dismiss_connect_telegram_prompt',
    description: 'Record that user dismissed the /connect_telegram suggestion. Suppresses the suggestion for 30 days.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'end_conversation',
    description:
      "Mark the current conversation as complete. Call when the user's request is fully resolved and no follow-up is expected. Starts a fresh context for the next unrelated request. This also creates a clean log boundary.",
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
];

// Tools not available during a live call (no visual output, no Telegram UI)
const CALL_EXCLUDED_TOOLS = new Set([
  'make_call',
  'render_day_image',
  'render_week_image',
  'render_month_image',
  'pick_users',
]);
// Tools only available during a live call
const CALL_ONLY_TOOLS = new Set(['end_call']);

export interface UserCapabilities {
  assistantEnabled: boolean;
}

const assistantToolDefinitions: ToolDefinition[] = [
  {
    name: 'claude_chat',
    description: 'Send a message to an existing Claude Desktop chat and stream the response',
    input_schema: {
      type: 'object' as const,
      properties: {
        chat_id: { type: 'string' },
        message: { type: 'string' },
        timeout_ms: { type: 'number' },
      },
      required: ['chat_id', 'message'],
    },
  },
  {
    name: 'claude_new_chat',
    description: 'Create a new Claude Desktop chat (optionally in a project) and send a first message',
    input_schema: {
      type: 'object' as const,
      properties: {
        message: { type: 'string' },
        project_id: { type: 'string' },
        timeout_ms: { type: 'number' },
      },
      required: ['message'],
    },
  },
  {
    name: 'claude_list_chats',
    description: 'List recent Claude Desktop chats with titles and IDs',
    input_schema: {
      type: 'object' as const,
      properties: { limit: { type: 'number' } },
    },
  },
  {
    name: 'claude_open_chat',
    description: 'Get messages from an existing Claude Desktop chat by ID',
    input_schema: {
      type: 'object' as const,
      properties: { chat_id: { type: 'string' } },
      required: ['chat_id'],
    },
  },
  {
    name: 'claude_list_projects',
    description: 'List Claude Desktop projects',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'claude_artifact',
    description: 'Retrieve a Claude Desktop artifact by ID',
    input_schema: {
      type: 'object' as const,
      properties: { artifact_id: { type: 'string' } },
      required: ['artifact_id'],
    },
  },
  {
    name: 'bash_execute',
    description: "Execute a bash command on the user's Mac. Returns stdout, stderr, exitCode.",
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string' },
        timeout_ms: { type: 'number' },
      },
      required: ['command'],
    },
  },
  {
    name: 'playwright_action',
    description: "Automate the browser on the user's Mac: screenshot, navigate, click, fill, extract content",
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['screenshot', 'navigate', 'click', 'fill', 'extract', 'evaluate'] },
        params: { type: 'object' },
        timeout_ms: { type: 'number' },
      },
      required: ['action', 'params'],
    },
  },
  {
    name: 'applescript_run',
    description: "Run AppleScript on the user's Mac to control macOS apps or trigger Automator workflows",
    input_schema: {
      type: 'object' as const,
      properties: {
        script: { type: 'string' },
        timeout_ms: { type: 'number' },
      },
      required: ['script'],
    },
  },
];

export function getToolDefinitions(
  inputMode?: string,
  caps?: UserCapabilities,
  supplementMode?: boolean,
): OpenAI.ChatCompletionTool[] {
  let tools: ToolDefinition[];
  if (inputMode === 'live_call') {
    tools = toolDefinitions.filter((t) => !CALL_EXCLUDED_TOOLS.has(t.name));
  } else {
    tools = toolDefinitions.filter((t) => !CALL_ONLY_TOOLS.has(t.name));
  }

  if (caps?.assistantEnabled === true) {
    tools = [...tools, ...assistantToolDefinitions];
  }

  if (supplementMode) {
    tools = tools.filter((t) => t.name !== 'end_conversation');
    tools = [
      ...tools,
      {
        name: 'supplement_skip',
        description: 'Call when the automatic response was correct and complete. Suppresses your response.',
        input_schema: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
    ];
  }
  return tools.map(toOpenAITool);
}
