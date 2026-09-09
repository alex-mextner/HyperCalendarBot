// scripts/seed-intents-holidays-and-info.ts — Holidays + Bot info/help intents
//
// Deliverable for the intents-expansion project: two small, related categories bundled
// in one file per the assignment (holidays; bot info/help). This file is NOT run
// automatically and does NOT touch the live/dev DB — a separate integration pass
// consolidates every sibling seed-intents-*.ts file, dedupes canonical_names, and
// runs the actual seed against data/calendar.db.
//
// Shape matches scripts/seed-intents.ts's inline SeedIntent shape exactly.

type SeedIntent = {
  canonical_name: string;
  pattern: string | null;
  workflow: object;
  phrases: string[];
  trigger_words: string[];
  source_message: string;
  format?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// Holidays (get_holidays tool)
//
// IMPORTANT DESIGN CONSTRAINT (found and verified while building this file):
// The workflow DSL's ToolInputSchema forces every tool input value to be a
// z.string() at rest (see src/services/intent/workflow-schema.ts), and
// resolveVariables() never produces a genuine number from a literal — only from
// an existing numeric variable namespace (none exist for a fixed constant).
// get_holidays's real schema is `z.object({ limit: z.number().optional() })`
// with NO coercion (src/services/ai/tool-schemas.ts), so a workflow can never
// legally pass a custom `limit` — any attempt ("1", "5", or a raw JSON
// number) either fails WorkflowSchema at match time or fails getHolidaysSchema
// at dispatch time (both verified directly against the real zod schemas; see
// the throwaway validation script used to build this file). Every holiday
// intent below therefore omits `limit` entirely and relies on the tool's own
// default (10 results, ~365-day lookahead) — identical fidelity to what the AI
// agent already produces for these same questions today, so this is not a
// regression, just a documented ceiling. Filed as a deferred finding for the
// DSL (see report).
//
// Because the tool can't be parameterized, all five intents below share the
// exact same workflow and only differ in the phrasings they catch — that is
// the intended effect (maximizing deterministic coverage of how RU/EN users
// actually ask about holidays), not duplication to be collapsed.
// ─────────────────────────────────────────────────────────────────────────────

const getHolidaysWorkflow = {
  tools: [{ name: 'get_holidays', input: {} }],
};

export const holidaysAndInfoIntents: SeedIntent[] = [
  // ─── show_upcoming_holidays ───────────────────────────────────────────────
  {
    canonical_name: 'show_upcoming_holidays',
    pattern: null,
    workflow: getHolidaysWorkflow,
    phrases: [
      'какие праздники',
      'какие праздники скоро',
      'какие у нас праздники',
      'покажи праздники',
      'расскажи про праздники',
      'список праздников',
      'upcoming holidays',
      'show holidays',
      'what holidays are coming',
      'list of holidays',
    ],
    trigger_words: ['праздники', 'праздник', 'holidays', 'holiday'],
    source_message: 'какие праздники скоро',
    format: 'text',
  },

  // ─── show_next_public_holiday ─────────────────────────────────────────────
  {
    canonical_name: 'show_next_public_holiday',
    pattern: null,
    workflow: getHolidaysWorkflow,
    phrases: [
      'ближайший праздник',
      'когда ближайший праздник',
      'следующий праздник',
      'когда следующий праздник',
      'когда будет праздник',
      'next holiday',
      'next public holiday',
      'when is the next holiday',
      'when is the next public holiday',
    ],
    trigger_words: ['ближайший', 'следующий', 'next'],
    source_message: 'когда ближайший праздник',
    format: 'text',
  },

  // ─── is_today_public_holiday ──────────────────────────────────────────────
  {
    canonical_name: 'is_today_public_holiday',
    pattern: null,
    workflow: getHolidaysWorkflow,
    phrases: [
      'сегодня праздник',
      'сегодня есть праздник',
      'сегодня какой праздник',
      'сегодня выходной по календарю',
      'is today a holiday',
      'is today a public holiday',
      'is it a holiday today',
    ],
    trigger_words: ['сегодня', 'today'],
    source_message: 'сегодня праздник?',
    format: 'text',
  },

  // ─── show_holidays_this_month ─────────────────────────────────────────────
  {
    canonical_name: 'show_holidays_this_month',
    pattern: null,
    workflow: getHolidaysWorkflow,
    phrases: [
      'праздники в этом месяце',
      'какие праздники в этом месяце',
      'праздники этого месяца',
      'holidays this month',
      'what holidays are this month',
      'holidays in this month',
    ],
    trigger_words: ['месяце', 'месяц', 'month'],
    source_message: 'какие праздники в этом месяце',
    format: 'text',
  },

  // ─── show_holidays_this_year ──────────────────────────────────────────────
  {
    canonical_name: 'show_holidays_this_year',
    pattern: null,
    workflow: getHolidaysWorkflow,
    phrases: [
      'праздники в этом году',
      'сколько праздников в этом году',
      'все праздники в этом году',
      'holidays this year',
      'how many holidays this year',
      'all holidays this year',
    ],
    trigger_words: ['году', 'год', 'year'],
    source_message: 'праздники в этом году',
    format: 'text',
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Bot info / help
  //
  // get_bot_info's real handler (src/services/ai/tool-handlers/meta.ts) returns
  // a hardcoded ENGLISH-only string — it never reads ctx.user.language. Calling
  // it from a deterministic intent would show English text to Russian-speaking
  // users on a bot whose primary audience is Russian (CLAUDE.md tone-of-voice),
  // which is a real correctness regression versus the bar this project is
  // trying to hit. Filed as a deferred finding (see report) rather than
  // patching tool-handlers/meta.ts, which is out of this task's scope.
  // Instead, every info/help intent below is a pure Level 2 `respond` step —
  // no tool call at all — with hand-written bilingual i18n text, following the
  // same pattern already proven by the approved `change_language_to_russian`
  // intent's trailing `{ respond: '{{t.lang_changed}}' }` step.
  // ─────────────────────────────────────────────────────────────────────────

  // ─── bot_capabilities_overview ────────────────────────────────────────────
  {
    canonical_name: 'bot_capabilities_overview',
    pattern: null,
    workflow: {
      steps: [{ respond: '{{t.overview}}' }],
      i18n: {
        ru: {
          overview: [
            '📅 Показываю и создаю события, ищу свободное время, ставлю напоминания и могу позвонить с голосовым напоминанием.',
            '🎉 Слежу за праздниками по твоей стране.',
            '👥 В группе веду общий календарь и приглашаю участников на встречи.',
            '🎤 Понимаю голосовые сообщения и могу отвечать голосом.',
            '🌍 Умею переключать язык и часовой пояс.',
            'Напиши /help — покажу список команд.',
          ].join('\n'),
        },
        en: {
          overview: [
            '📅 I show and create events, find free time, set reminders, and can call you with a spoken reminder.',
            '🎉 I track holidays for your country.',
            '👥 In a group I keep a shared calendar and invite members to meetings.',
            '🎤 I understand voice messages and can reply with voice.',
            '🌍 I can switch language and timezone.',
            'Type /help to see the command list.',
          ].join('\n'),
        },
      },
    },
    phrases: [
      'что ты умеешь',
      'что ты умеешь делать',
      'что ты можешь',
      'какие у тебя возможности',
      'твои возможности',
      'расскажи что ты умеешь',
      'что ты за бот',
      'what can you do',
      'what do you do',
      'what are your capabilities',
      'what are you capable of',
    ],
    trigger_words: ['умеешь', 'можешь', 'возможности', 'capabilities'],
    source_message: 'что ты умеешь',
    format: 'text',
  },

  // ─── bot_help_commands ────────────────────────────────────────────────────
  {
    canonical_name: 'bot_help_commands',
    pattern: null,
    workflow: {
      steps: [{ respond: '{{t.help}}' }],
      i18n: {
        ru: {
          help: [
            'Напиши /help — покажу полный список команд: просмотр расписания, создание и редактирование событий, настройки, импорт календаря, праздники, Google Calendar.',
            'А если спросишь обычными словами — я тоже пойму, команды необязательны.',
          ].join('\n'),
        },
        en: {
          help: [
            'Type /help for the full command list: schedule views, creating and editing events, settings, calendar import, holidays, Google Calendar.',
            "You can also just ask me in plain words — commands aren't required.",
          ].join('\n'),
        },
      },
    },
    phrases: [
      'помощь',
      'нужна помощь',
      'как пользоваться ботом',
      'список команд',
      'покажи команды',
      'команды бота',
      'help',
      'how do i use this bot',
      'list of commands',
      'show commands',
      'commands',
    ],
    trigger_words: ['помощь', 'команды', 'help', 'commands'],
    source_message: 'помощь',
    format: 'text',
  },

  // ─── bot_hidden_features ──────────────────────────────────────────────────
  {
    canonical_name: 'bot_hidden_features',
    pattern: null,
    workflow: {
      steps: [{ respond: '{{t.hidden}}' }],
      i18n: {
        ru: {
          hidden: [
            '🎤 Отправь голосовое — расшифрую и пойму его как обычный текст.',
            '🔊 Включи голосовые ответы в настройках — удобно за рулём или на кухне.',
            '👥 Добавь меня в группу с друзьями — заведём общий календарь.',
            '🐞 Напиши «нашёл баг» или «хочу предложить функцию» — свяжу тебя с разработчиком.',
            '👨\u200d💻 Разработчик: @mxtnr',
          ].join('\n'),
        },
        en: {
          hidden: [
            "🎤 Send a voice message — I'll transcribe and understand it as text.",
            '🔊 Turn on voice replies in settings — handy while driving or cooking.',
            "👥 Add me to a group with friends — we'll set up a shared calendar.",
            '🐞 Say "found a bug" or "want to suggest a feature" — I\'ll connect you with the developer.',
            '👨\u200d💻 Developer: @mxtnr',
          ].join('\n'),
        },
      },
    },
    phrases: [
      'скрытые функции',
      'какие есть скрытые возможности',
      'необычные функции',
      'секретные функции',
      'что ты умеешь такого о чём я не знаю',
      'hidden features',
      'what hidden features do you have',
      'non-obvious features',
      'secret features',
    ],
    trigger_words: ['скрытые', 'секретные', 'hidden', 'secret'],
    source_message: 'какие есть скрытые возможности',
    format: 'text',
  },

  // ─── bot_developer_contact ────────────────────────────────────────────────
  {
    canonical_name: 'bot_developer_contact',
    pattern: null,
    workflow: {
      steps: [{ respond: '{{t.dev}}' }],
      i18n: {
        ru: {
          dev: 'Разработчик — @mxtnr. Если нашёл баг или хочешь предложить функцию, просто напиши мне об этом — свяжу с ним.',
        },
        en: {
          dev: "The developer is @mxtnr. Found a bug or have a feature idea? Just tell me — I'll connect you.",
        },
      },
    },
    phrases: [
      'кто тебя разработал',
      'кто разработчик',
      'как связаться с разработчиком',
      'чей ты бот',
      'кто твой создатель',
      'who made this bot',
      'who is the developer',
      'how do i contact the developer',
      'who created you',
    ],
    trigger_words: ['разработчик', 'создатель', 'developer'],
    source_message: 'кто разработчик',
    format: 'text',
  },

  // ─── bot_supported_languages ──────────────────────────────────────────────
  {
    canonical_name: 'bot_supported_languages',
    pattern: null,
    workflow: {
      steps: [{ respond: '{{t.langs}}' }],
      i18n: {
        ru: {
          langs:
            'Понимаю русский и английский, отвечаю на том языке, на который ты настроен. Чтобы сменить язык, напиши «переключись на русский» или «switch to english».',
        },
        en: {
          langs:
            'I understand Russian and English and reply in whichever language you\'re set to. To switch, just say "switch to english" or «переключись на русский».',
        },
      },
    },
    phrases: [
      'какие языки ты поддерживаешь',
      'на каких языках ты говоришь',
      'ты понимаешь английский',
      'как сменить язык',
      'what languages do you support',
      'which languages do you speak',
      'do you understand english',
      'how do i change the language',
    ],
    trigger_words: ['языки', 'язык', 'languages', 'language'],
    source_message: 'какие языки ты поддерживаешь',
    format: 'text',
  },
];
