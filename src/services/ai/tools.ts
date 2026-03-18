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
        location: {
          type: 'string',
          description: 'New location. Pass null to remove. Optional.',
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
    description: 'Search events by title. Returns matching events.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query to match against event titles',
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
      'Categories: general (timezone, language, country_code), ' +
      'notifications (morning agenda, evening review, quiet hours, reminders), ' +
      'calls (enabled, language), privacy (default visibility, inline mode, invitations), ' +
      'voice (voice response enabled/disabled). Use action "get" without category to return all settings.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['get', 'update'], description: 'Action to perform' },
        category: {
          type: 'string',
          enum: ['general', 'notifications', 'calls', 'privacy', 'voice'],
          description: 'Settings category. Required for update, optional for get (omit to get all).',
        },
        updates: {
          type: 'object',
          description:
            'Fields to update. For general: timezone (IANA string), language (en/ru), country_code (ISO 3166-1 alpha-2 string). For notifications: morning_agenda_enabled (bool), morning_agenda_time (HH:MM), evening_review_enabled (bool), evening_review_time (HH:MM), quiet_hours_enabled (bool), quiet_hours_start (HH:MM), quiet_hours_end (HH:MM), default_reminder_minutes (number[]). For calls: enabled (bool), language (string). For privacy: default_visibility (private/free_busy/full), inline_mode_enabled (bool), allow_invitations (bool). For voice: voice_response_enabled (bool).',
        },
      },
      required: ['action'],
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
    description: 'Get the current reminder settings for an event.',
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
      'invitee_id MUST come from find_contact, find_user, or the pick_users callback in this conversation — never from memory or assumption. ' +
      'Success means the record was created and delivery is in progress; it does NOT mean the message was received.',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: { type: 'number', description: 'ID of the event to invite to' },
        invitee_id: {
          type: 'number',
          description:
            'Telegram ID of the user to invite. Must be a value returned by find_contact, find_user, or pick_users in this conversation.',
        },
        invitee_username: {
          type: 'string',
          description: 'Telegram @username of the invitee (without @). Pass if known from find_contact.',
        },
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
      'Generate and send a beautiful calendar image for a specific date. Use when showing events for a day (today, tomorrow, specific date) — always send an image alongside text. Users love visual schedules.',
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
      'Generate and send a beautiful weekly calendar image starting from a specific date. Use when showing events for a week. Users love visual schedules.',
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
    name: 'get_history',
    description:
      'Search conversation history — past messages, button presses, commands, and bot replies. Use when the user asks about something they said or did earlier, or when you need context from before the visible conversation window.',
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
];
