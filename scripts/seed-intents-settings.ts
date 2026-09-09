// scripts/seed-intents-settings.ts — settings-management intents for HyperCalendarBot
// Run: NOT run by this file. A separate integration pass consolidates every
// scripts/seed-intents-<category>.ts file, dedupes canonical_name, and runs the real seed
// against data/calendar.db (see scripts/seed-intents.ts for the upsert shape this mirrors).
//
// Scope: everything a user can toggle in manage_settings beyond timezone/language (already
// covered by set_timezone_belgrade / change_language_to_russian) — notification preferences,
// quiet hours, default event duration, voice responses, a full settings summary, and a reset
// to defaults. Every workflow below calls the real "manage_settings" tool (src/services/ai/tools.ts)
// with a category and field names read directly off src/services/ai/tool-handlers/settings.ts —
// nothing here was guessed.
//
// Explicitly NOT implemented: "default calendar view" and "date format preference" — the
// original brief asked for both, but manage_settings has no such category or field (categories
// are general/notifications/calls/privacy/voice/assistant; see ManageSettingsInput in
// tool-handlers/settings.ts). Inventing a fake setting would produce an intent that always
// fails at runtime, so these two were dropped rather than faked.

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface SeedIntent {
  canonical_name: string;
  pattern: string;
  workflow: { [key: string]: JsonValue };
  phrases: string[];
  trigger_words: string[];
  source_message: string;
}

export const settingsIntents: SeedIntent[] = [
  // ─── view_settings_summary ───────────────────────────────────────────────────────
  {
    canonical_name: 'view_settings_summary',
    pattern:
      '^(?:покажи\\s+(?:мои\\s+)?настройки|как(?:ие|ая)\\s+у\\s+меня\\s+настройки|мои\\s+настройки|текущие\\s+настройки|настройки|show\\s+(?:my\\s+)?settings|what\\s+are\\s+my\\s+settings|current\\s+settings)$',
    workflow: {
      steps: [
        {
          call: 'manage_settings',
          input: {
            action: 'get',
            category: 'general',
          },
          as: 'general',
        },
        {
          call: 'manage_settings',
          input: {
            action: 'get',
            category: 'notifications',
          },
          as: 'notif',
        },
        {
          call: 'manage_settings',
          input: {
            action: 'get',
            category: 'privacy',
          },
          as: 'priv',
        },
        {
          call: 'manage_settings',
          input: {
            action: 'get',
            category: 'voice',
          },
          as: 'voice',
        },
        {
          respond: '{{t.summary}}',
        },
      ],
      i18n: {
        ru: {
          summary:
            '⚙️ Твои настройки:\n🌍 Часовой пояс: {{tool_outputs.general.timezone}}\n🗣 Язык: {{tool_outputs.general.language}}\n⏱ Длительность события по умолчанию: {{tool_outputs.general.default_event_duration_minutes}} мин\n🌅 Утренняя сводка: {{tool_outputs.notif.morning_agenda_enabled|ternary("включена","выключена")}} ({{tool_outputs.notif.morning_agenda_time}})\n🌆 Вечерний обзор: {{tool_outputs.notif.evening_review_enabled|ternary("включён","выключен")}} ({{tool_outputs.notif.evening_review_time}})\n🔕 Тихие часы: {{tool_outputs.notif.quiet_hours_enabled|ternary("включены","выключены")}} ({{tool_outputs.notif.quiet_hours_start|default("—")}}–{{tool_outputs.notif.quiet_hours_end|default("—")}})\n🔒 Видимость событий: {{tool_outputs.priv.default_visibility}}\n✉️ Приглашения: {{tool_outputs.priv.allow_invitations|ternary("разрешены","запрещены")}}\n🔊 Голосовые ответы: {{tool_outputs.voice.voice_response_enabled|ternary("включены","выключены")}}',
        },
        en: {
          summary:
            '⚙️ Your settings:\n🌍 Timezone: {{tool_outputs.general.timezone}}\n🗣 Language: {{tool_outputs.general.language}}\n⏱ Default event duration: {{tool_outputs.general.default_event_duration_minutes}} min\n🌅 Morning agenda: {{tool_outputs.notif.morning_agenda_enabled|ternary("on","off")}} ({{tool_outputs.notif.morning_agenda_time}})\n🌆 Evening review: {{tool_outputs.notif.evening_review_enabled|ternary("on","off")}} ({{tool_outputs.notif.evening_review_time}})\n🔕 Quiet hours: {{tool_outputs.notif.quiet_hours_enabled|ternary("on","off")}} ({{tool_outputs.notif.quiet_hours_start|default("—")}}–{{tool_outputs.notif.quiet_hours_end|default("—")}})\n🔒 Event visibility: {{tool_outputs.priv.default_visibility}}\n✉️ Invitations: {{tool_outputs.priv.allow_invitations|ternary("allowed","blocked")}}\n🔊 Voice responses: {{tool_outputs.voice.voice_response_enabled|ternary("on","off")}}',
        },
      },
    },
    phrases: [
      'покажи мои настройки',
      'какие у меня настройки',
      'мои настройки',
      'текущие настройки',
      'show my settings',
      'show settings',
      'what are my settings',
      'current settings',
    ],
    trigger_words: ['настройки', 'settings'],
    source_message: 'покажи мои настройки',
  },

  // ─── enable_morning_agenda ───────────────────────────────────────────────────────
  {
    canonical_name: 'enable_morning_agenda',
    pattern:
      '^(?:включи\\s+утренн(?:юю|ие)\\s+(?:сводку|уведомлени[яе])|хочу\\s+утреннюю\\s+сводку|начни\\s+присылать\\s+утреннюю\\s+сводку|enable\\s+morning\\s+(?:agenda|summary)|turn\\s+on\\s+morning\\s+(?:agenda|summary))$',
    workflow: {
      steps: [
        {
          call: 'manage_settings',
          input: {
            action: 'update',
            category: 'notifications',
            updates: {
              morning_agenda_enabled: true,
            },
          },
        },
        {
          respond: '{{t.done}}',
        },
      ],
      i18n: {
        ru: {
          done: 'Утренняя сводка включена — буду присылать её каждый день.',
        },
        en: {
          done: "Morning agenda enabled — I'll send it every day.",
        },
      },
    },
    phrases: [
      'включи утреннюю сводку',
      'включи утренние уведомления',
      'хочу утреннюю сводку',
      'начни присылать утреннюю сводку',
      'enable morning agenda',
      'turn on morning summary',
      'turn on morning agenda',
    ],
    trigger_words: ['утреннюю', 'утренние', 'morning'],
    source_message: 'включи утреннюю сводку',
  },

  // ─── disable_morning_agenda ──────────────────────────────────────────────────────
  {
    canonical_name: 'disable_morning_agenda',
    pattern:
      '^(?:выключи\\s+утреннюю\\s+сводку|отключи\\s+утренн(?:ие|юю)\\s+(?:уведомлени[яе]|сводку)|не\\s+присылай\\s+утреннюю\\s+сводку|убери\\s+утреннюю\\s+сводку|disable\\s+morning\\s+(?:agenda|summary)|turn\\s+off\\s+morning\\s+(?:agenda|summary))$',
    workflow: {
      steps: [
        {
          call: 'manage_settings',
          input: {
            action: 'update',
            category: 'notifications',
            updates: {
              morning_agenda_enabled: false,
            },
          },
        },
        {
          respond: '{{t.done}}',
        },
      ],
      i18n: {
        ru: {
          done: 'Утренняя сводка выключена.',
        },
        en: {
          done: 'Morning agenda disabled.',
        },
      },
    },
    phrases: [
      'выключи утреннюю сводку',
      'отключи утренние уведомления',
      'не присылай утреннюю сводку',
      'убери утреннюю сводку',
      'disable morning agenda',
      'turn off morning summary',
      'turn off morning agenda',
    ],
    trigger_words: ['утреннюю', 'утренние', 'morning'],
    source_message: 'выключи утреннюю сводку',
  },

  // ─── enable_evening_review ───────────────────────────────────────────────────────
  {
    canonical_name: 'enable_evening_review',
    pattern:
      '^(?:включи\\s+вечерн(?:ий|юю)\\s+(?:обзор|сводку)|хочу\\s+вечерн(?:ий\\s+обзор|юю\\s+сводку)|enable\\s+evening\\s+review|turn\\s+on\\s+evening\\s+(?:review|summary))$',
    workflow: {
      steps: [
        {
          call: 'manage_settings',
          input: {
            action: 'update',
            category: 'notifications',
            updates: {
              evening_review_enabled: true,
            },
          },
        },
        {
          respond: '{{t.done}}',
        },
      ],
      i18n: {
        ru: {
          done: 'Вечерний обзор включён — буду присылать его каждый день.',
        },
        en: {
          done: "Evening review enabled — I'll send it every day.",
        },
      },
    },
    phrases: [
      'включи вечерний обзор',
      'включи вечернюю сводку',
      'хочу вечерний обзор',
      'хочу вечернюю сводку',
      'enable evening review',
      'turn on evening review',
      'turn on evening summary',
    ],
    trigger_words: ['вечерний', 'вечернюю', 'evening'],
    source_message: 'включи вечерний обзор',
  },

  // ─── disable_evening_review ──────────────────────────────────────────────────────
  {
    canonical_name: 'disable_evening_review',
    pattern:
      '^(?:выключи\\s+вечерн(?:ий|юю)\\s+(?:обзор|сводку)|отключи\\s+вечерн(?:ий\\s+обзор|юю\\s+сводку)|не\\s+присылай\\s+вечерний\\s+обзор|disable\\s+evening\\s+review|turn\\s+off\\s+evening\\s+(?:review|summary))$',
    workflow: {
      steps: [
        {
          call: 'manage_settings',
          input: {
            action: 'update',
            category: 'notifications',
            updates: {
              evening_review_enabled: false,
            },
          },
        },
        {
          respond: '{{t.done}}',
        },
      ],
      i18n: {
        ru: {
          done: 'Вечерний обзор выключен.',
        },
        en: {
          done: 'Evening review disabled.',
        },
      },
    },
    phrases: [
      'выключи вечерний обзор',
      'отключи вечернюю сводку',
      'не присылай вечерний обзор',
      'disable evening review',
      'turn off evening review',
      'turn off evening summary',
    ],
    trigger_words: ['вечерний', 'вечернюю', 'evening'],
    source_message: 'выключи вечерний обзор',
  },

  // ─── set_quiet_hours_night ───────────────────────────────────────────────────────
  {
    canonical_name: 'set_quiet_hours_night',
    pattern:
      '^(?:не\\s+беспокой\\s+меня\\s+ночью|включи\\s+тихие\\s+часы|тихий\\s+режим\\s+ночью|не\\s+пиши\\s+мне\\s+ночью|enable\\s+quiet\\s+hours|turn\\s+on\\s+quiet\\s+hours|enable\\s+do\\s+not\\s+disturb|turn\\s+on\\s+do\\s+not\\s+disturb)$',
    workflow: {
      steps: [
        {
          call: 'manage_settings',
          input: {
            action: 'update',
            category: 'notifications',
            updates: {
              quiet_hours_enabled: true,
              quiet_hours_start: '22:00',
              quiet_hours_end: '08:00',
            },
          },
        },
        {
          respond: '{{t.done}}',
        },
      ],
      i18n: {
        ru: {
          done: 'Тихие часы включены: с 22:00 до 08:00 не буду присылать уведомления.',
        },
        en: {
          done: "Quiet hours enabled: 22:00–08:00, I won't send notifications then.",
        },
      },
    },
    phrases: [
      'не беспокой меня ночью',
      'включи тихие часы',
      'тихий режим ночью',
      'не пиши мне ночью',
      'enable quiet hours',
      'turn on quiet hours',
      'enable do not disturb',
      'turn on do not disturb',
    ],
    trigger_words: ['тихие', 'ночью', 'quiet'],
    source_message: 'не беспокой меня ночью',
  },

  // ─── disable_quiet_hours ─────────────────────────────────────────────────────────
  {
    canonical_name: 'disable_quiet_hours',
    pattern:
      '^(?:выключи\\s+тихие\\s+часы|отключи\\s+тихий\\s+режим|можешь\\s+писать\\s+мне\\s+ночью|disable\\s+quiet\\s+hours|turn\\s+off\\s+quiet\\s+hours|turn\\s+off\\s+do\\s+not\\s+disturb)$',
    workflow: {
      steps: [
        {
          call: 'manage_settings',
          input: {
            action: 'update',
            category: 'notifications',
            updates: {
              quiet_hours_enabled: false,
            },
          },
        },
        {
          respond: '{{t.done}}',
        },
      ],
      i18n: {
        ru: {
          done: 'Тихие часы выключены.',
        },
        en: {
          done: 'Quiet hours disabled.',
        },
      },
    },
    phrases: [
      'выключи тихие часы',
      'отключи тихий режим',
      'можешь писать мне ночью',
      'disable quiet hours',
      'turn off quiet hours',
      'turn off do not disturb',
    ],
    trigger_words: ['тихие', 'quiet'],
    source_message: 'выключи тихие часы',
  },

  // ─── set_default_duration_15 ─────────────────────────────────────────────────────
  {
    canonical_name: 'set_default_duration_15',
    pattern:
      '^(?:поставь\\s+длительность\\s+событ(?:ия|ие)\\s+по\\s+умолчанию\\s+15\\s+минут|сделай\\s+стандартную\\s+длительность\\s+встречи\\s+15\\s+минут|событие\\s+по\\s+умолчанию\\s+15\\s+минут|set\\s+default\\s+event\\s+duration\\s+to\\s+15\\s+minutes|make\\s+default\\s+meeting\\s+length\\s+15\\s+minutes)$',
    workflow: {
      steps: [
        {
          call: 'manage_settings',
          input: {
            action: 'update',
            category: 'general',
            updates: {
              default_event_duration_minutes: 15,
            },
          },
        },
        {
          respond: '{{t.done}}',
        },
      ],
      i18n: {
        ru: {
          done: 'Стандартная длительность события — 15 минут.',
        },
        en: {
          done: 'Default event duration set to 15 minutes.',
        },
      },
    },
    phrases: [
      'поставь длительность события по умолчанию 15 минут',
      'сделай стандартную длительность встречи 15 минут',
      'событие по умолчанию 15 минут',
      'set default event duration to 15 minutes',
      'make default meeting length 15 minutes',
    ],
    trigger_words: ['длительность', '15', 'duration'],
    source_message: 'поставь длительность события по умолчанию 15 минут',
  },

  // ─── set_default_duration_30 ─────────────────────────────────────────────────────
  {
    canonical_name: 'set_default_duration_30',
    pattern:
      '^(?:поставь\\s+длительность\\s+событ(?:ия|ие)\\s+по\\s+умолчанию\\s+30\\s+минут|сделай\\s+стандартную\\s+длительность\\s+встречи\\s+30\\s+минут|событие\\s+по\\s+умолчанию\\s+30\\s+минут|set\\s+default\\s+event\\s+duration\\s+to\\s+30\\s+minutes|make\\s+default\\s+meeting\\s+length\\s+30\\s+minutes)$',
    workflow: {
      steps: [
        {
          call: 'manage_settings',
          input: {
            action: 'update',
            category: 'general',
            updates: {
              default_event_duration_minutes: 30,
            },
          },
        },
        {
          respond: '{{t.done}}',
        },
      ],
      i18n: {
        ru: {
          done: 'Стандартная длительность события — 30 минут.',
        },
        en: {
          done: 'Default event duration set to 30 minutes.',
        },
      },
    },
    phrases: [
      'поставь длительность события по умолчанию 30 минут',
      'сделай стандартную длительность встречи 30 минут',
      'событие по умолчанию 30 минут',
      'set default event duration to 30 minutes',
      'make default meeting length 30 minutes',
    ],
    trigger_words: ['длительность', '30', 'duration'],
    source_message: 'поставь длительность события по умолчанию 30 минут',
  },

  // ─── enable_voice_responses ──────────────────────────────────────────────────────
  {
    canonical_name: 'enable_voice_responses',
    pattern:
      '^(?:включи\\s+голосовые\\s+ответы|отвечай\\s+мне\\s+голосом|хочу\\s+голосовые\\s+ответы|enable\\s+voice\\s+responses|turn\\s+on\\s+voice\\s+repl(?:y|ies)|reply\\s+with\\s+voice)$',
    workflow: {
      steps: [
        {
          call: 'manage_settings',
          input: {
            action: 'update',
            category: 'voice',
            updates: {
              voice_response_enabled: true,
            },
          },
        },
        {
          respond: '{{t.done}}',
        },
      ],
      i18n: {
        ru: {
          done: 'Голосовые ответы включены.',
        },
        en: {
          done: 'Voice responses enabled.',
        },
      },
    },
    phrases: [
      'включи голосовые ответы',
      'отвечай мне голосом',
      'хочу голосовые ответы',
      'enable voice responses',
      'turn on voice replies',
      'reply with voice',
    ],
    trigger_words: ['голосовые', 'голосом', 'voice'],
    source_message: 'включи голосовые ответы',
  },

  // ─── disable_voice_responses ─────────────────────────────────────────────────────
  {
    canonical_name: 'disable_voice_responses',
    pattern:
      '^(?:выключи\\s+голосовые\\s+ответы|не\\s+отвечай\\s+голосом|отключи\\s+голосовые\\s+ответы|disable\\s+voice\\s+responses|turn\\s+off\\s+voice\\s+repl(?:y|ies)|stop\\s+replying\\s+with\\s+voice)$',
    workflow: {
      steps: [
        {
          call: 'manage_settings',
          input: {
            action: 'update',
            category: 'voice',
            updates: {
              voice_response_enabled: false,
            },
          },
        },
        {
          respond: '{{t.done}}',
        },
      ],
      i18n: {
        ru: {
          done: 'Голосовые ответы выключены.',
        },
        en: {
          done: 'Voice responses disabled.',
        },
      },
    },
    phrases: [
      'выключи голосовые ответы',
      'не отвечай голосом',
      'отключи голосовые ответы',
      'disable voice responses',
      'turn off voice replies',
      'stop replying with voice',
    ],
    trigger_words: ['голосовые', 'голосом', 'voice'],
    source_message: 'выключи голосовые ответы',
  },

  // ─── reset_settings_to_default ───────────────────────────────────────────────────
  {
    canonical_name: 'reset_settings_to_default',
    pattern:
      '^(?:сбрось\\s+настройки(?:\\s+до\\s+умолчания)?|верни\\s+настройки\\s+по\\s+умолчанию|сбросить\\s+настройки(?:\\s+уведомлений)?|reset\\s+(?:my\\s+)?settings(?:\\s+to\\s+default)?|restore\\s+default\\s+settings)$',
    workflow: {
      steps: [
        {
          call: 'manage_settings',
          input: {
            action: 'update',
            category: 'notifications',
            updates: {
              morning_agenda_enabled: true,
              morning_agenda_time: '08:00',
              evening_review_enabled: false,
              evening_review_time: '21:00',
              quiet_hours_enabled: false,
              quiet_hours_start: null,
              quiet_hours_end: null,
              default_reminder_minutes: [30, 0],
            },
          },
        },
        {
          call: 'manage_settings',
          input: {
            action: 'update',
            category: 'privacy',
            updates: {
              default_visibility: 'private',
              inline_mode_enabled: true,
              allow_invitations: true,
            },
          },
        },
        {
          call: 'manage_settings',
          input: {
            action: 'update',
            category: 'general',
            updates: {
              default_event_duration_minutes: 60,
            },
          },
        },
        {
          call: 'manage_settings',
          input: {
            action: 'update',
            category: 'voice',
            updates: {
              voice_response_enabled: null,
            },
          },
        },
        {
          call: 'manage_settings',
          input: {
            action: 'update',
            category: 'calls',
            updates: {
              enabled: false,
              language: 'en',
            },
          },
        },
        {
          respond: '{{t.done}}',
        },
      ],
      i18n: {
        ru: {
          done: 'Настройки уведомлений, приватности, звонков и голосовых ответов сброшены к значениям по умолчанию.',
        },
        en: {
          done: 'Notification, privacy, call, and voice settings have been reset to their defaults.',
        },
      },
    },
    phrases: [
      'сбрось настройки',
      'сбрось настройки до умолчания',
      'верни настройки по умолчанию',
      'сбросить настройки уведомлений',
      'reset settings to default',
      'reset my settings',
      'restore default settings',
    ],
    trigger_words: ['сбрось', 'сбросить', 'настройки', 'reset', 'default'],
    source_message: 'сбрось настройки',
  },
];
