// scripts/seed-intents-sharing-secretary.ts — candidate intents for the Sharing/secretary access category.
// Written for review + integration by a separate consolidation task. Do NOT run this file directly
// against the live/dev DB and do NOT import scripts/seed-intents.ts's DB-writing logic here.
//
// IMPORTANT FINDING (see report handed back to the orchestrator): the originally-assigned
// `list_calendar_access` read intent ("кто мой секретарь" / "who has access to my calendar") and any
// intent that needs `secretary_access_id` to call `manage_secretaries` action "revoke"/"self_remove"
// are NOT buildable as safe, correctly-working deterministic intents with the current tool surface:
// `handleListCalendarAccess` returns a JSON object whose `own`/`my_secretaries`/`secretary_for` fields
// are nested (objects/arrays), which fails every branch of intent-executor's `ToolOutputSchema` zod
// union (verified empirically — safeParse always fails for this shape). That makes
// `parseToolOutput()` fall back to the RAW JSON STRING, which then breaks in two ways:
//   1. Template field access (`{{tool_outputs.access.my_secretaries[0].display_name}}`) always
//      resolves to `undefined` (accessPath is defensive) — the data can never be shown to the user.
//   2. A `when` condition that dereferences it (`access.my_secretaries.length == 0`) makes
//      expression-evaluator call `Reflect.get()` on a string primitive, which THROWS a TypeError
//      (confirmed via a live Bun test) — an uncaught exception inside intent-executor's step loop.
// Shipping either variant would mean the intent either dumps raw JSON to the user (tone-of-voice
// violation) or crashes the message pipeline. Since `manage_secretaries`'s revoke/self_remove actions
// have no alternative telegram_id-based path (they strictly require the numeric access-record id from
// this same broken tool), those two "remove someone's access" directions are equally unbuildable.
// Fixing this needs an app-code change to `handleListCalendarAccess` (flatten its output or set a
// structured `data` field) — out of scope for intent seeding. Filed as a follow-up in the report.
//
// This file instead covers the remaining, fully safe and verified corners of the same category:
// sharing a period agenda or a specific event with a named user, granting secretary access (which
// only needs find_user's flat {telegram_id, name} data — verified safe), and controlling per-event
// visibility for sharing. All workflows were validated against the real WorkflowSchema,
// validateWorkflowVariables, and toolDefinitions (see report).

interface SeedIntent {
  canonical_name: string;
  pattern: string;
  workflow: object;
  phrases: string[];
  trigger_words: string[];
  source_message: string;
}

export const sharingSecretaryIntents: SeedIntent[] = [
  // ─── share_agenda_today ───────────────────────────────────────────────────────
  {
    canonical_name: 'share_agenda_today',
    pattern:
      '^(?:поделись|отправь|перешли|share)\\s+(?:своим\\s+|моим\\s+|my\\s+)?' +
      '(?:сегодняшним\\s+расписанием|расписанием\\s+на\\s+сегодня|планами\\s+на\\s+сегодня|' +
      'today\\s+agenda|agenda\\s+for\\s+today|schedule\\s+for\\s+today|today\\s+schedule)\\s+' +
      '(?:с|with)\\s+@?([a-z0-9_]{5,32})$',
    workflow: {
      steps: [
        { call: 'find_user', input: { username: '{{$1}}' }, as: 'target' },
        {
          call: 'share_agenda',
          input: { period: 'today', target_type: 'user', target_id: '{{tool_outputs.target.telegram_id}}' },
        },
        { respond: '{{t.done}}' },
      ],
      i18n: {
        ru: { done: 'Готово — расписание на сегодня доступно {{tool_outputs.target.name}}.' },
        en: { done: "Done — today's schedule is now shared with {{tool_outputs.target.name}}." },
      },
    },
    phrases: ['поделись расписанием на сегодня с @ivan_petrov', 'share today agenda with @ivan_petrov'],
    trigger_words: ['поделись', 'отправь', 'перешли', 'расписанием', 'сегодня', 'share', 'agenda', 'today', 'schedule'],
    source_message: 'поделись расписанием на сегодня с @ivan_petrov',
  },

  // ─── share_agenda_tomorrow ────────────────────────────────────────────────────
  {
    canonical_name: 'share_agenda_tomorrow',
    pattern:
      '^(?:поделись|отправь|перешли|share)\\s+(?:своим\\s+|моим\\s+|my\\s+)?' +
      '(?:завтрашним\\s+расписанием|расписанием\\s+на\\s+завтра|планами\\s+на\\s+завтра|' +
      'tomorrow\\s+agenda|agenda\\s+for\\s+tomorrow|schedule\\s+for\\s+tomorrow|tomorrow\\s+schedule)\\s+' +
      '(?:с|with)\\s+@?([a-z0-9_]{5,32})$',
    workflow: {
      steps: [
        { call: 'find_user', input: { username: '{{$1}}' }, as: 'target' },
        {
          call: 'share_agenda',
          input: { period: 'tomorrow', target_type: 'user', target_id: '{{tool_outputs.target.telegram_id}}' },
        },
        { respond: '{{t.done}}' },
      ],
      i18n: {
        ru: { done: 'Готово — расписание на завтра доступно {{tool_outputs.target.name}}.' },
        en: { done: "Done — tomorrow's schedule is now shared with {{tool_outputs.target.name}}." },
      },
    },
    phrases: ['поделись расписанием на завтра с @ivan_petrov', 'share tomorrow agenda with @ivan_petrov'],
    trigger_words: [
      'поделись',
      'отправь',
      'перешли',
      'расписанием',
      'завтра',
      'share',
      'agenda',
      'tomorrow',
      'schedule',
    ],
    source_message: 'поделись расписанием на завтра с @ivan_petrov',
  },

  // ─── share_agenda_week (pairs with the approved show_week intent) ────────────
  {
    canonical_name: 'share_agenda_week',
    pattern:
      '^(?:поделись|отправь|перешли|share)\\s+(?:своим\\s+|моим\\s+|my\\s+)?' +
      '(?:недельным\\s+расписанием|расписанием\\s+на\\s+неделю|планами\\s+на\\s+неделю|' +
      'weekly\\s+agenda|agenda\\s+for\\s+the\\s+week|schedule\\s+for\\s+the\\s+week|week\\s+agenda|week\\s+schedule)\\s+' +
      '(?:с|with)\\s+@?([a-z0-9_]{5,32})$',
    workflow: {
      steps: [
        { call: 'find_user', input: { username: '{{$1}}' }, as: 'target' },
        {
          call: 'share_agenda',
          input: { period: 'week', target_type: 'user', target_id: '{{tool_outputs.target.telegram_id}}' },
        },
        { respond: '{{t.done}}' },
      ],
      i18n: {
        ru: { done: 'Готово — расписание на неделю доступно {{tool_outputs.target.name}}.' },
        en: { done: "Done — this week's schedule is now shared with {{tool_outputs.target.name}}." },
      },
    },
    phrases: ['поделись расписанием на неделю с @ivan_petrov', 'share weekly agenda with @ivan_petrov'],
    trigger_words: ['поделись', 'отправь', 'перешли', 'расписанием', 'неделю', 'share', 'agenda', 'week', 'schedule'],
    source_message: 'поделись расписанием на неделю с @ivan_petrov',
  },

  // ─── share_last_event (share the event currently in conversational focus) ────
  {
    canonical_name: 'share_last_event',
    pattern:
      '^(?:поделись|отправь|перешли|share)\\s+(?:этим\\s+событием|это\\s+событие|this\\s+event)\\s+' +
      '(?:с|with)\\s+@?([a-z0-9_]{5,32})$',
    workflow: {
      steps: [
        { call: 'find_user', input: { username: '{{$1}}' }, as: 'target' },
        {
          call: 'share_event',
          input: {
            event_id: '{{last_mentioned_event.id}}',
            target_type: 'user',
            target_id: '{{tool_outputs.target.telegram_id}}',
          },
        },
        { respond: '{{t.done}}' },
      ],
      i18n: {
        ru: { done: 'Готово — {{tool_outputs.target.name}} увидит «{{last_mentioned_event.title}}».' },
        en: { done: 'Done — {{tool_outputs.target.name}} will see "{{last_mentioned_event.title}}".' },
      },
    },
    phrases: ['поделись этим событием с @ivan_petrov', 'share this event with @ivan_petrov'],
    trigger_words: ['поделись', 'отправь', 'перешли', 'событием', 'событие', 'share', 'event'],
    source_message: 'поделись этим событием с @ivan_petrov',
  },

  // ─── invite_secretary_read (default, view-only access) ───────────────────────
  {
    canonical_name: 'invite_secretary_read',
    pattern:
      '^(?:добавь|сделай|назначь|add|make)\\s+@?([a-z0-9_]{5,32})\\s+' +
      '(?:в\\s+секретари|моим\\s+секретарем|секретарем|секретарём|as\\s+my\\s+secretary|as\\s+a\\s+secretary|my\\s+secretary)$',
    workflow: {
      steps: [
        { call: 'find_user', input: { username: '{{$1}}' }, as: 'target' },
        {
          call: 'manage_secretaries',
          input: { action: 'invite', secretary_telegram_id: '{{tool_outputs.target.telegram_id}}', permission: 'read' },
        },
        { respond: '{{t.done}}' },
      ],
      i18n: {
        ru: {
          done:
            'Приглашение отправлено — {{tool_outputs.target.name}} сможет просматривать твой календарь, ' +
            'как только примет.',
        },
        en: {
          done: 'Invitation sent — {{tool_outputs.target.name}} will be able to view your calendar once they accept.',
        },
      },
    },
    phrases: ['добавь @ivan_petrov в секретари', 'add @ivan_petrov as my secretary'],
    trigger_words: ['добавь', 'сделай', 'назначь', 'секретари', 'секретарем', 'секретарём', 'add', 'make', 'secretary'],
    source_message: 'добавь @ivan_petrov в секретари',
  },

  // ─── invite_secretary_write (explicit edit access) ────────────────────────────
  {
    canonical_name: 'invite_secretary_write',
    pattern:
      '^(?:дай|добавь|сделай|give|add|make)\\s+@?([a-z0-9_]{5,32})\\s+' +
      '(?:право\\s+редактировать\\s+(?:мой\\s+)?календарь|секретарем\\s+с\\s+правом\\s+редактирования|' +
      'секретарём\\s+с\\s+правом\\s+редактирования|доступ\\s+на\\s+редактирование\\s+календаря|' +
      'edit\\s+access\\s+to\\s+(?:my\\s+)?calendar|as\\s+a\\s+secretary\\s+with\\s+edit\\s+access|' +
      'a\\s+secretary\\s+who\\s+can\\s+edit)$',
    workflow: {
      steps: [
        { call: 'find_user', input: { username: '{{$1}}' }, as: 'target' },
        {
          call: 'manage_secretaries',
          input: {
            action: 'invite',
            secretary_telegram_id: '{{tool_outputs.target.telegram_id}}',
            permission: 'write',
          },
        },
        { respond: '{{t.done}}' },
      ],
      i18n: {
        ru: {
          done:
            'Приглашение отправлено — {{tool_outputs.target.name}} сможет просматривать и редактировать ' +
            'твой календарь, как только примет.',
        },
        en: {
          done:
            'Invitation sent — {{tool_outputs.target.name}} will be able to view and edit your calendar ' +
            'once they accept.',
        },
      },
    },
    phrases: ['дай @ivan_petrov право редактировать мой календарь', 'give @ivan_petrov edit access to my calendar'],
    trigger_words: ['дай', 'добавь', 'сделай', 'редактировать', 'редактирования', 'give', 'add', 'make', 'edit'],
    source_message: 'дай @ivan_petrov право редактировать мой календарь',
  },

  // ─── hide_event_from_sharing (visibility: private) ────────────────────────────
  {
    canonical_name: 'hide_event_from_sharing',
    pattern:
      '^(?:скрой\\s+это\\s+событие|спрячь\\s+это\\s+событие|сделай\\s+это\\s+событие\\s+приватным|' +
      'убери\\s+событие\\s+из\\s+общего\\s+доступа|не\\s+показывай\\s+это\\s+событие\\s+остальным|' +
      'hide\\s+this\\s+event(?:\\s+from\\s+sharing)?|make\\s+this\\s+event\\s+private)$',
    workflow: {
      steps: [
        { call: 'set_event_visibility', input: { event_id: '{{last_mentioned_event.id}}', visibility: 'private' } },
        { respond: '{{t.done}}' },
      ],
      i18n: {
        ru: { done: 'Готово — «{{last_mentioned_event.title}}» теперь видно только тебе.' },
        en: { done: 'Done — "{{last_mentioned_event.title}}" is now visible only to you.' },
      },
    },
    phrases: ['скрой это событие', 'сделай это событие приватным', 'hide this event', 'make this event private'],
    trigger_words: ['скрой', 'спрячь', 'приватным', 'доступа', 'остальным', 'hide', 'private', 'event'],
    source_message: 'скрой это событие',
  },

  // ─── show_event_full_details (visibility: full) ───────────────────────────────
  {
    canonical_name: 'show_event_full_details',
    pattern:
      '^(?:покажи\\s+детали\\s+этого\\s+события\\s+всем|сделай\\s+это\\s+событие\\s+видимым\\s+полностью|' +
      'открой\\s+полный\\s+доступ\\s+к\\s+этому\\s+событию|верни\\s+видимость\\s+этого\\s+события|' +
      'show\\s+full\\s+details\\s+for\\s+this\\s+event|make\\s+this\\s+event\\s+fully\\s+visible)$',
    workflow: {
      steps: [
        { call: 'set_event_visibility', input: { event_id: '{{last_mentioned_event.id}}', visibility: 'full' } },
        { respond: '{{t.done}}' },
      ],
      i18n: {
        ru: { done: 'Готово — «{{last_mentioned_event.title}}» снова видно полностью при публикации.' },
        en: { done: 'Done — "{{last_mentioned_event.title}}" is now fully visible when shared.' },
      },
    },
    phrases: [
      'покажи детали этого события всем',
      'сделай это событие видимым полностью',
      'show full details for this event',
      'make this event fully visible',
    ],
    trigger_words: ['покажи', 'детали', 'видимым', 'видимость', 'доступ', 'show', 'details', 'visible', 'fully'],
    source_message: 'покажи детали этого события всем',
  },
];
