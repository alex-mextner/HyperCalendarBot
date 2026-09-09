// scripts/seed-intents-event-editing.ts — pre-approved intents for editing an existing event's
// non-time fields: title, location, description, participants, and duration.
//
// update_event_time (already approved) owns start_at/end_at moves. This category owns
// everything else update_event exposes (title, location, description; recurrence_rule is
// NOT covered here — no request for recurrence editing was in scope) plus participant
// management via send_invitation/delete_event, plus duration changes computed with calculate.
//
// Every workflow resolves the target event via {{last_mentioned_event.id}}, exactly like the
// already-approved `update_event_time` intent and the sibling rescheduling category.
//
// "remove a participant" scope note: update_event has no participant field, and neither
// send_invitation nor get_invitation_status return a structured invitation id in ToolResult.data
// (checked against src/services/ai/tool-handlers/sharing.ts — both return text-only `output`).
// cancel_invitation requires a numeric invitation_id that no workflow step can obtain, so
// "remove some other participant by name" cannot be built as a deterministic pre-approved
// intent with the current tool set. The one form of "remove a participant" that IS
// deterministic and requires no lookup is the current user removing themself — delete_event's
// own description says it declines the invitation instead of deleting when the caller is a
// participant, not the creator. `remove_own_participation` below covers exactly that.
//
// "change event duration" is implemented as relative extend/shorten (matching the existing
// snooze_event_minutes/hours pattern style) rather than an absolute "set duration to N", because
// building an absolute duration requires reconstructing the event's start instant from
// last_mentioned_event.date + .time + user.utc_offset, which is undefined for all-day events
// (EventSummary.time is absent then) and adds no real value over "extend/shorten by N" for the
// common case. calculate's ISO-datetime ± duration form is applied to last_mentioned_event.end_at
// directly, avoiding that reconstruction entirely.
//
// NOT wired into scripts/seed-intents.ts and NOT run against any DB — a separate integration
// pass consolidates every category's file, dedupes canonical_names, and seeds once.

const intents: Array<{
  canonical_name: string;
  pattern: string;
  workflow: object;
  phrases: string[];
  trigger_words: string[];
  source_message: string;
}> = [
  // ─── rename_event ─────────────────────────────────────────────────────────────
  {
    canonical_name: 'rename_event',
    pattern:
      '^(?:переименуй|назови)\\s+(?:событие|встречу)(?:\\s+в|\\s+как)\\s+(.+)$|^rename\\s+(?:the\\s+)?(?:event|meeting)\\s+to\\s+(.+)$',
    workflow: {
      tools: [
        {
          name: 'update_event',
          input: {
            event_id: '{{last_mentioned_event.id}}',
            title: '{{$1}}{{$2}}',
            scope: '{{env.scope}}',
          },
        },
      ],
    },
    phrases: [
      'переименуй событие в стендап',
      'переименуй встречу в созвон с клиентом',
      'назови событие как день рождения',
      'rename the event to standup',
      'rename meeting to client call',
    ],
    trigger_words: ['переименуй', 'назови', 'rename'],
    source_message: 'переименуй событие в стендап',
  },

  // ─── change_event_location ──────────────────────────────────────────────────
  {
    canonical_name: 'change_event_location',
    pattern:
      '^(?:измени|поменяй|смени|укажи)\\s+место(?:\\s+встречи|\\s+события)?\\s+на\\s+(.+)$|^(?:change|update|set)\\s+the\\s+(?:event\\s+)?location\\s+to\\s+(.+)$',
    workflow: {
      tools: [
        {
          name: 'update_event',
          input: {
            event_id: '{{last_mentioned_event.id}}',
            location: '{{$1}}{{$2}}',
            scope: '{{env.scope}}',
          },
        },
      ],
    },
    phrases: [
      'измени место встречи на кофейню на арбате',
      'поменяй место события на офис',
      'укажи место на парк горького',
      'change the event location to the coffee shop',
      'update the location to the office',
      'set the event location to central park',
    ],
    trigger_words: ['место', 'location'],
    source_message: 'измени место встречи на кофейню на арбате',
  },

  // ─── add_event_description ──────────────────────────────────────────────────
  {
    canonical_name: 'add_event_description',
    pattern:
      '^(?:измени|поменяй|добавь|напиши|укажи)\\s+описание(?:\\s+к\\s+событию|\\s+события|\\s+встречи)?(?:\\s+на)?\\s+(.+)$|^(?:change|update|add|set)\\s+the\\s+(?:event\\s+)?description\\s+to\\s+(.+)$',
    workflow: {
      tools: [
        {
          name: 'update_event',
          input: {
            event_id: '{{last_mentioned_event.id}}',
            description: '{{$1}}{{$2}}',
            scope: '{{env.scope}}',
          },
        },
      ],
    },
    phrases: [
      'добавь описание принести ноутбук',
      'измени описание события на обсудить бюджет',
      'укажи описание встречи взять паспорт',
      'add the event description bring your laptop',
      'change the description to discuss the budget',
      'set the event description to bring your passport',
    ],
    trigger_words: ['описание', 'description'],
    source_message: 'добавь описание принести ноутбук',
  },

  // ─── add_participant_to_event ───────────────────────────────────────────────
  {
    canonical_name: 'add_participant_to_event',
    pattern:
      '^(?:добавь|пригласи|позови)\\s+@(\\w+)(?:\\s+(?:в|на)\\s+(?:событие|встречу))?$|^(?:add|invite)\\s+@(\\w+)(?:\\s+to\\s+the\\s+(?:event|meeting))?$',
    workflow: {
      tools: [
        {
          name: 'send_invitation',
          input: {
            event_id: '{{last_mentioned_event.id}}',
            invitee_username: '{{$1}}{{$2}}',
          },
        },
      ],
    },
    phrases: [
      'добавь @ivan в событие',
      'пригласи @maria на встречу',
      'позови @petrov',
      'add @ivan to the event',
      'invite @maria to the meeting',
    ],
    trigger_words: ['добавь', 'пригласи', 'позови', 'add', 'invite'],
    source_message: 'добавь @ivan в событие',
  },

  // ─── remove_own_participation ───────────────────────────────────────────────
  // Not "remove another participant" (no tool exposes that) — this removes the CURRENT
  // user from an event they were invited to. delete_event's own description: "If the user
  // is a participant (not the creator), this declines the invitation instead of deleting —
  // the event stays for the creator and other participants."
  {
    canonical_name: 'remove_own_participation',
    pattern:
      '^(?:убери|удали)\\s+меня\\s+(?:из|с)\\s+(?:событи[ея]|встречи)$|^(?:remove|take)\\s+me\\s+(?:off|from)\\s+the\\s+(?:event|meeting)$',
    workflow: {
      tools: [
        {
          name: 'delete_event',
          input: {
            event_id: '{{last_mentioned_event.id}}',
            scope: '{{env.scope}}',
          },
        },
      ],
    },
    phrases: [
      'убери меня из события',
      'удали меня с встречи',
      'убери меня из этой встречи',
      'remove me from the event',
      'take me off the meeting',
    ],
    trigger_words: ['убери', 'удали', 'remove', 'take'],
    source_message: 'убери меня из события',
  },

  // ─── extend_event_duration_minutes ──────────────────────────────────────────
  {
    canonical_name: 'extend_event_duration_minutes',
    pattern:
      '^(?:продли|удлини)\\s+событие\\s+на\\s+(\\d{1,3})\\s*(?:минут(?:у|ы)?|мин)$|^(?:extend|lengthen)\\s+(?:the\\s+)?(?:event|meeting)\\s+by\\s+(\\d{1,3})\\s*min(?:ute)?s?$',
    workflow: {
      steps: [
        {
          call: 'calculate',
          input: { expression: '{{last_mentioned_event.end_at}} + {{$1}}{{$2}} minutes' },
          as: 'new_end',
        },
        {
          call: 'update_event',
          input: {
            event_id: '{{last_mentioned_event.id}}',
            end_at: '{{tool_outputs.new_end}}',
            scope: '{{env.scope}}',
          },
        },
      ],
    },
    phrases: [
      'продли событие на 30 минут',
      'удлини встречу на 15 минут',
      'extend the event by 30 minutes',
      'lengthen the meeting by 15 minutes',
    ],
    trigger_words: ['продли', 'удлини', 'extend', 'lengthen'],
    source_message: 'продли событие на 30 минут',
  },

  // ─── extend_event_duration_hours ────────────────────────────────────────────
  {
    canonical_name: 'extend_event_duration_hours',
    pattern:
      '^(?:продли|удлини)\\s+событие\\s+на\\s+(\\d{1,2})\\s*(?:час(?:а|ов)?|ч)$|^(?:extend|lengthen)\\s+(?:the\\s+)?(?:event|meeting)\\s+by\\s+(\\d{1,2})\\s*h(?:our)?s?$',
    workflow: {
      steps: [
        {
          call: 'calculate',
          input: { expression: '{{last_mentioned_event.end_at}} + {{$1}}{{$2}} hours' },
          as: 'new_end',
        },
        {
          call: 'update_event',
          input: {
            event_id: '{{last_mentioned_event.id}}',
            end_at: '{{tool_outputs.new_end}}',
            scope: '{{env.scope}}',
          },
        },
      ],
    },
    phrases: [
      'продли событие на 1 час',
      'удлини встречу на 2 часа',
      'extend the event by 1 hour',
      'lengthen the meeting by 2 hours',
    ],
    trigger_words: ['продли', 'удлини', 'extend', 'lengthen'],
    source_message: 'продли событие на 1 час',
  },

  // ─── shorten_event_duration_minutes ─────────────────────────────────────────
  {
    canonical_name: 'shorten_event_duration_minutes',
    pattern:
      '^(?:сократи|укороти)\\s+событие\\s+на\\s+(\\d{1,3})\\s*(?:минут(?:у|ы)?|мин)$|^(?:shorten|cut)\\s+(?:the\\s+)?(?:event|meeting)\\s+by\\s+(\\d{1,3})\\s*min(?:ute)?s?$',
    workflow: {
      steps: [
        {
          call: 'calculate',
          input: { expression: '{{last_mentioned_event.end_at}} - {{$1}}{{$2}} minutes' },
          as: 'new_end',
        },
        {
          call: 'update_event',
          input: {
            event_id: '{{last_mentioned_event.id}}',
            end_at: '{{tool_outputs.new_end}}',
            scope: '{{env.scope}}',
          },
        },
      ],
    },
    phrases: [
      'сократи событие на 15 минут',
      'укороти встречу на 10 минут',
      'shorten the event by 15 minutes',
      'cut the meeting by 10 minutes',
    ],
    trigger_words: ['сократи', 'укороти', 'shorten', 'cut'],
    source_message: 'сократи событие на 15 минут',
  },
];

export { intents as eventEditingIntents };
