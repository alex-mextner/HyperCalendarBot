> Part 3 of 3 of [Birthday Events Implementation Plan](../2026-03-20-birthdays.md) — previous: [02-tasks-5-6.md](02-tasks-5-6.md)

## Task 7: `/birthdays` Command

**Files:**
- Create: `src/bot/commands/birthdays.ts`
- Modify: `src/bot/index.ts`
- Create: `test/bot/commands/birthdays.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// test/bot/commands/birthdays.test.ts
import { test, expect } from 'bun:test';
import { formatBirthdayLine } from '../../../src/bot/commands/birthdays.ts';

test('RU: uses tg link when celebrant_id known, strips Д/р prefix', () => {
  const line = formatBirthdayLine({ title: 'Д/р Иван', celebrantId: 12345, birthYear: 1996, username: null, eventDate: new Date('2026-05-10T00:00:00Z'), lang: 'ru' });
  expect(line).toContain('[Иван](tg://user?id=12345)');
  expect(line).toContain('30 лет');
  expect(line).not.toContain('Д/р');
  expect(line).toContain('🎁');
});

test('RU: age 31 uses correct plural "год"', () => {
  const line = formatBirthdayLine({ title: 'Д/р Иван', celebrantId: 12345, birthYear: 1995, username: null, eventDate: new Date('2026-05-10T00:00:00Z'), lang: 'ru' });
  expect(line).toContain('31 год');
});

test('RU: age 22 uses correct plural "года"', () => {
  const line = formatBirthdayLine({ title: 'Д/р Иван', celebrantId: 12345, birthYear: 2004, username: null, eventDate: new Date('2026-05-10T00:00:00Z'), lang: 'ru' });
  expect(line).toContain('22 года');
});

test('RU: uses @username when no celebrant_id', () => {
  const line = formatBirthdayLine({ title: 'Д/р Маша', celebrantId: null, birthYear: null, username: 'masha_k', eventDate: new Date('2026-06-22T00:00:00Z'), lang: 'ru' });
  expect(line).toContain('@masha_k');
  expect(line).toContain('Маша');
  expect(line).not.toContain('Д/р');
});

test('EN: strips Bday prefix, uses tg link', () => {
  const line = formatBirthdayLine({ title: 'Bday Ivan', celebrantId: 42, birthYear: 2001, username: null, eventDate: new Date('2026-05-10T00:00:00Z'), lang: 'en' });
  expect(line).toContain('[Ivan](tg://user?id=42)');
  expect(line).toContain('turns 25');
  expect(line).not.toContain('Bday');
});

test('plain name when no id or username', () => {
  const line = formatBirthdayLine({ title: 'Bday Pete', celebrantId: null, birthYear: null, username: null, eventDate: new Date('2026-09-07T00:00:00Z'), lang: 'en' });
  expect(line).toContain('Pete');
  expect(line).not.toContain('Bday');
  expect(line).toContain('🎁');
});
```

- [ ] **Step 2: Run to verify failure**

```bash
bun test test/bot/commands/birthdays.test.ts
```

- [ ] **Step 3: Create `src/bot/commands/birthdays.ts`**

```ts
import { ruPlural } from '../../services/event/formatters.ts';
import type { BirthdayService } from '../../services/birthday/birthday-service.ts';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { User } from '../../database/types.ts';
import type { BotCommandContext } from '../types.ts';
import { getGroupId, isGroup } from '../group-context.ts';

export interface FormatBirthdayLineParams {
  title: string;
  celebrantId: number | null;
  birthYear: number | null;
  username: string | null;
  eventDate: Date;
  lang: 'en' | 'ru';
}

function extractName(title: string): string {
  return title.replace(/^(Д\/р |Bday )/, '').trim();
}

function formatDate(date: Date, lang: 'en' | 'ru'): string {
  return date.toLocaleDateString(lang === 'ru' ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'short' });
}

export function formatBirthdayLine(params: FormatBirthdayLineParams): string {
  const { title, celebrantId, birthYear, username, eventDate, lang } = params;
  const name = extractName(title);
  const age = birthYear ? eventDate.getFullYear() - birthYear : null;
  const ageSuffix = age
    ? lang === 'ru'
      ? ` — ${age} ${ruPlural(age, 'год', 'года', 'лет')}`
      : ` — turns ${age}`
    : '';
  const dateStr = formatDate(eventDate, lang);

  let nameStr: string;
  if (celebrantId !== null) {
    nameStr = `[${name}](tg://user?id=${celebrantId})`;
  } else if (username) {
    nameStr = `${name} @${username}`;
  } else {
    nameStr = name;
  }

  return `🎁 ${nameStr}${ageSuffix} (${dateStr})`;
}

export async function handleBirthdays(
  ctx: BotCommandContext,
  birthdayService: BirthdayService,
  groupChatRepo?: GroupChatRepository,
): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';

  let groupCalendars: { groupId: number; title: string }[] = [];
  if (isGroup(ctx)) {
    const groupId = getGroupId(ctx);
    if (groupId === null) return;
    const group = groupChatRepo?.findByChatId(groupId);
    groupCalendars = group ? [{ groupId, title: group.title ?? String(groupId) }] : [];
  }

  const { personal, groups } = birthdayService.getBirthdaysForDisplay(user.telegram_id, lang, groupCalendars);

  if (personal.length === 0 && groups.every((g) => g.items.length === 0)) {
    await ctx.send(lang === 'ru' ? 'Дней рождения пока нет 🎂' : 'No birthdays yet 🎂');
    return;
  }

  const lines: string[] = [lang === 'ru' ? '🎂 *Дни рождения*' : '🎂 *Birthdays*', ''];

  if (personal.length > 0) {
    lines.push(lang === 'ru' ? '👤 *Личный календарь*' : '👤 *Personal calendar*');
    for (const item of personal) {
      const eventDate = new Date(item.event.start_at);
      lines.push('• ' + formatBirthdayLine({ title: item.event.title, celebrantId: item.celebrantId, birthYear: item.birthYear, username: item.username, eventDate, lang }));
    }
  }

  for (const group of groups) {
    if (group.items.length === 0) continue;
    lines.push('');
    lines.push(`👥 *${group.title}*`);
    for (const item of group.items) {
      const eventDate = new Date(item.event.start_at);
      lines.push('• ' + formatBirthdayLine({ title: item.event.title, celebrantId: item.celebrantId, birthYear: item.birthYear, username: item.username, eventDate, lang }));
    }
  }

  await ctx.send(lines.join('\n'), { parse_mode: 'Markdown' });
}
```

- [ ] **Step 4: Register in `src/bot/index.ts`**

```ts
import { handleBirthdays } from './commands/birthdays.ts';
// In command chain:
.command('birthdays', (ctx) =>
  handleBirthdays(ctx as unknown as BotCommandContext, birthdayService, db.groupChats)
)
```

- [ ] **Step 5: Run tests**

```bash
bun test test/bot/commands/birthdays.test.ts
```

- [ ] **Step 6: Full suite**

```bash
bun test
```

- [ ] **Step 7: Commit**

```bash
git add src/bot/commands/birthdays.ts src/bot/index.ts test/bot/commands/birthdays.test.ts
git commit -m "feat(bot): /birthdays command with grouped display, tg links, ruPlural age"
```

---

## Task 8: AI Tools + Constants

**Files:**
- Modify: `src/config/constants.ts`
- Modify: `src/services/ai/tools.ts`
- Create: `src/services/ai/tool-handlers/birthdays.ts`
- Modify: `src/services/ai/tool-executor.ts`
- Modify: `src/services/ai/tool-handlers/events.ts`
- Modify: `src/services/ai/types.ts`
- Create: `test/services/ai/tool-handlers/birthdays.test.ts`

- [ ] **Step 1: Add strings to `src/config/constants.ts`**

In `MSG.ru.aiTools`, add:
```ts
birthdays: {
  created: (name: string, day: number, month: number) =>
    `День рождения создан: Д/р ${name} (${day}.${String(month).padStart(2, '0')})`,
  alreadyExists: (name: string, day: number, month: number) =>
    `День рождения ${name} уже есть: ${day}.${String(month).padStart(2, '0')}`,
  conflictError: (name: string, day: number, month: number) =>
    `Уже есть день рождения для ${name}: дата ${day}.${String(month).padStart(2, '0')}. Хочешь обновить?`,
},
```

In `MSG.en.aiTools`, add:
```ts
birthdays: {
  created: (name: string, day: number, month: number) =>
    `Birthday created: Bday ${name} (${day}.${String(month).padStart(2, '0')})`,
  alreadyExists: (name: string, day: number, month: number) =>
    `Birthday for ${name} already exists: ${day}.${String(month).padStart(2, '0')}`,
  conflictError: (name: string, day: number, month: number) =>
    `Birthday for ${name} already exists on ${day}.${String(month).padStart(2, '0')}. To update, call again with the correct date.`,
},
```

- [ ] **Step 2: Write failing tests**

```ts
// test/services/ai/tool-handlers/birthdays.test.ts
import { test, expect, beforeEach } from 'bun:test';
import Database from 'bun:sqlite';
import { runMigrations } from '../../../../src/database/migrations.ts';
import { EventRepository } from '../../../../src/database/repositories/event.repository.ts';
import { BirthdayMetadataRepository } from '../../../../src/database/repositories/birthday-metadata.repository.ts';
import { EventReminderRepository } from '../../../../src/database/repositories/event-reminder.repository.ts';
import { NotificationPreferencesRepository } from '../../../../src/database/repositories/notification-preferences.repository.ts';
import { BirthdayService } from '../../../../src/services/birthday/birthday-service.ts';
import { handleCreateBirthdayEvent } from '../../../../src/services/ai/tool-handlers/birthdays.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';

let db: Database;
let birthdayService: BirthdayService;
let ctx: Partial<AgentContext>;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare("INSERT INTO users (telegram_id, first_name, language, timezone) VALUES (1, 'Alice', 'ru', 'UTC')").run();
  db.prepare("INSERT INTO users (telegram_id, first_name, username, language, timezone) VALUES (42, 'Ivan', 'ivan_t', 'ru', 'UTC')").run();

  birthdayService = new BirthdayService(
    new EventRepository(db),
    new BirthdayMetadataRepository(db),
    new EventReminderRepository(db),
    new NotificationPreferencesRepository(db),
  );

  ctx = {
    user: { telegram_id: 1, language: 'ru', timezone: 'UTC', first_name: 'Alice' } as any,
    birthdayService,
    userRepo: { findByTelegramId: (id: number) => db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(id) } as any,
  };
});

test('creates birthday event successfully', () => {
  const result = handleCreateBirthdayEvent(ctx as AgentContext, { celebrant_id: 42, date: { day: 10, month: 5 }, year: 1996 });
  expect(result.success).toBe(true);
  expect(result.output).toContain('Ivan');
  const events = db.prepare("SELECT * FROM events WHERE event_type = 'birthday'").all();
  expect(events.length).toBe(1);
});

test('returns error when date conflicts in personal calendar', () => {
  handleCreateBirthdayEvent(ctx as AgentContext, { celebrant_id: 42, date: { day: 10, month: 5 } });
  const result = handleCreateBirthdayEvent(ctx as AgentContext, { celebrant_id: 42, date: { day: 11, month: 5 } });
  expect(result.success).toBe(false);
  expect(result.error).toBeTruthy();
});

test('no-ops and reports existing when same date', () => {
  handleCreateBirthdayEvent(ctx as AgentContext, { celebrant_id: 42, date: { day: 10, month: 5 } });
  const result = handleCreateBirthdayEvent(ctx as AgentContext, { celebrant_id: 42, date: { day: 10, month: 5 } });
  expect(result.success).toBe(true);
  const events = db.prepare("SELECT * FROM events WHERE event_type = 'birthday'").all();
  expect(events.length).toBe(1); // no duplicate
});

test('uses custom_name when provided', () => {
  const result = handleCreateBirthdayEvent(ctx as AgentContext, { celebrant_id: 42, date: { day: 10, month: 5 }, custom_name: 'Ваня' });
  expect(result.success).toBe(true);
  const event = db.prepare("SELECT title FROM events WHERE event_type = 'birthday'").get() as { title: string };
  expect(event.title).toBe('Д/р Ваня');
});
```

- [ ] **Step 3: Run to verify failure**

```bash
bun test test/services/ai/tool-handlers/birthdays.test.ts
```

- [ ] **Step 4: Create `src/services/ai/tool-handlers/birthdays.ts`**

```ts
import type { AgentContext, ToolResult } from '../types.ts';
import { t } from '../../../config/constants.ts';

interface CreateBirthdayInput {
  celebrant_id: number;
  date: { day: number; month: number };
  year?: number;
  custom_name?: string;
  group_id?: number;
}

export function handleCreateBirthdayEvent(ctx: AgentContext, input: CreateBirthdayInput): ToolResult {
  if (!ctx.birthdayService) return { success: false, error: 'Birthday service unavailable' };

  const lang = ctx.user.language as 'en' | 'ru';

  // Resolve name
  let celebrantName = input.custom_name;
  if (!celebrantName) {
    const dbUser = ctx.userRepo?.findByTelegramId(input.celebrant_id);
    celebrantName = dbUser?.first_name ?? String(input.celebrant_id);
  }

  // Dedup check — personal calendar only
  if (!input.group_id) {
    const existing = ctx.birthdayService.findExistingBirthday(input.celebrant_id, ctx.user.telegram_id);
    if (existing) {
      const existingDate = new Date(existing.start_at);
      const existingDay = existingDate.getUTCDate();
      const existingMonth = existingDate.getUTCMonth() + 1;

      if (existingDay === input.date.day && existingMonth === input.date.month) {
        return {
          success: true,
          output: t(lang).aiTools.birthdays.alreadyExists(celebrantName, existingDay, existingMonth),
        };
      }

      return {
        success: false,
        error: t(lang).aiTools.birthdays.conflictError(celebrantName, existingDay, existingMonth),
      };
    }
  }

  ctx.birthdayService.upsertBirthdayEvent({
    ownerId: ctx.user.telegram_id,
    celebrantId: input.celebrant_id,
    celebrantName,
    day: input.date.day,
    month: input.date.month,
    year: input.year ?? null,
    lang,
    timezone: ctx.user.timezone,
    autoCreated: false,
    groupId: input.group_id,
  });

  return {
    success: true,
    output: t(lang).aiTools.birthdays.created(celebrantName, input.date.day, input.date.month),
  };
}
```

- [ ] **Step 5: Add `birthdayService` to `AgentContext` in `src/services/ai/types.ts`**

```ts
import type { BirthdayService } from '../birthday/birthday-service.ts';
// In AgentContext interface:
birthdayService?: BirthdayService;
```

Wire in `src/bot/index.ts` when building agent context.

- [ ] **Step 6: Add tool definitions to `src/services/ai/tools.ts`**

After `search_events`, add `create_birthday_event`:

```ts
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
```

In `search_events`, add optional `event_type` property and make `query` optional:

```ts
// In search_events.input_schema.properties add:
event_type: {
  type: 'string',
  enum: ['birthday', 'regular'],
  description: "Filter by event type. Use 'birthday' to list all birthday events.",
},
// Change required from ['query'] to []:
required: [],
```

- [ ] **Step 7: Route `create_birthday_event` in `src/services/ai/tool-executor.ts`**

Add import at top of file:
```ts
import { handleCreateBirthdayEvent } from './tool-handlers/birthdays.ts';
```

Inside the `switch (toolName)` block (same pattern as all other tools):
```ts
case 'create_birthday_event':
  return handleCreateBirthdayEvent(ctx, input as { celebrant_id: number; date: { day: number; month: number }; year?: number; custom_name?: string; group_id?: number });
```

- [ ] **Step 8: Update `handleSearchEvents` in `src/services/ai/tool-handlers/events.ts`**

Update `SearchEventsInput` interface — make `query` optional and add `event_type`:
```ts
interface SearchEventsInput {
  query?: string;           // was required string
  scope?: 'personal' | 'group';
  owner_id?: number;
  event_type?: 'birthday' | 'regular';
}
```

Replace the search calls (both personal and group scopes):
```ts
// Personal scope (old):
ctx.eventService.searchEvents(userId, input.query)
// Personal scope (new):
ctx.eventService.searchWithEventType(userId, input.query ?? null, input.event_type ?? null)

// Group scope (old):
ctx.eventService.searchEventsForGroup(ctx.groupChatId!, input.query)
// Group scope (new):
ctx.eventService.searchEventsForGroup(ctx.groupChatId!, input.query ?? '')
```

- [ ] **Step 9: Run tests**

```bash
bun test test/services/ai/tool-handlers/birthdays.test.ts
```

- [ ] **Step 10: Full suite + lint**

```bash
bun test
bun run lint
```

- [ ] **Step 11: Commit**

```bash
git add src/config/constants.ts src/services/ai/tools.ts \
  src/services/ai/tool-handlers/birthdays.ts src/services/ai/tool-executor.ts \
  src/services/ai/tool-handlers/events.ts src/services/ai/types.ts \
  test/services/ai/tool-handlers/birthdays.test.ts
git commit -m "feat(ai): create_birthday_event tool + event_type filter in search_events"
```

---

## Task 9: Final Validation

- [ ] **Run full test suite with coverage**

```bash
bun test --coverage
```
Expected: all tests pass, coverage ≥ 80%

- [ ] **Run linter — zero warnings**

```bash
bun run lint
```

- [ ] **Fix any lint issues and commit**

```bash
# Stage only modified files (bun run lint:fix reports which files changed)
bun run lint:fix
git add src/ scripts/ test/
git commit -m "fix(birthday): lint fixes"
```
