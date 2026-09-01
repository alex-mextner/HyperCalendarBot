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

/**
 * Calendar selector shared by every event-facing tool. Declared once: the whole
 * catalog travels with every request, so a property spelled out in fifteen tools
 * pays for its description fifteen times.
 */
const scopeProperty = {
  type: 'string',
  enum: ['personal', 'group'],
  description: 'Default: "group" in groups, "personal" in DMs.',
};

/** Secretary delegation target shared by every event-facing tool. */
const ownerIdProperty = {
  type: 'number',
  description: "Another user's calendar. Requires active secretary access to it.",
};

const toolDefinitions: ToolDefinition[] = [
  {
    name: 'get_events',
    description: 'Get events for a date range. Returns a list of events with their details.',
    input_schema: {
      type: 'object' as const,
      properties: {
        start_date: { type: 'string', description: 'Start, ISO 8601 UTC.' },
        end_date: { type: 'string', description: 'End, ISO 8601 UTC.' },
        scope: scopeProperty,
        owner_id: ownerIdProperty,
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
        start_at: { type: 'string', description: 'Start, ISO 8601 UTC.' },
        end_at: { type: 'string', description: 'End, ISO 8601 UTC. Optional.' },
        description: { type: 'string', description: 'Event description. Optional.' },
        location: { type: 'string', description: 'Event location. Optional.' },
        location_abstract: {
          type: 'boolean',
          description:
            'True when the location is relative rather than a venue or street address ("У Иры", "дома", "на работе", "у метро"). Leave false for concrete places ("Кофемания", "ул. Ленина 10", "Парк Горького"). True stores it as plain text, with no geocoding or Maps link. Default false.',
        },
        all_day: { type: 'boolean', description: 'Whether this is an all-day event. Optional.' },
        recurrence_rule: {
          type: 'string',
          description: 'RRULE for recurring events, e.g. "FREQ=WEEKLY;INTERVAL=2". Optional.',
        },
        reminder_minutes: {
          type: 'array',
          items: { type: 'number' },
          description: 'Minutes before the event to remind, e.g. [15, 60]. Optional.',
        },
        force: {
          type: 'boolean',
          description: 'Set to true to create event in the past after user confirmed. Do NOT set without asking first.',
        },
        scope: scopeProperty,
        owner_id: ownerIdProperty,
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
        start_at: { type: 'string', description: 'New start, ISO 8601 UTC. Optional.' },
        end_at: { type: 'string', description: 'New end, ISO 8601 UTC. null removes it. Optional.' },
        description: { type: 'string', description: 'New description. null removes it. Optional.' },
        location: { type: 'string', description: 'New location. null removes it. Optional.' },
        location_abstract: {
          type: 'boolean',
          description: 'True when the new location is relative (see create_event). Skips geocoding. Default false.',
        },
        recurrence_rule: { type: 'string', description: 'New RRULE. null removes recurrence. Optional.' },
        scope: scopeProperty,
        owner_id: ownerIdProperty,
      },
      required: ['event_id'],
    },
  },
  {
    name: 'attach_pending_location_to_event',
    description:
      "Attach the user's most recent 📍 location pin to an event, resolving it to a street address. " +
      'Use once the user says which event the pin belongs to. Errors if no pin is pending (none sent, or older than 30 min).',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: { type: 'number', description: 'ID of the event to attach the pin to' },
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
        event_id: { type: 'number', description: 'ID of the event to delete' },
        scope: scopeProperty,
        owner_id: ownerIdProperty,
      },
      required: ['event_id'],
    },
  },
  {
    name: 'notify_participants',
    description:
      'Message all accepted participants of an event you own, e.g. after changing its time or place. Creator only.',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: { type: 'number', description: 'ID of the event whose participants to notify' },
        message: { type: 'string', description: 'What changed, e.g. "Meeting moved to 11:00"' },
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
        date: { type: 'string', description: 'Date, ISO 8601 UTC.' },
        scope: scopeProperty,
        owner_id: ownerIdProperty,
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
        query: { type: 'string', description: 'Title text to match. Optional when filtering by event_type.' },
        scope: scopeProperty,
        owner_id: ownerIdProperty,
        event_type: {
          type: 'string',
          enum: ['birthday', 'regular'],
          description: "Use 'birthday' to list all birthday events.",
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
        event_id: { type: 'number', description: 'ID of the event' },
        minutes_before: {
          type: 'array',
          items: { type: 'number' },
          description: 'Minutes before the event to remind, e.g. [15, 60]',
        },
        scope: scopeProperty,
        owner_id: ownerIdProperty,
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
        limit: { type: 'number', description: 'Max holidays to return. Default 10.' },
      },
      required: [],
    },
  },
  {
    name: 'manage_settings',
    description:
      'Get or update user settings. To change the interface language you MUST call this with ' +
      'action=update, category=general, updates={language:"en"|"ru"} — announcing the switch without ' +
      'persisting it is wrong. Categories: general (timezone, language, country, default duration), ' +
      'notifications (morning agenda, evening review, quiet hours, reminders), calls, privacy, voice. ' +
      'action "get" without a category returns every setting.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['get', 'update'], description: 'Action to perform' },
        category: {
          type: 'string',
          enum: ['general', 'notifications', 'calls', 'privacy', 'voice', 'assistant'],
          description: 'Required for update; for get, omit to return all.',
        },
        updates: {
          type: 'object',
          description:
            'Fields per category. general: timezone (IANA), language (en/ru), country_code (ISO 3166-1 alpha-2), default_event_duration_minutes (1–1440). notifications: morning_agenda_enabled (bool), morning_agenda_time (HH:MM), evening_review_enabled (bool), evening_review_time (HH:MM), quiet_hours_enabled (bool), quiet_hours_start (HH:MM), quiet_hours_end (HH:MM), default_reminder_minutes (number[]). calls: enabled (bool), language (string). privacy: default_visibility (private/free_busy/full), inline_mode_enabled (bool), allow_invitations (bool). voice: voice_response_enabled (bool).',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'end_call',
    description:
      'Hang up the current live call. Use only when the user says goodbye or asks to end it — speak a short farewell first.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'make_call',
    description:
      'Call the user and speak a message aloud. Use when they ask to be called. On error, say voice calls are temporarily unavailable — the cause is server-side, not their settings.',
    input_schema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string', description: 'Text to speak during the call' },
      },
      required: ['text'],
    },
  },
  {
    name: 'get_upcoming',
    description: 'Get the next upcoming events from now, for "what do I have next?" / "upcoming events".',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Max events to return. Default 5.' },
        scope: scopeProperty,
        owner_id: ownerIdProperty,
      },
      required: [],
    },
  },
  {
    name: 'snooze_event',
    description: 'Postpone an event by N minutes, shifting both start and end.',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: { type: 'number', description: 'ID of the event to snooze' },
        minutes: { type: 'number', description: 'Minutes to postpone by. Default 10.' },
        scope: scopeProperty,
        owner_id: ownerIdProperty,
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
        scope: scopeProperty,
        owner_id: ownerIdProperty,
      },
      required: ['event_id'],
    },
  },
  {
    name: 'get_reminders',
    description:
      'Get upcoming reminders for one or more events: event_id for one, event_ids for several, or query to search by title.',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: { type: 'number', description: 'ID of a single event' },
        event_ids: { type: 'array', items: { type: 'number' }, description: 'IDs of several events' },
        query: { type: 'string', description: 'Search events by title and show their reminders' },
        scope: scopeProperty,
        owner_id: ownerIdProperty,
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
        target_type: { type: 'string', enum: ['user', 'group'], description: 'Sharing with a user or a group' },
        target_id: { type: 'number', description: 'Telegram ID of the user or group' },
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
            'Telegram ID of the invitee, from find_contact, find_user, or pick_users. Optional if invitee_username is given.',
        },
        invitee_username: {
          type: 'string',
          description: 'Telegram @username without @. Resolved automatically when invitee_id is absent.',
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
        period: { type: 'string', enum: ['today', 'tomorrow', 'week'], description: 'Period to share' },
        target_type: { type: 'string', enum: ['user', 'group'], description: 'Sharing with a user or a group' },
        target_id: { type: 'number', description: 'Telegram ID of the user or group' },
      },
      required: ['period', 'target_type', 'target_id'],
    },
  },
  {
    name: 'find_user',
    description:
      'Find a bot user by Telegram @username and return their telegram_id for send_invitation. Only finds people who have used the bot.',
    input_schema: {
      type: 'object' as const,
      properties: {
        username: { type: 'string', description: 'Telegram username (with or without @)' },
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
          description: 'Only true after the user confirmed showing their private contacts in a group.',
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
        name: { type: 'string', description: 'Full display name, e.g. "Elena Larichkina"' },
        username: { type: 'string', description: 'Telegram @username without @. Optional.' },
        preferred_name: {
          type: 'string',
          description: 'Exactly how the user refers to this person, e.g. "Лена", "Вова", "Alex".',
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
    description: "Rename or correct an existing contact's name, preferred_name, or username.",
    input_schema: {
      type: 'object' as const,
      properties: {
        search: { type: 'string', description: 'Current name or @username identifying the contact' },
        name: { type: 'string', description: 'New display name. Optional.' },
        preferred_name: { type: 'string', description: 'New preferred name. Optional.' },
        username: { type: 'string', description: 'New Telegram @username without @. Optional.' },
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
          description: 'Explain who needs to be found and why, naming the people missing from the address book.',
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
        date: { type: 'string', description: 'Date as YYYY-MM-DD' },
        scope: scopeProperty,
        owner_id: ownerIdProperty,
      },
      required: ['date'],
    },
  },
  {
    name: 'render_week_image',
    description:
      'Generate and send a visual weekly calendar image, for an explicit request or a week overview with many events.',
    input_schema: {
      type: 'object' as const,
      properties: {
        week_start: { type: 'string', description: 'Monday date as YYYY-MM-DD' },
        scope: scopeProperty,
        owner_id: ownerIdProperty,
      },
      required: ['week_start'],
    },
  },
  {
    name: 'render_month_image',
    description: 'Generate and send a visual monthly calendar image, for requests like "show April" or "monthly view".',
    input_schema: {
      type: 'object' as const,
      properties: {
        month: { type: 'string', description: 'Month as YYYY-MM' },
        scope: scopeProperty,
        owner_id: ownerIdProperty,
      },
      required: ['month'],
    },
  },
  {
    name: 'render_table',
    description:
      'Render a Markdown table as an image and send it to the chat. Call it whenever you have tabular data, ' +
      'in parallel with your text reply — and in that reply present the same data as a bullet list, never as raw ' +
      'Markdown table syntax. During a voice call the image still goes to the chat, so mention it out loud.',
    input_schema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Table heading shown above the image.' },
        markdown: {
          type: 'string',
          description: 'Markdown table, e.g. "| Plan | Price |\\n|---|---|\\n| Basic | $5 |"',
        },
        caption: { type: 'string', description: 'Optional note shown below the table.' },
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
        owner_id: ownerIdProperty,
      },
      required: ['event_id', 'visibility'],
    },
  },
  {
    name: 'propose_edit',
    description:
      'Propose changes to a shared event you participate in but do not own. The creator receives the proposal with Accept/Reject buttons.',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: { type: 'number', description: 'ID of the shared event to propose changes to' },
        changes: {
          type: 'object',
          description: 'Fields to change, e.g. {"start_at": "2026-03-20T11:00:00Z"}. null removes a field.',
        },
        reason: { type: 'string', description: 'Short explanation of why. Optional.' },
      },
      required: ['event_id', 'changes'],
    },
  },
  {
    name: 'cancel_invitation',
    description: 'Revoke a pending invitation the user sent.',
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
    description: 'Nudge an invitee about an unanswered invitation by re-sending the notification.',
    input_schema: {
      type: 'object' as const,
      properties: {
        invitation_id: { type: 'number', description: 'ID of the invitation to resend' },
        invitee_username: { type: 'string', description: 'Telegram @username without @, if known.' },
      },
      required: ['invitation_id'],
    },
  },
  {
    name: 'get_google_calendar_status',
    description:
      'Check whether Google Calendar is connected and which calendars sync. If not connected, suggest /connect_google.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'list_google_calendars',
    description: "List the user's Google Calendars with sync status. Requires Google Calendar to be connected.",
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'send_feedback',
    description:
      'Send a bug report, feature request or question to the bot developer, opening a two-way feedback thread.',
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
      'Look up stress marks for Russian words in a 555K-form dictionary. Returns each word with + before the ' +
      'stressed vowel ("молоко" → "молок+о"); words not found come back with similar entries instead. Pass every ' +
      'word together with its likely variants (other cases, infinitive, nominative, singular/plural) in ONE call — ' +
      'hundreds of words are handled instantly.',
    input_schema: {
      type: 'object' as const,
      properties: {
        words: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Lowercase words without punctuation, including variants: for "алексом" also "алекс", "алексей", "алексея".',
        },
      },
      required: ['words'],
    },
  },
  {
    name: 'get_bot_info',
    description:
      'Get non-obvious bot capabilities that no other tool reveals. Call when the user asks what the bot can do or for help.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  {
    name: 'list_calendar_access',
    description:
      'List the calendars this user can reach — their own, any they manage as secretary, and the secretaries they ' +
      'granted access to. Call when the user asks about secretaries or when whose-calendar is ambiguous.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'manage_secretaries',
    description:
      'Manage secretary access to a calendar. "invite" asks a user to become your secretary (needs ' +
      'secretary_telegram_id and permission); "revoke" removes a secretary from your calendar and "self_remove" ' +
      'gives up your own secretary role (both need secretary_access_id from list_calendar_access).',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['invite', 'revoke', 'self_remove'] },
        secretary_telegram_id: { type: 'number', description: 'Who to invite. Required for invite.' },
        permission: { type: 'string', enum: ['read', 'write'], description: 'Access level. Required for invite.' },
        secretary_access_id: {
          type: 'number',
          description: 'Access record ID. Required for revoke and self_remove.',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'propose_calendar_change',
    description:
      'Propose a calendar change to another member of this group — they get a DM with Accept/Decline buttons, ' +
      'since you cannot edit their calendar directly. Actions: "create", "update", "delete"; update and delete need ' +
      'an event_id seen earlier in this chat. Resolve the person with find_user first. After calling, STOP — the ' +
      'group is notified of the outcome automatically.',
    input_schema: {
      type: 'object' as const,
      properties: {
        target_telegram_id: { type: 'number', description: 'Group member to propose the change to.' },
        action: { type: 'string', enum: ['create', 'update', 'delete'] },
        event: { type: 'object', description: 'Full event data. Required for "create".' },
        event_id: { type: 'number', description: 'Existing event. Required for "update" and "delete".' },
        changes: { type: 'object', description: 'Fields to change. Required for "update".' },
        summary: {
          type: 'string',
          description: 'Human-readable description shown in the DM, e.g. "добавить «Ретро» — пятница 15:00–16:00".',
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
            'Expression to evaluate, e.g. "2 + 31", "22:34 + 31min", "2026-03-18T22:34:00Z + 2weeks", "2026-03-18 + 1month", "23:50 - 1hour", "2026-03-21T18:00:00Z - 2026-03-21T17:00:00Z"',
        },
      },
      required: ['expression'],
    },
  },
  {
    name: 'get_timezone_info',
    description:
      'Get accurate UTC offset, DST status and local time for one or more IANA timezones. ALWAYS use it instead ' +
      'of recalling offsets — DST rules change. Pass `at` with the event datetime when scheduling ahead, since the ' +
      'offset then may differ from today. Pass an array to compare zones: the reply already says which is ahead ' +
      'and, for exactly two, the difference in hours.',
    input_schema: {
      type: 'object' as const,
      properties: {
        timezone: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: 'IANA name, e.g. "America/New_York", or an array of them to compare.',
        },
        at: {
          type: 'string',
          description: 'ISO 8601 datetime to read the offset at. Default now; pass the event time when scheduling.',
        },
      },
      required: ['timezone'],
    },
  },
  {
    name: 'convert_to_timezone',
    description:
      'Convert a UTC or offset-aware datetime to local time in any IANA timezone, applying DST for that exact moment.',
    input_schema: {
      type: 'object' as const,
      properties: {
        datetime: { type: 'string', description: 'ISO 8601 datetime, UTC or with offset' },
        timezone: { type: 'string', description: 'IANA timezone name, e.g. "America/New_York"' },
      },
      required: ['datetime', 'timezone'],
    },
  },
  {
    name: 'get_history',
    description:
      'Search conversation history — past messages, button presses, commands and bot replies. Chat messages only, ' +
      'never calendar data: for "what did I do last week?" use get_events instead. Use it to recall something said ' +
      'before the visible conversation window.',
    input_schema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Max entries to return. Default 50.' },
        search: { type: 'string', description: 'Filter entries containing this text' },
        before: { type: 'string', description: 'Entries before this ISO 8601 datetime or date. Ignored in groups.' },
        after: { type: 'string', description: 'Entries after this ISO 8601 datetime or date. Ignored in groups.' },
      },
      required: [],
    },
  },
  {
    name: 'get_action_log',
    description:
      'Query the audit trail of every mutating action (commands, AI tools, callbacks, intent matches). Answers ' +
      '"why was event X deleted?", "who changed my calendar?". Entries link to the Telegram message when available.',
    input_schema: {
      type: 'object' as const,
      properties: {
        event_id: { type: 'number', description: 'Show only actions that affected this event' },
        action_type: {
          type: 'string',
          enum: ['command', 'ai_tool', 'callback', 'intent_match', 'scene'],
          description: 'Filter by action type',
        },
        action_name: { type: 'string', description: 'Filter by name, e.g. "create_event", "/add"' },
        after: { type: 'string', description: 'Entries after this ISO 8601 datetime' },
        before: { type: 'string', description: 'Entries before this ISO 8601 datetime' },
        limit: { type: 'number', description: 'Max entries to return. Default 30.' },
      },
      required: [],
    },
  },
  {
    name: 'schedule_ai_call',
    description:
      'Schedule a message to be fed back into the AI pipeline later, as if the user had sent it. run_at for one ' +
      "time, cron for recurring. Convert the user's local time to UTC first.",
    input_schema: {
      type: 'object' as const,
      properties: {
        message: { type: 'string', description: 'Message to inject, e.g. "show today events"' },
        run_at: { type: 'string', description: 'ISO 8601 UTC datetime for a one-time run' },
        cron: { type: 'string', description: 'Cron expression in UTC for a recurring run, e.g. "0 8 * * *"' },
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
    description:
      'Add an event-driven trigger: when the topic fires and the optional condition holds, the action message is ' +
      'injected into the AI pipeline. Topics: myCalendar.newEvent, myCalendar.updatedEvent, myCalendar.deletedEvent, ' +
      'myCalendar.eventStarting, myInvitations.accepted, myInvitations.rejected, myGroup.newEvent.',
    input_schema: {
      type: 'object' as const,
      properties: {
        topic: { type: 'string', description: 'Domain event topic to listen for' },
        action: { type: 'string', description: 'Message to inject when the trigger fires' },
        condition: {
          type: 'string',
          description: 'Dot-notation expression over the event payload, e.g. newEvent.title == "standup"',
        },
        label: { type: 'string', description: 'Human-readable description' },
        once: { type: 'boolean', description: 'If true, auto-disable after the first fire' },
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
      'Resume the wizard the user paused to ask for help, once you have answered and they should carry on from where they stopped.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'cancel_scene',
    description:
      'Discard the paused wizard — because you already completed the action with tools, or the user wants to abort.',
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
            'Message to react to. Defaults to the current one; set it only to react to another message whose msg_id you saw in the history prefix.',
        },
        emoji: {
          type: 'string',
          description:
            'Pick the closest match — ONLY these Telegram reactions work: ' +
            '👍 👎 ❤ 🔥 🥰 👏 😁 🤔 🤯 😱 🤬 😢 🎉 🤩 🤮 💩 🙏 👌 🕊 🤡 🥱 🥴 😍 🐳 ❤‍🔥 🌚 🌭 💯 🤣 ⚡ 🍌 🏆 💔 🤨 😐 🍓 🍾 💋 🖕 😈 😴 😭 🤓 👻 👨‍💻 👀 🎃 🙈 😇 😨 🤝 ✍ 🤗 🫡 🎅 🎄 ☃ 💅 🤪 🗿 🆒 💘 🙉 🦄 😘 💊 🙊 😎 👾 🤷‍♂ 🤷 🤷‍♀ 😡.',
        },
      },
      required: ['emoji'],
    },
  },
  {
    name: 'remember_user_fact',
    description:
      'Save a compact fact about the user — preferences, habits, important people — for future conversations. ' +
      'type=append adds one; type=rewrite replaces all existing facts.',
    input_schema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          enum: ['append', 'rewrite'],
          description:
            'append: add a fact (preferred). rewrite: DESTRUCTIVE, deletes every existing fact — only to correct wrong information or consolidate.',
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
      "Mark the conversation complete when the user's request is fully resolved and no follow-up is expected. Starts a fresh context for the next unrelated request.",
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
