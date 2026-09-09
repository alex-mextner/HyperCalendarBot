// scripts/seed-intents-google-calendar.ts — Google Calendar connection/status intents.
//
// Design notes (read before editing):
// - `get_google_calendar_status` ALWAYS returns `success: true`, with an output string that
//   already branches on connection state ("Google Calendar подключён. Calendars: N total, M
//   syncing. ..." vs "Google Calendar не подключён. Ты можешь подключить его командой
//   /connect_google."). That built-in branching is what makes it safe to use in a Level1/Level2
//   workflow: a Level1/Level2 step that returns `success: false` aborts the whole intent and
//   falls through to the AI agent (see intent-matcher-layer.ts step 6) AND fires an admin
//   "intent failed" alert on every single occurrence — the opposite of graceful degradation.
// - `list_google_calendars` returns `success: false` with a hard error when Google Calendar is
//   not connected (src/services/ai/tool-handlers/meta.ts `handleListGoogleCalendars`). There is
//   no `when`/try-catch primitive in the workflow DSL to catch a step failure and route around
//   it — a failed step always aborts the intent. So `list_google_calendars` cannot degrade
//   gracefully in any workflow shape and is deliberately NOT used below. `get_google_calendar_status`
//   already renders the full calendar list (with sync checkmarks) when connected, so it fully
//   covers "list my calendars" too — that's what real graceful degradation looks like here.
// - Disconnecting/reconnecting has no AI tool at all (only the interactive `/disconnect_google`
//   and `/connect_google` bot commands with confirmation keyboards) — those intents are
//   respond-only workflows pointing the user at the right command.
//
// Run (integration task only, not this file): bun scripts/seed-intents-google-calendar.ts

export interface SeedIntent {
  canonical_name: string;
  pattern: string;
  workflow: object;
  phrases: string[];
  trigger_words: string[];
  source_message: string;
}

export const googleCalendarIntents: SeedIntent[] = [
  // ─── google_calendar_connection_status ───────────────────────────────────────
  {
    canonical_name: 'google_calendar_connection_status',
    pattern:
      '^(?:подключен\\s+ли\\s+(?:у\\s+меня\\s+)?(?:мой\\s+)?(?:google|гугл)\\s*(?:calendar|календарь)?|(?:google|гугл)\\s*(?:calendar|календарь)\\s+подключ(?:ен|ена|ено)|у\\s+меня\\s+подключен\\s+(?:google|гугл)\\s*(?:calendar|календарь)?|is\\s+(?:my\\s+)?google\\s+calendar\\s+connected|google\\s+calendar\\s+connection\\s+status)$',
    workflow: {
      tools: [{ name: 'get_google_calendar_status', input: {} }],
    },
    phrases: [
      'подключен ли google календарь',
      'подключен ли гугл календарь',
      'гугл календарь подключен',
      'google календарь подключен',
      'у меня подключен google календарь',
      'is google calendar connected',
      'is my google calendar connected',
      'google calendar connection status',
    ],
    trigger_words: ['подключен', 'google', 'гугл', 'connected'],
    source_message: 'подключен ли google календарь',
  },

  // ─── google_calendar_list ─────────────────────────────────────────────────────
  {
    canonical_name: 'google_calendar_list',
    pattern:
      '^(?:покажи\\s+(?:мои\\s+)?(?:google|гугл)\\s*календар(?:и|ей)|какие\\s+у\\s+меня\\s+(?:google|гугл)\\s*календар(?:и|ей)|список\\s+(?:google|гугл)\\s*календарей|мои\\s+(?:google|гугл)\\s*календари|(?:list|show)\\s+my\\s+google\\s+calendars|what\\s+google\\s+calendars\\s+do\\s+i\\s+have)$',
    workflow: {
      tools: [{ name: 'get_google_calendar_status', input: {} }],
    },
    phrases: [
      'покажи мои google календари',
      'покажи мои гугл календари',
      'какие у меня google календари',
      'список google календарей',
      'мои google календари',
      'list my google calendars',
      'show my google calendars',
      'what google calendars do i have',
    ],
    trigger_words: ['календари', 'calendars', 'google', 'гугл'],
    source_message: 'покажи мои google календари',
  },

  // ─── google_calendar_connect_howto ────────────────────────────────────────────
  {
    canonical_name: 'google_calendar_connect_howto',
    pattern:
      '^(?:как\\s+подключить\\s+(?:google|гугл)\\s*(?:calendar|календарь)?|хочу\\s+подключить\\s+(?:google|гугл)\\s*(?:calendar|календарь)?|подключи\\s+(?:мой\\s+)?(?:google|гугл)\\s*(?:calendar|календарь)?|how\\s+(?:do\\s+i|to)\\s+connect\\s+google\\s+calendar|connect\\s+google\\s+calendar)$',
    workflow: {
      tools: [{ name: 'get_google_calendar_status', input: {} }],
    },
    phrases: [
      'как подключить google calendar',
      'как подключить гугл календарь',
      'хочу подключить google calendar',
      'подключи google calendar',
      'подключи гугл календарь',
      'how do i connect google calendar',
      'how to connect google calendar',
      'connect google calendar',
    ],
    trigger_words: ['подключить', 'подключи', 'connect', 'google', 'гугл'],
    source_message: 'как подключить google calendar',
  },

  // ─── google_calendar_disconnect ───────────────────────────────────────────────
  {
    canonical_name: 'google_calendar_disconnect',
    pattern:
      '^(?:отключи\\s+(?:мой\\s+)?(?:google|гугл)\\s*(?:calendar|календарь)?|как\\s+отключить\\s+(?:google|гугл)\\s*(?:calendar|календарь)?|хочу\\s+отключить\\s+(?:google|гугл)\\s*(?:calendar|календарь)?|disconnect\\s+(?:my\\s+)?google\\s+calendar|how\\s+do\\s+i\\s+disconnect\\s+google\\s+calendar|turn\\s+off\\s+google\\s+calendar\\s+sync)$',
    workflow: {
      steps: [{ respond: '{{t.msg}}' }],
      i18n: {
        ru: {
          msg: 'Чтобы отключить Google Calendar, используй команду /disconnect_google — я покажу подтверждение перед отключением. Твои локальные события останутся в боте.',
        },
        en: {
          msg: "To disconnect Google Calendar, use the /disconnect_google command — I'll show a confirmation before disconnecting. Your local events will stay in the bot.",
        },
      },
    },
    phrases: [
      'отключи google calendar',
      'отключи гугл календарь',
      'как отключить google calendar',
      'хочу отключить google календарь',
      'disconnect google calendar',
      'how do i disconnect google calendar',
      'turn off google calendar sync',
    ],
    trigger_words: ['отключи', 'отключить', 'disconnect', 'google', 'гугл'],
    source_message: 'отключи google calendar',
  },

  // ─── google_calendar_sync_status ──────────────────────────────────────────────
  {
    canonical_name: 'google_calendar_sync_status',
    pattern:
      '^(?:синхронизируется\\s+ли\\s+(?:google|гугл)\\s*(?:calendar|календарь)?|статус\\s+синхронизации\\s+(?:google|гугл)\\s*(?:calendar|календаря)?|(?:google|гугл)\\s*(?:calendar|календарь)\\s+не\\s+синхронизируется|события\\s+не\\s+синхронизируются\\s+с\\s+(?:google|гугл)|is\\s+google\\s+calendar\\s+syncing|google\\s+calendar\\s+sync\\s+status|google\\s+calendar\\s+not\\s+syncing|events\\s+not\\s+syncing\\s+with\\s+google\\s+calendar)$',
    workflow: {
      steps: [
        { call: 'get_google_calendar_status', input: {}, as: 'gcal_status' },
        { respond: '{{tool_outputs.gcal_status}}\n\n{{t.hint}}' },
      ],
      i18n: {
        ru: {
          hint: 'Если календарь не обновляется, открой /google_status — там можно нажать «🔄 Синхронизировать» и посмотреть, когда каждый календарь обновлялся в последний раз.',
        },
        en: {
          hint: 'If a calendar isn\'t updating, open /google_status — you can tap "🔄 Sync now" there and see when each calendar last updated.',
        },
      },
    },
    phrases: [
      'синхронизируется ли google calendar',
      'статус синхронизации google calendar',
      'google calendar не синхронизируется',
      'события не синхронизируются с google',
      'is google calendar syncing',
      'google calendar sync status',
      'google calendar not syncing',
      'events not syncing with google calendar',
    ],
    trigger_words: ['синхронизируется', 'синхронизации', 'sync', 'syncing', 'google', 'гугл'],
    source_message: 'синхронизируется ли google calendar',
  },

  // ─── google_calendar_reconnect ────────────────────────────────────────────────
  {
    canonical_name: 'google_calendar_reconnect',
    pattern:
      '^(?:переподключи\\s+(?:мой\\s+)?(?:google|гугл)\\s*(?:calendar|календарь)?|как\\s+переподключить\\s+(?:google|гугл)\\s*(?:calendar|календарь)?|хочу\\s+переподключить\\s+(?:google|гугл)\\s*(?:calendar|календарь)?|подключить\\s+заново\\s+(?:google|гугл)\\s*(?:calendar|календарь)?|reconnect\\s+(?:my\\s+)?google\\s+calendar|how\\s+do\\s+i\\s+reconnect\\s+google\\s+calendar)$',
    workflow: {
      steps: [{ respond: '{{t.msg}}' }],
      i18n: {
        ru: {
          msg: 'Чтобы переподключить Google Calendar: если он сейчас подключён — сначала /disconnect_google, потом /connect_google. Если ещё не подключён — сразу используй /connect_google.',
        },
        en: {
          msg: "To reconnect Google Calendar: if it's currently connected, run /disconnect_google first, then /connect_google. If it isn't connected yet, just use /connect_google.",
        },
      },
    },
    phrases: [
      'переподключи google calendar',
      'как переподключить google calendar',
      'хочу переподключить гугл календарь',
      'подключить заново google calendar',
      'reconnect google calendar',
      'how do i reconnect google calendar',
      'reconnect my google calendar',
    ],
    trigger_words: ['переподключи', 'переподключить', 'reconnect', 'google', 'гугл'],
    source_message: 'переподключи google calendar',
  },
];
