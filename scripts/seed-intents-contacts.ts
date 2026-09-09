// scripts/seed-intents-contacts.ts -- contacts/address-book intents (category: contacts)
//
// NOT run automatically -- a separate integration task consolidates every
// scripts/seed-intents-<category>.ts file, dedupes canonical_names, and runs
// the real seed against data/calendar.db. Do not import bun:sqlite here.
//
// Tool coverage (src/services/ai/tools.ts): get_contacts, add_contact, find_contact,
// update_contact. There is NO tool for attaching freeform notes/context to a contact --
// Contact only has name/preferred_name/username/telegram_id fields (see
// src/database/types.ts Contact interface and every contacts.ts handler). "Add context
// about a contact" from the assignment is therefore NOT implemented as an intent -- see
// the report handed back to the orchestrator for the explicit callout instead of
// inventing a fake mapping onto update_contact.
//
// Privacy: get_contacts's own tool description flags it as "PRIVATE DATA" that must not
// be dumped in a group without explicit confirmation. list_contacts is the only intent
// here that returns the entire address book, so it is the only one gated behind a
// when: "group.is_group == true" guard that answers with a redirect-to-DM message
// instead of ever calling the tool in a group. find_contact/add_contact/update_contact
// operate on a single named person (not a bulk dump) and carry no such warning on the
// tool itself, so they are left ungated, consistent with how the AI agent already uses
// them from groups.
//
// phrases vs pattern: IntentMatcher.match() checks the exact-phrase map BEFORE the regex
// and returns an empty captures object on a hit (src/services/intent/intent-matcher.ts).
// Every parameterized intent below (whose workflow reads {{$1}}/{{$2}}) therefore uses
// phrases: [] -- an example phrase that also happens to be a literal instance of the
// pattern would exact-match with no captures, leaving the unresolved "{{$1}}" template
// string to leak straight into the tool call (e.g. add_contact would save a contact
// literally named "{{$1}}"). Confirmed by reproducing the match against a live
// IntentMatcher instance. Only list_contacts (no captures) keeps its phrases list.

export interface SeedIntent {
  canonical_name: string;
  pattern: string | null;
  workflow: object;
  phrases: string[];
  trigger_words: string[];
  source_message: string;
  format?: string;
}

export const contactsIntents: SeedIntent[] = [
  {
    canonical_name: 'list_contacts',
    pattern:
      '^(?:покажи\\s+(?:мои\\s+)?контакты|мои\\s+контакты|список\\s+контактов|show\\s+(?:my\\s+)?contacts|list\\s+(?:my\\s+)?contacts|my\\s+contacts|address\\s+book)\\??$',
    workflow: {
      steps: [
        {
          when: 'group.is_group == true',
          respond: '{{t.group_blocked}}',
        },
        {
          call: 'get_contacts',
          input: {},
        },
      ],
      i18n: {
        ru: {
          group_blocked: 'Личные контакты покажу только в личке — напиши мне туда.',
        },
        en: {
          group_blocked: "I'll only show your personal contacts in a private chat — message me there.",
        },
      },
    },
    phrases: [
      'покажи мои контакты',
      'мои контакты',
      'список контактов',
      'show my contacts',
      'list my contacts',
      'my contacts',
    ],
    trigger_words: ['контакты', 'контакт', 'contacts', 'contact'],
    source_message: 'покажи мои контакты',
    format: 'text',
  },
  {
    canonical_name: 'find_contact_by_name',
    pattern: '^(?:(?:найди|найти|поищи)\\s+контакт[а-я]*|find\\s+contact|search\\s+(?:for\\s+)?contact)\\s+(.+)$',
    workflow: {
      tools: [
        {
          name: 'find_contact',
          input: {
            name: '{{$1}}',
          },
        },
      ],
    },
    phrases: [],
    trigger_words: ['найди', 'найти', 'поищи', 'контакт', 'find', 'search', 'contact'],
    source_message: 'найди контакт Иван',
    format: 'text',
  },
  {
    canonical_name: 'who_is_contact',
    pattern: '^(?:кто\\s+так(?:ой|ая)|кто\\s+это|who\\s+is)\\s+(.+)$',
    workflow: {
      tools: [
        {
          name: 'find_contact',
          input: {
            name: '{{$1}}',
          },
        },
      ],
    },
    phrases: [],
    trigger_words: ['кто', 'who'],
    source_message: 'кто такой Иван',
    format: 'text',
  },
  {
    canonical_name: 'add_contact_to_book',
    pattern: '^(?:(?:добавь|добавить|сохрани|сохранить)\\s+контакт[а-я]*|(?:add|save)\\s+contact)\\s+(.+)$',
    workflow: {
      tools: [
        {
          name: 'add_contact',
          input: {
            name: '{{$1}}',
            preferred_name: '{{$1}}',
          },
        },
      ],
    },
    phrases: [],
    trigger_words: ['добавь', 'добавить', 'сохрани', 'сохранить', 'add', 'save', 'контакт', 'contact'],
    source_message: 'добавь контакт Иван',
    format: 'text',
  },
  {
    canonical_name: 'rename_contact',
    pattern: '^(?:переименуй\\s+контакт|rename\\s+contact)\\s+(.+?)\\s+(?:в|to)\\s+(.+)$',
    workflow: {
      tools: [
        {
          name: 'update_contact',
          input: {
            search: '{{$1}}',
            preferred_name: '{{$2}}',
          },
        },
      ],
    },
    phrases: [],
    trigger_words: ['переименуй', 'rename', 'контакт', 'contact'],
    source_message: 'переименуй контакт Иван в Ваня',
    format: 'text',
  },
];
