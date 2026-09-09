// scripts/seed-intents-event-deletion.ts — Event deletion & cancellation intents.
// Not a runnable script: exports a SeedIntent[] for the integration task to merge
// into scripts/seed-intents.ts's upsert (matches its inline array element shape).

export interface SeedIntent {
  canonical_name: string;
  pattern: string;
  workflow: object;
  phrases: string[];
  trigger_words: string[];
  source_message: string;
}

export const eventDeletionIntents: SeedIntent[] = [
  // ─── delete_event_by_name ───────────────────────────────────────────────────
  // "удали событие про X" / "cancel the X meeting" — search by title, confirm, delete.
  {
    canonical_name: 'delete_event_by_name',
    pattern:
      '^(?:(?:удали|отмени)\\s+(?:событие|встречу)\\s+(?:про|о)\\s+(.+)|(?:delete|cancel)\\s+(?!(?:my\\s+|the\\s+)?(?:next|last|upcoming|this|that)\\s+(?:meeting|event)$)(?:the\\s+)?(.+?)\\s+(?:meeting|event))$',
    workflow: {
      steps: [
        {
          call: 'search_events',
          input: {
            query: "{{$1|default('')}}{{$2|default('')}}",
            scope: '{{env.scope}}',
          },
          as: 'search_results',
        },
        {
          when: 'search_results.length == 0',
          respond: '{{t.not_found}}',
        },
        {
          when: 'search_results.length > 1',
          respond: '{{t.multiple}}',
        },
        {
          call: 'ask_user',
          input: {
            question: '{{t.confirm}}',
          },
          as: 'confirm|lower',
        },
        {
          when: "ask.confirm != 'да' && ask.confirm != 'yes'",
          respond: '{{t.kept}}',
        },
        {
          when: "ask.confirm == 'да' || ask.confirm == 'yes'",
          call: 'delete_event',
          input: {
            event_id: '{{last_mentioned_event.id}}',
            scope: '{{env.scope}}',
          },
        },
      ],
      i18n: {
        ru: {
          not_found: "Не нашёл событие «{{$1|default('')}}{{$2|default('')}}» — проверь название.",
          multiple: "Нашлось несколько событий «{{$1|default('')}}{{$2|default('')}}» — уточни, какое удалить.",
          confirm: 'Удалить «{{last_mentioned_event.title}}» ({{last_mentioned_event.date}})? Напиши «да» или «нет».',
          kept: 'Хорошо, не удаляю.',
        },
        en: {
          not_found: "Couldn't find an event called «{{$1|default('')}}{{$2|default('')}}» — check the title.",
          multiple:
            "Found several events matching «{{$1|default('')}}{{$2|default('')}}» — tell me which one to delete.",
          confirm: 'Delete «{{last_mentioned_event.title}}» ({{last_mentioned_event.date}})? Reply yes or no.',
          kept: 'OK, not deleting it.',
        },
      },
    },
    phrases: [
      'удали событие про стендап',
      'отмени встречу про стендап',
      'delete the standup meeting',
      'cancel the standup meeting',
    ],
    trigger_words: ['удали', 'отмени', 'delete', 'cancel'],
    source_message: 'удали событие про стендап',
  },

  // ─── delete_next_event ──────────────────────────────────────────────────────
  // "отмени следующую встречу" / "cancel my next event" — nearest upcoming, confirm, delete.
  {
    canonical_name: 'delete_next_event',
    pattern:
      '^(?:отмени|удали|cancel|delete)\\s+(?:мою\\s+|my\\s+|the\\s+)?(?:следующ(?:ую|ее)|ближайш(?:ую|ее)|next|upcoming)\\s+(?:встречу|событие|meeting|event)$',
    workflow: {
      steps: [
        {
          call: 'get_upcoming',
          input: {
            limit: '1',
            scope: '{{env.scope}}',
          },
          as: 'upcoming',
        },
        {
          when: 'upcoming.length == 0',
          respond: '{{t.no_upcoming}}',
        },
        {
          call: 'ask_user',
          input: {
            question: '{{t.confirm}}',
          },
          as: 'confirm|lower',
        },
        {
          when: "ask.confirm != 'да' && ask.confirm != 'yes'",
          respond: '{{t.kept}}',
        },
        {
          when: "ask.confirm == 'да' || ask.confirm == 'yes'",
          call: 'delete_event',
          input: {
            event_id: '{{last_mentioned_event.id}}',
            scope: '{{env.scope}}',
          },
        },
      ],
      i18n: {
        ru: {
          no_upcoming: 'Ближайших событий не нашёл — впереди пусто.',
          confirm:
            "Удалить «{{last_mentioned_event.title}}» ({{last_mentioned_event.date}} {{last_mentioned_event.time|default('')}})? Напиши «да» или «нет».",
          kept: 'Хорошо, не удаляю.',
        },
        en: {
          no_upcoming: "Couldn't find an upcoming event — nothing ahead.",
          confirm:
            "Delete «{{last_mentioned_event.title}}» ({{last_mentioned_event.date}} {{last_mentioned_event.time|default('')}})? Reply yes or no.",
          kept: 'OK, not deleting it.',
        },
      },
    },
    phrases: ['отмени следующую встречу', 'удали ближайшее событие', 'cancel my next event', 'delete the next meeting'],
    trigger_words: ['следующую', 'следующее', 'ближайшую', 'ближайшее', 'next', 'upcoming'],
    source_message: 'отмени следующую встречу',
  },

  // ─── clear_today_events ─────────────────────────────────────────────────────
  // "очисти сегодняшний день" / "clear my day" — confirm once, then delete every
  // event left on today's calendar. No loop primitive exists in the workflow DSL,
  // so this unrolls a fixed 8-iteration re-fetch-and-delete-first sequence: each
  // get_events call re-reads today's (now-shorter) list and last_mentioned_event
  // is always its first item, so deleting it repeatedly drains the day up to the
  // cap. A day with more than 8 events reports how many remain and asks the user
  // to repeat the command instead of silently leaving events undeleted.
  {
    canonical_name: 'clear_today_events',
    pattern:
      '^(?:(?:очисти|расчисти)\\s+(?:сегодняшний\\s+день|сегодня)|(?:удали|отмени)\\s+все\\s+событи[яй]\\s+сегодня|clear\\s+(?:my\\s+)?(?:day|today)|(?:delete|cancel)\\s+all\\s+events?\\s+today)$',
    workflow: {
      steps: [
        {
          call: 'get_events',
          input: {
            start_date: '{{dates.today}}',
            end_date: '{{dates.today}}',
            scope: '{{env.scope}}',
          },
          as: 'day_events',
        },
        {
          when: 'day_events.length == 0',
          respond: '{{t.already_clear}}',
        },
        {
          call: 'ask_user',
          input: {
            question: '{{t.confirm_clear}}',
          },
          as: 'confirm|lower',
        },
        {
          when: "ask.confirm != 'да' && ask.confirm != 'yes'",
          respond: '{{t.kept}}',
        },
        {
          call: 'get_events',
          input: {
            start_date: '{{dates.today}}',
            end_date: '{{dates.today}}',
            scope: '{{env.scope}}',
          },
          as: 'day_events',
        },
        {
          when: 'day_events.length > 0',
          call: 'delete_event',
          input: {
            event_id: '{{last_mentioned_event.id}}',
            scope: '{{env.scope}}',
          },
        },
        {
          call: 'get_events',
          input: {
            start_date: '{{dates.today}}',
            end_date: '{{dates.today}}',
            scope: '{{env.scope}}',
          },
          as: 'day_events',
        },
        {
          when: 'day_events.length > 0',
          call: 'delete_event',
          input: {
            event_id: '{{last_mentioned_event.id}}',
            scope: '{{env.scope}}',
          },
        },
        {
          call: 'get_events',
          input: {
            start_date: '{{dates.today}}',
            end_date: '{{dates.today}}',
            scope: '{{env.scope}}',
          },
          as: 'day_events',
        },
        {
          when: 'day_events.length > 0',
          call: 'delete_event',
          input: {
            event_id: '{{last_mentioned_event.id}}',
            scope: '{{env.scope}}',
          },
        },
        {
          call: 'get_events',
          input: {
            start_date: '{{dates.today}}',
            end_date: '{{dates.today}}',
            scope: '{{env.scope}}',
          },
          as: 'day_events',
        },
        {
          when: 'day_events.length > 0',
          call: 'delete_event',
          input: {
            event_id: '{{last_mentioned_event.id}}',
            scope: '{{env.scope}}',
          },
        },
        {
          call: 'get_events',
          input: {
            start_date: '{{dates.today}}',
            end_date: '{{dates.today}}',
            scope: '{{env.scope}}',
          },
          as: 'day_events',
        },
        {
          when: 'day_events.length > 0',
          call: 'delete_event',
          input: {
            event_id: '{{last_mentioned_event.id}}',
            scope: '{{env.scope}}',
          },
        },
        {
          call: 'get_events',
          input: {
            start_date: '{{dates.today}}',
            end_date: '{{dates.today}}',
            scope: '{{env.scope}}',
          },
          as: 'day_events',
        },
        {
          when: 'day_events.length > 0',
          call: 'delete_event',
          input: {
            event_id: '{{last_mentioned_event.id}}',
            scope: '{{env.scope}}',
          },
        },
        {
          call: 'get_events',
          input: {
            start_date: '{{dates.today}}',
            end_date: '{{dates.today}}',
            scope: '{{env.scope}}',
          },
          as: 'day_events',
        },
        {
          when: 'day_events.length > 0',
          call: 'delete_event',
          input: {
            event_id: '{{last_mentioned_event.id}}',
            scope: '{{env.scope}}',
          },
        },
        {
          call: 'get_events',
          input: {
            start_date: '{{dates.today}}',
            end_date: '{{dates.today}}',
            scope: '{{env.scope}}',
          },
          as: 'day_events',
        },
        {
          when: 'day_events.length > 0',
          call: 'delete_event',
          input: {
            event_id: '{{last_mentioned_event.id}}',
            scope: '{{env.scope}}',
          },
        },
        {
          call: 'get_events',
          input: {
            start_date: '{{dates.today}}',
            end_date: '{{dates.today}}',
            scope: '{{env.scope}}',
          },
          as: 'day_events',
        },
        {
          when: 'day_events.length == 0',
          respond: '{{t.cleared}}',
        },
        {
          when: 'day_events.length > 0',
          respond: '{{t.partial}}',
        },
      ],
      i18n: {
        ru: {
          already_clear: 'На сегодня событий нет — очищать нечего.',
          confirm_clear: 'Удалить все события сегодня ({{tool_outputs.day_events.length}})? Напиши «да» или «нет».',
          kept: 'Хорошо, ничего не удаляю.',
          cleared: 'Готово, день очищен.',
          partial:
            'Удалил часть событий, но на сегодня ещё осталось {{tool_outputs.day_events.length}} — повтори команду, чтобы очистить остальное.',
        },
        en: {
          already_clear: "Your day's already clear — nothing to delete.",
          confirm_clear: 'Delete all {{tool_outputs.day_events.length}} events today? Reply yes or no.',
          kept: 'OK, keeping everything.',
          cleared: 'Done — your day is cleared.',
          partial: '{{tool_outputs.day_events.length}} events still remain today — run it again to clear the rest.',
        },
      },
    },
    phrases: ['очисти сегодняшний день', 'очисти сегодня', 'clear my day', 'clear today', 'delete all events today'],
    trigger_words: ['очисти', 'расчисти', 'clear', 'сегодня', 'today', 'день'],
    source_message: 'очисти сегодняшний день',
  },

  // ─── cancel_event_by_time_today ─────────────────────────────────────────────
  // "отмени встречу в 15:00" / "cancel the meeting at 15:00" — exact minute lookup.
  {
    canonical_name: 'cancel_event_by_time_today',
    pattern:
      '^(?:отмени|удали|cancel|delete)\\s+(?:встречу|событие|the\\s+meeting|the\\s+event|meeting|event)\\s+(?:в|at)\\s+(\\d{1,2})\\s+(\\d{2})$',
    workflow: {
      steps: [
        {
          call: 'get_events',
          input: {
            start_date: '{{dates.today}}T{{$1|pad(2)}}:{{$2}}:00{{user.utc_offset}}',
            end_date: '{{dates.today}}T{{$1|pad(2)}}:{{$2}}:59{{user.utc_offset}}',
            scope: '{{env.scope}}',
          },
          as: 'slot_events',
        },
        {
          when: 'slot_events.length == 0',
          respond: '{{t.not_found}}',
        },
        {
          when: 'slot_events.length > 1',
          respond: '{{t.multiple}}',
        },
        {
          call: 'ask_user',
          input: {
            question: '{{t.confirm}}',
          },
          as: 'confirm|lower',
        },
        {
          when: "ask.confirm != 'да' && ask.confirm != 'yes'",
          respond: '{{t.kept}}',
        },
        {
          when: "ask.confirm == 'да' || ask.confirm == 'yes'",
          call: 'delete_event',
          input: {
            event_id: '{{last_mentioned_event.id}}',
            scope: '{{env.scope}}',
          },
        },
      ],
      i18n: {
        ru: {
          not_found: 'В {{$1}}:{{$2}} сегодня событий нет.',
          multiple: 'В {{$1}}:{{$2}} сегодня несколько событий — уточни, какое удалить.',
          confirm: 'Удалить «{{last_mentioned_event.title}}» в {{$1}}:{{$2}}? Напиши «да» или «нет».',
          kept: 'Хорошо, не удаляю.',
        },
        en: {
          not_found: 'No event found at {{$1}}:{{$2}} today.',
          multiple: 'Several events found at {{$1}}:{{$2}} today — tell me which one to delete.',
          confirm: 'Delete «{{last_mentioned_event.title}}» at {{$1}}:{{$2}}? Reply yes or no.',
          kept: 'OK, not deleting it.',
        },
      },
    },
    phrases: [
      'отмени встречу в 15:00',
      'удали событие в 15:00',
      'cancel the meeting at 15:00',
      'delete the event at 15:00',
    ],
    trigger_words: ['отмени', 'удали', 'cancel', 'delete'],
    source_message: 'отмени встречу в 15:00',
  },

  // ─── cancel_event_by_time_tomorrow ──────────────────────────────────────────
  // "отмени встречу завтра в 15:00" / "cancel the meeting tomorrow at 15:00".
  {
    canonical_name: 'cancel_event_by_time_tomorrow',
    pattern:
      '^(?:отмени|удали|cancel|delete)\\s+(?:встречу|событие|the\\s+meeting|the\\s+event|meeting|event)\\s+(?:завтра\\s+в|tomorrow\\s+at)\\s+(\\d{1,2})\\s+(\\d{2})$',
    workflow: {
      steps: [
        {
          call: 'get_events',
          input: {
            start_date: '{{dates.tomorrow}}T{{$1|pad(2)}}:{{$2}}:00{{user.utc_offset}}',
            end_date: '{{dates.tomorrow}}T{{$1|pad(2)}}:{{$2}}:59{{user.utc_offset}}',
            scope: '{{env.scope}}',
          },
          as: 'slot_events',
        },
        {
          when: 'slot_events.length == 0',
          respond: '{{t.not_found}}',
        },
        {
          when: 'slot_events.length > 1',
          respond: '{{t.multiple}}',
        },
        {
          call: 'ask_user',
          input: {
            question: '{{t.confirm}}',
          },
          as: 'confirm|lower',
        },
        {
          when: "ask.confirm != 'да' && ask.confirm != 'yes'",
          respond: '{{t.kept}}',
        },
        {
          when: "ask.confirm == 'да' || ask.confirm == 'yes'",
          call: 'delete_event',
          input: {
            event_id: '{{last_mentioned_event.id}}',
            scope: '{{env.scope}}',
          },
        },
      ],
      i18n: {
        ru: {
          not_found: 'Завтра в {{$1}}:{{$2}} событий нет.',
          multiple: 'Завтра в {{$1}}:{{$2}} несколько событий — уточни, какое удалить.',
          confirm: 'Удалить «{{last_mentioned_event.title}}» завтра в {{$1}}:{{$2}}? Напиши «да» или «нет».',
          kept: 'Хорошо, не удаляю.',
        },
        en: {
          not_found: 'No event found tomorrow at {{$1}}:{{$2}}.',
          multiple: 'Several events found tomorrow at {{$1}}:{{$2}} — tell me which one to delete.',
          confirm: 'Delete «{{last_mentioned_event.title}}» tomorrow at {{$1}}:{{$2}}? Reply yes or no.',
          kept: 'OK, not deleting it.',
        },
      },
    },
    phrases: [
      'отмени встречу завтра в 15:00',
      'удали событие завтра в 15:00',
      'cancel the meeting tomorrow at 15:00',
      'delete the event tomorrow at 15:00',
    ],
    trigger_words: ['завтра', 'tomorrow'],
    source_message: 'отмени встречу завтра в 15:00',
  },

  // ─── delete_last_created_event ──────────────────────────────────────────────
  // "удали последнее событие" / "undo last event" — uses last_added_event, no search.
  {
    canonical_name: 'delete_last_created_event',
    pattern:
      '^(?:удали|отмени|delete|cancel|undo)\\s+(?:последнее\\s+событие|то\\s+что\\s+я\\s+создал|the\\s+last\\s+event|last\\s+event|my\\s+last\\s+event)$',
    workflow: {
      steps: [
        {
          call: 'ask_user',
          input: {
            question: '{{t.confirm}}',
          },
          as: 'confirm|lower',
        },
        {
          when: "ask.confirm != 'да' && ask.confirm != 'yes'",
          respond: '{{t.kept}}',
        },
        {
          when: "ask.confirm == 'да' || ask.confirm == 'yes'",
          call: 'delete_event',
          input: {
            event_id: '{{last_added_event.id}}',
            scope: '{{env.scope}}',
          },
        },
      ],
      i18n: {
        ru: {
          confirm:
            "Удалить последнее созданное событие «{{last_added_event.title|default('это событие')}}»? Напиши «да» или «нет».",
          kept: 'Хорошо, не удаляю.',
        },
        en: {
          confirm:
            "Delete the last event you created, «{{last_added_event.title|default('this event')}}»? Reply yes or no.",
          kept: 'OK, not deleting it.',
        },
      },
    },
    phrases: ['удали последнее событие', 'отмени последнее событие', 'delete the last event', 'undo last event'],
    trigger_words: ['последнее', 'last', 'undo'],
    source_message: 'удали последнее событие',
  },

  // ─── cancel_referenced_event ────────────────────────────────────────────────
  // "удали это событие" / "delete it" — the event last shown/discussed in this chat.
  {
    canonical_name: 'cancel_referenced_event',
    pattern:
      '^(?:удали|отмени|delete|cancel)\\s+(?:это\\s+событие|эту\\s+встречу|this\\s+event|that\\s+event|the\\s+event|it)$',
    workflow: {
      steps: [
        {
          call: 'ask_user',
          input: {
            question: '{{t.confirm}}',
          },
          as: 'confirm|lower',
        },
        {
          when: "ask.confirm != 'да' && ask.confirm != 'yes'",
          respond: '{{t.kept}}',
        },
        {
          when: "ask.confirm == 'да' || ask.confirm == 'yes'",
          call: 'delete_event',
          input: {
            event_id: '{{last_mentioned_event.id}}',
            scope: '{{env.scope}}',
          },
        },
      ],
      i18n: {
        ru: {
          confirm: "Удалить «{{last_mentioned_event.title|default('это событие')}}»? Напиши «да» или «нет».",
          kept: 'Хорошо, не удаляю.',
        },
        en: {
          confirm: "Delete «{{last_mentioned_event.title|default('this event')}}»? Reply yes or no.",
          kept: 'OK, not deleting it.',
        },
      },
    },
    phrases: [
      'удали это событие',
      'отмени эту встречу',
      'delete this event',
      'cancel that event',
      'delete it',
      'cancel it',
    ],
    trigger_words: ['это', 'эту', 'this', 'that', 'it'],
    source_message: 'удали это событие',
  },

  // ─── decline_event_invitation ───────────────────────────────────────────────
  // "откажись от встречи про X" / "decline the X meeting" — same search+confirm+delete
  // flow as delete_event_by_name, but for the decline-family verbs. delete_event itself
  // already declines instead of deleting when the caller is a participant, not the
  // creator (see tools.ts), so no separate decline tool call is needed.
  {
    canonical_name: 'decline_event_invitation',
    pattern:
      '^(?:(?:откажись|отклони)\\s+(?:от\\s+)?(?:встречи|встречу|приглашение|приглашени[яе]|событи[яе])\\s+(?:про|о|на)\\s+(.+)|decline\\s+(?:the\\s+)?(.+?)\\s+(?:meeting|event|invitation))$',
    workflow: {
      steps: [
        {
          call: 'search_events',
          input: {
            query: "{{$1|default('')}}{{$2|default('')}}",
            scope: '{{env.scope}}',
          },
          as: 'search_results',
        },
        {
          when: 'search_results.length == 0',
          respond: '{{t.not_found}}',
        },
        {
          when: 'search_results.length > 1',
          respond: '{{t.multiple}}',
        },
        {
          call: 'ask_user',
          input: {
            question: '{{t.confirm}}',
          },
          as: 'confirm|lower',
        },
        {
          when: "ask.confirm != 'да' && ask.confirm != 'yes'",
          respond: '{{t.kept}}',
        },
        {
          when: "ask.confirm == 'да' || ask.confirm == 'yes'",
          call: 'delete_event',
          input: {
            event_id: '{{last_mentioned_event.id}}',
            scope: '{{env.scope}}',
          },
        },
      ],
      i18n: {
        ru: {
          not_found: "Не нашёл встречу «{{$1|default('')}}{{$2|default('')}}» — проверь название.",
          multiple: "Нашлось несколько встреч «{{$1|default('')}}{{$2|default('')}}» — уточни, какую отклонить.",
          confirm:
            'Отклонить приглашение на «{{last_mentioned_event.title}}» ({{last_mentioned_event.date}})? Напиши «да» или «нет».',
          kept: 'Хорошо, оставляю как есть.',
        },
        en: {
          not_found: "Couldn't find a meeting called «{{$1|default('')}}{{$2|default('')}}» — check the title.",
          multiple:
            "Found several meetings matching «{{$1|default('')}}{{$2|default('')}}» — tell me which one to decline.",
          confirm:
            'Decline the invitation to «{{last_mentioned_event.title}}» ({{last_mentioned_event.date}})? Reply yes or no.',
          kept: 'OK, leaving it as is.',
        },
      },
    },
    phrases: [
      'откажись от встречи про стендап',
      'отклони приглашение про стендап',
      'decline the standup meeting',
      'decline the invitation',
    ],
    trigger_words: ['откажись', 'отклони', 'decline'],
    source_message: 'откажись от встречи про стендап',
  },
];
