# Group Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adapt all bot commands to work with the group calendar in group chats, remove deprecated commands (/agenda, /unshare, /timezone), and store group timezone/country in group_chats.

**Architecture:** Each command detects group context via `ctx.chat.type`. In groups, commands operate on `owner_type='group'` events via existing `EventRepository` and `EventService` group methods. Group settings (timezone, country) stored in new columns in `group_chats`. If group has no timezone, bot prompts on first calendar use.

**Tech Stack:** TypeScript, Bun, bun:sqlite, GramIO

---

## Existing group infrastructure (already implemented — do not re-implement)

The following is already done and must be reused:

- `EventRepository`: `findByIdInGroup`, `getByDateRangeForGroup`, `searchForGroup`, `getUpcomingForGroup(groupId, limit, now?)`, `removeFromGroup(id, groupId)`
- `EventService`: `getEventsInRangeForGroup(groupId, startUtc, endUtc): EventOccurrence[]`, `getUpcomingForGroup(groupId, limit): EventOccurrence[]`, `removeFromGroup(eventId, groupId)`
- AI agent: `scope` parameter on all event tools, `isGroup`/`groupChatId`/`groupTitle` in `AgentContext`, group system prompt, per-chat history, `GroupSessionManager`, `GroupMemberService`
- `group_members` table and tracking in message handler
- `scripts/get-chat-members.py`

---

## File Map

**DB / Types:**
- Modify: `src/database/migrations.ts` — add migration `026_group_chats_timezone_country`
- Modify: `src/database/types.ts` — add `timezone`, `country` to `GroupChat`
- Modify: `src/database/repositories/group-chat.repository.ts` — add `getTimezone`, `setTimezone`, `setCountry`

**Cleanup (delete):**
- Delete: `src/bot/commands/agenda.ts`
- Delete: `src/bot/commands/unshare.ts`
- Delete: `src/bot/commands/timezone.ts`
- Modify: `src/bot/index.ts` — remove imports + `.command()` registrations for agenda, unshare, timezone
- Modify: `src/bot/handlers/callback.handler.ts` — remove GROUP_AGENDA (line 674) and UNSHARE_PICK (line 876) handlers
- Modify: `src/bot/keyboards.ts` — remove `unsharePickerKeyboard`
- Modify: `src/config/constants.ts` — remove `CB.GROUP_AGENDA` and `CB.UNSHARE_PICK`. **Do NOT remove `CB.FEATURE_TOUR`** — actively used by onboarding scene and callback handler.

**Group context utility:**
- Create: `src/bot/group-context.ts` — `isGroup(ctx)`, `getGroupId(ctx)`

**View commands (adapt):**
- Modify: `src/bot/commands/today.ts`
- Modify: `src/bot/commands/tomorrow.ts`
- Modify: `src/bot/commands/week.ts`
- Modify: `src/bot/commands/month.ts`

**Write commands (adapt):**
- Modify: `src/bot/commands/add.ts`
- Modify: `src/bot/commands/edit.ts`
- Modify: `src/bot/commands/delete.ts`

**Search + free (adapt):**
- Modify: `src/bot/commands/search.ts`
- Modify: `src/bot/commands/free.ts`

**Settings (adapt):**
- Modify: `src/bot/commands/settings.ts`
- Modify: `src/bot/handlers/callback.handler.ts` — group settings callbacks
- Modify: `src/config/constants.ts` — add `CB.GROUP_SETTINGS_TZ`, `CB.GROUP_SETTINGS_COUNTRY`

**Other (adapt):**
- Modify: `src/bot/commands/import.ts`
- Modify: `src/bot/commands/holidays.ts`
- Modify: `src/bot/commands/share.ts`
- Modify: `src/bot/commands/invite.ts`

**Disable in groups:**
- Modify: `src/bot/commands/connect-google.ts`
- Modify: `src/bot/commands/disconnect-google.ts`

---

## Task 1: DB migration — group timezone/country

**Files:**
- Modify: `src/database/migrations.ts`
- Modify: `src/database/types.ts`
- Modify: `src/database/repositories/group-chat.repository.ts`
- Test: `test/database/repositories/group-chat.repository.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/database/repositories/group-chat.repository.test.ts — add these tests
import { test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../../src/database/migrations.ts";
import { GroupChatRepository } from "../../../src/database/repositories/group-chat.repository.ts";

let db: Database;
let repo: GroupChatRepository;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  repo = new GroupChatRepository(db);
  repo.upsertGroup({ chat_id: -100123, added_by: 1 });
});

test("setTimezone stores and getTimezone retrieves", () => {
  repo.setTimezone(-100123, "Europe/Moscow");
  expect(repo.getTimezone(-100123)).toBe("Europe/Moscow");
});

test("setCountry stores and findByChatId includes country", () => {
  repo.setCountry(-100123, "RU");
  const group = repo.findByChatId(-100123);
  expect(group?.country).toBe("RU");
});

test("getTimezone returns null when not set", () => {
  expect(repo.getTimezone(-100123)).toBeNull();
});
```

- [ ] **Step 2: Run test — confirm it fails**

```bash
bun test test/database/repositories/group-chat.repository.test.ts
```

Expected: FAIL — `setTimezone is not a function`

- [ ] **Step 3: Add migration to `src/database/migrations.ts`**

Append before the closing `]` of the `migrations` array (after migration `025_invite_proposed_time`):

```typescript
{
  name: '026_group_chats_timezone_country',
  up: (db) => {
    db.exec('ALTER TABLE group_chats ADD COLUMN timezone TEXT');
    db.exec('ALTER TABLE group_chats ADD COLUMN country TEXT');
  },
},
```

- [ ] **Step 4: Update `GroupChat` type in `src/database/types.ts`**

```typescript
export interface GroupChat {
  chat_id: number;
  title: string | null;
  added_by: number;
  added_at: string;
  is_active: number;
  pin_hint_shown: number;
  timezone: string | null;
  country: string | null;
}
```

- [ ] **Step 5: Add methods to `GroupChatRepository`**

```typescript
getTimezone(chatId: number): string | null {
  const row = this.db
    .prepare('SELECT timezone FROM group_chats WHERE chat_id = ?')
    .get(chatId) as { timezone: string | null } | null;
  return row?.timezone ?? null;
}

setTimezone(chatId: number, timezone: string): void {
  this.db
    .prepare('UPDATE group_chats SET timezone = ? WHERE chat_id = ?')
    .run(timezone, chatId);
}

setCountry(chatId: number, country: string): void {
  this.db
    .prepare('UPDATE group_chats SET country = ? WHERE chat_id = ?')
    .run(country, chatId);
}
```

- [ ] **Step 6: Run test — confirm it passes**

```bash
bun test test/database/repositories/group-chat.repository.test.ts
```

Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/database/migrations.ts src/database/types.ts src/database/repositories/group-chat.repository.ts test/database/repositories/group-chat.repository.test.ts
git commit -m "feat(groups): add timezone and country columns to group_chats"
```

---

## Task 2: Group context utility

**Files:**
- Create: `src/bot/group-context.ts`
- Test: `test/bot/group-context.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/bot/group-context.test.ts
import { test, expect } from "bun:test";
import { isGroup, getGroupId } from "../../src/bot/group-context.ts";

type ChatType = 'group' | 'supergroup' | 'private' | 'channel';

function makeCtx(type: ChatType, id: number) {
  return { chat: { type, id } } as never;
}

test("isGroup returns true for group", () => {
  expect(isGroup(makeCtx("group", -100))).toBe(true);
});

test("isGroup returns true for supergroup", () => {
  expect(isGroup(makeCtx("supergroup", -100))).toBe(true);
});

test("isGroup returns false for private", () => {
  expect(isGroup(makeCtx("private", 1))).toBe(false);
});

test("getGroupId returns chat id for group", () => {
  expect(getGroupId(makeCtx("group", -100))).toBe(-100);
});

test("getGroupId returns null for private", () => {
  expect(getGroupId(makeCtx("private", 1))).toBeNull();
});
```

- [ ] **Step 2: Run test — confirm it fails**

```bash
bun test test/bot/group-context.test.ts
```

Expected: FAIL — module not found

- [ ] **Step 3: Create `src/bot/group-context.ts`**

```typescript
// src/bot/group-context.ts

type ChatType = 'group' | 'supergroup' | 'private' | 'channel';

interface CtxWithChat {
  chat?: { type: ChatType; id: number };
}

export function isGroup(ctx: CtxWithChat): boolean {
  return ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
}

export function getGroupId(ctx: CtxWithChat): number | null {
  if (!isGroup(ctx)) return null;
  return ctx.chat?.id ?? null;
}
```

- [ ] **Step 4: Run test — confirm it passes**

```bash
bun test test/bot/group-context.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/bot/group-context.ts test/bot/group-context.test.ts
git commit -m "feat(groups): add group context utility helpers"
```

---

## Task 3: Remove deprecated commands

**Files:**
- Delete: `src/bot/commands/agenda.ts`
- Delete: `src/bot/commands/unshare.ts`
- Delete: `src/bot/commands/timezone.ts`
- Modify: `src/bot/index.ts`
- Modify: `src/bot/handlers/callback.handler.ts`
- Modify: `src/bot/keyboards.ts`
- Modify: `src/config/constants.ts`

- [ ] **Step 1: Remove imports from `src/bot/index.ts`**

Remove:
```typescript
import { handleGroupAgenda } from './commands/agenda.ts';
import { handleTimezone } from './commands/timezone.ts';
import { handleUnshare } from './commands/unshare.ts';
```

- [ ] **Step 2: Remove `.command()` registrations from `src/bot/index.ts`**

Remove:
```typescript
.command('timezone', (ctx) => handleTimezone(ctx as unknown as BotCommandContext, scenesSetup.scenes.timezoneScene))
.command('unshare', (ctx) => handleUnshare(ctx as unknown as BotCommandContext, db.groupChats, eventService))
.command('agenda', (ctx) => handleGroupAgenda(ctx as unknown as BotCommandContext, db.groupChats, db.events))
```

- [ ] **Step 3: Remove GROUP_AGENDA and UNSHARE_PICK handlers from `src/bot/handlers/callback.handler.ts`**

Remove the block at line 674 handling `CB.GROUP_AGENDA` and the block at line 876 handling `CB.UNSHARE_PICK`.

- [ ] **Step 4: Remove `unsharePickerKeyboard` from `src/bot/keyboards.ts`**

- [ ] **Step 5: Remove stale CB keys from `src/config/constants.ts`**

Remove only:
- `GROUP_AGENDA: 'grp_ag'`
- `UNSHARE_PICK: 'unsp'`

**Do NOT remove `FEATURE_TOUR`** — it is used by `onboarding.scene.ts` and `callback.handler.ts`.

- [ ] **Step 6: Delete the three command files**

```bash
rm src/bot/commands/agenda.ts src/bot/commands/unshare.ts src/bot/commands/timezone.ts
```

- [ ] **Step 7: Run full test suite + lint**

```bash
bun test && bun run lint
```

Expected: all previously passing tests still pass, zero lint warnings

- [ ] **Step 8: Commit**

```bash
git add src/bot/index.ts src/bot/handlers/callback.handler.ts src/bot/keyboards.ts src/config/constants.ts
git commit -m "feat(groups): remove deprecated /agenda, /unshare, /timezone commands"
```

---

## Task 4: Adapt view commands (/today, /tomorrow, /week, /month)

**Files:**
- Modify: `src/bot/commands/today.ts`
- Modify: `src/bot/commands/tomorrow.ts`
- Modify: `src/bot/commands/week.ts`
- Modify: `src/bot/commands/month.ts`
- Modify: `src/bot/index.ts`
- Test: `test/bot/commands/today.test.ts`

In group context: use `eventService.getEventsInRangeForGroup(groupId, start, end)` which returns `EventOccurrence[]` — same type as the personal path, so existing formatters (`formatDayAgenda`, `formatWeekAgenda`) work unchanged. No image rendering in group view.

- [ ] **Step 1: Write failing tests**

```typescript
// test/bot/commands/today.test.ts
import { test, expect, mock } from "bun:test";
import { handleToday } from "../../../src/bot/commands/today.ts";

test("handleToday in group uses getEventsInRangeForGroup, not personal", async () => {
  const groupOccurrence = { id: 1, title: "Standup", start_at: new Date().toISOString() };
  const eventService = {
    getEventsForDay: mock(() => []),
    getEventsInRangeForGroup: mock(() => [groupOccurrence]),
  };
  const groupRepo = { getTimezone: mock(() => "Europe/Moscow") };
  const ctx = {
    chat: { type: "group", id: -100 },
    dbUser: { telegram_id: 1, language: "ru", timezone: "UTC" },
    send: mock(() => {}),
  };
  await handleToday(ctx as never, eventService as never, undefined, undefined, groupRepo as never);
  expect(eventService.getEventsInRangeForGroup).toHaveBeenCalled();
  expect(eventService.getEventsForDay).not.toHaveBeenCalled();
});

test("handleToday in group with no timezone sends Russian prompt", async () => {
  const groupRepo = { getTimezone: mock(() => null) };
  let sentText = "";
  const ctx = {
    chat: { type: "group", id: -100 },
    dbUser: { telegram_id: 1, language: "ru", timezone: "UTC" },
    send: mock((text: string) => { sentText = text; }),
  };
  await handleToday(ctx as never, {} as never, undefined, undefined, groupRepo as never);
  expect(sentText).toContain("таймзону");
});
```

- [ ] **Step 2: Run test — confirm it fails**

```bash
bun test test/bot/commands/today.test.ts
```

- [ ] **Step 3: Update `handleToday`**

```typescript
import { isGroup, getGroupId } from '../group-context.ts';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';

export async function handleToday(
  ctx: BotCommandContext,
  eventService: EventService,
  holidayService?: HolidayService,
  renderService?: RenderService,
  groupRepo?: GroupChatRepository,
): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';

  if (isGroup(ctx)) {
    const groupId = getGroupId(ctx)!;
    const timezone = groupRepo?.getTimezone(groupId) ?? null;
    if (!timezone) {
      await ctx.send(lang === 'ru'
        ? '⚙️ Сначала задайте таймзону группы через /settings'
        : '⚙️ Set the group timezone first via /settings');
      return;
    }
    const now = new Date();
    const dayStart = new TZDate(now, timezone);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new TZDate(now, timezone);
    dayEnd.setHours(23, 59, 59, 999);
    const occurrences = eventService.getEventsInRangeForGroup(groupId, dayStart.toISOString(), dayEnd.toISOString());
    const holidays = holidayService?.getHolidaysForDate(groupId, new TZDate(now, timezone).toISOString().slice(0, 10)) ?? [];
    const text = formatDayAgenda(occurrences, now.toISOString(), timezone, lang, holidays);
    await ctx.send(text, { parse_mode: 'HTML' });
    return;
  }

  // existing personal logic — unchanged
  ...
}
```

Apply the same group branch pattern to `handleTomorrow`, `handleWeek`, `handleMonth` — adjust date ranges accordingly. No image rendering in group view.

- [ ] **Step 4: Update `index.ts` to pass `groupRepo`**

```typescript
.command('today', (ctx) =>
  handleToday(ctx as unknown as BotCommandContext, eventService, holidayService, renderService, db.groupChats)
)
.command('tomorrow', (ctx) =>
  handleTomorrow(ctx as unknown as BotCommandContext, eventService, holidayService, renderService, db.groupChats)
)
.command('week', (ctx) =>
  handleWeek(ctx as unknown as BotCommandContext, eventService, holidayService, renderService, db.groupChats)
)
.command('month', (ctx) =>
  handleMonth(ctx as unknown as BotCommandContext, eventService, renderService, db.groupChats)
)
```

- [ ] **Step 5: Run tests**

```bash
bun test test/bot/commands/today.test.ts && bun test
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/bot/commands/today.ts src/bot/commands/tomorrow.ts src/bot/commands/week.ts src/bot/commands/month.ts src/bot/index.ts test/bot/commands/today.test.ts
git commit -m "feat(groups): /today /tomorrow /week /month show group calendar in groups"
```

---

## Task 5: Adapt /add for groups

**Files:**
- Modify: `src/bot/commands/add.ts`
- Modify: `src/bot/index.ts`
- Test: `test/bot/commands/add.test.ts`

In group context: create event with `owner_type='group'`, `group_id=chatId`, `created_by=user.telegram_id`. If no group timezone, prompt.

- [ ] **Step 1: Write failing test**

```typescript
// test/bot/commands/add.test.ts
import { test, expect, mock } from "bun:test";
import { handleAdd } from "../../../src/bot/commands/add.ts";

test("handleAdd in group creates group event", async () => {
  let createdData: Record<string, unknown> = {};
  const eventService = {
    createEvent: mock((data) => { createdData = data; return { id: 1, title: "Встреча" }; }),
    parseEventFromText: mock(() => ({ title: "Встреча", start_at: new Date().toISOString() })),
  };
  const groupRepo = { getTimezone: mock(() => "Europe/Moscow") };
  const ctx = {
    chat: { type: "group", id: -100 },
    dbUser: { telegram_id: 42, language: "ru", timezone: "UTC" },
    args: "Встреча завтра в 14:00",
    send: mock(() => {}),
  };
  await handleAdd(ctx as never, eventService as never, undefined, groupRepo as never);
  expect(createdData.owner_type).toBe("group");
  expect(createdData.group_id).toBe(-100);
  expect(createdData.created_by).toBe(42);
});

test("handleAdd in group with no timezone sends prompt", async () => {
  const groupRepo = { getTimezone: mock(() => null) };
  let sentText = "";
  const ctx = {
    chat: { type: "group", id: -100 },
    dbUser: { telegram_id: 1, language: "ru", timezone: "UTC" },
    args: "Встреча",
    send: mock((text: string) => { sentText = text; }),
  };
  await handleAdd(ctx as never, {} as never, undefined, groupRepo as never);
  expect(sentText).toContain("таймзону");
});
```

- [ ] **Step 2: Run test — confirm it fails**

```bash
bun test test/bot/commands/add.test.ts
```

- [ ] **Step 3: Update `handleAdd`**

```typescript
import { isGroup, getGroupId } from '../group-context.ts';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';

export async function handleAdd(
  ctx: BotCommandContext,
  eventService: EventService,
  addEventScene?: AnyScene,
  groupRepo?: GroupChatRepository,
): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';
  const groupId = getGroupId(ctx);

  if (groupId !== null) {
    const timezone = groupRepo?.getTimezone(groupId) ?? null;
    if (!timezone) {
      await ctx.send(lang === 'ru'
        ? '⚙️ Сначала задайте таймзону группы через /settings'
        : '⚙️ Set the group timezone first via /settings');
      return;
    }
  }

  // When calling eventService.createEvent, merge group fields:
  const groupFields = groupId !== null ? {
    owner_type: 'group' as const,
    group_id: groupId,
    created_by: user.telegram_id,
  } : {};
  // Pass groupFields into the create call at all points where createEvent is called
  ...
}
```

- [ ] **Step 4: Update `index.ts`**

```typescript
.command('add', (ctx) =>
  handleAdd(ctx as unknown as BotCommandContext, eventService, scenesSetup.scenes.addEventScene, db.groupChats)
)
```

- [ ] **Step 5: Run tests**

```bash
bun test test/bot/commands/add.test.ts && bun test
```

- [ ] **Step 6: Commit**

```bash
git add src/bot/commands/add.ts src/bot/index.ts test/bot/commands/add.test.ts
git commit -m "feat(groups): /add creates group event in group context"
```

---

## Task 6: Adapt /edit and /delete for groups

**Files:**
- Modify: `src/bot/commands/edit.ts`
- Modify: `src/bot/commands/delete.ts`
- Modify: `src/bot/index.ts`
- Test: `test/bot/commands/delete.test.ts`

Use existing `eventService.getUpcomingForGroup(groupId, limit)` and `eventService.removeFromGroup(eventId, groupId)`. Do NOT add new repository methods — they already exist.

For picking events use the existing `eventPickerKeyboard` from `src/bot/keyboards.ts` (already handles lists of events).

- [ ] **Step 1: Write failing test for /delete group behavior**

```typescript
// test/bot/commands/delete.test.ts
import { test, expect, mock } from "bun:test";
import { handleDelete } from "../../../src/bot/commands/delete.ts";

test("handleDelete in group shows group events using getUpcomingForGroup", async () => {
  const groupOccurrences = [{ id: 5, title: "Sprint review", start_at: new Date().toISOString() }];
  const eventService = {
    getUpcoming: mock(() => []),
    getUpcomingForGroup: mock(() => groupOccurrences),
  };
  const groupRepo = { getTimezone: mock(() => "Europe/Moscow") };
  let sentText = "";
  const ctx = {
    chat: { type: "group", id: -100 },
    dbUser: { telegram_id: 1, language: "ru", timezone: "UTC" },
    send: mock((text: string) => { sentText = text; }),
  };
  await handleDelete(ctx as never, eventService as never, groupRepo as never);
  expect(eventService.getUpcomingForGroup).toHaveBeenCalledWith(-100, 10);
  expect(eventService.getUpcoming).not.toHaveBeenCalled();
});

test("handleDelete in group with no timezone prompts", async () => {
  const groupRepo = { getTimezone: mock(() => null) };
  let sentText = "";
  const ctx = {
    chat: { type: "group", id: -100 },
    dbUser: { telegram_id: 1, language: "ru", timezone: "UTC" },
    send: mock((text: string) => { sentText = text; }),
  };
  await handleDelete(ctx as never, {} as never, groupRepo as never);
  expect(sentText).toContain("таймзону");
});
```

- [ ] **Step 2: Run test — confirm it fails**

```bash
bun test test/bot/commands/delete.test.ts
```

- [ ] **Step 3: Update `handleDelete`**

```typescript
import { isGroup, getGroupId } from '../group-context.ts';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';

export async function handleDelete(
  ctx: BotCommandContext,
  eventService: EventService,
  groupRepo?: GroupChatRepository,
): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';
  const groupId = getGroupId(ctx);

  if (groupId !== null) {
    const timezone = groupRepo?.getTimezone(groupId) ?? null;
    if (!timezone) {
      await ctx.send(lang === 'ru' ? '⚙️ Сначала задайте таймзону через /settings' : '⚙️ Set group timezone via /settings');
      return;
    }
    const occurrences = eventService.getUpcomingForGroup(groupId, 10);
    if (occurrences.length === 0) {
      await ctx.send(lang === 'ru' ? '📭 Нет предстоящих событий' : '📭 No upcoming events');
      return;
    }
    // Use existing eventPickerKeyboard from src/bot/keyboards.ts
    const kb = eventPickerKeyboard(occurrences, user.timezone, CB.EVENT_DELETE);
    await ctx.send(
      lang === 'ru' ? '🗑 Выберите событие для удаления:' : '🗑 Select event to delete:',
      { reply_markup: kb }
    );
    return;
  }

  // existing personal logic unchanged
  ...
}
```

The delete confirmation callback handler must use `eventService.removeFromGroup(eventId, groupId)` when the event has `owner_type='group'`. Check the event's `owner_type` after fetching it by id and route accordingly.

Apply the same group branch to `handleEdit` (show group events for editing).

- [ ] **Step 4: Update `index.ts`**

```typescript
.command('delete', (ctx) =>
  handleDelete(ctx as unknown as BotCommandContext, eventService, db.groupChats)
)
.command('edit', (ctx) =>
  handleEdit(ctx as unknown as BotCommandContext, eventService, db.groupChats)
)
```

- [ ] **Step 5: Run tests**

```bash
bun test test/bot/commands/delete.test.ts && bun test
```

- [ ] **Step 6: Commit**

```bash
git add src/bot/commands/edit.ts src/bot/commands/delete.ts src/bot/index.ts test/bot/commands/delete.test.ts
git commit -m "feat(groups): /edit and /delete operate on group events in group context"
```

---

## Task 7: Adapt /search and /free

**Files:**
- Modify: `src/bot/commands/search.ts`
- Modify: `src/bot/commands/free.ts`
- Modify: `src/bot/index.ts`
- Test: `test/bot/commands/search.test.ts`

`EventService.searchGroupEvents` may not exist — check. If not, add:
```typescript
searchGroupEvents(groupId: number, query: string): CalendarEvent[] {
  return this.eventRepo.searchForGroup(groupId, query);
}
```

- [ ] **Step 1: Check if searchGroupEvents exists**

```bash
grep -n "searchGroupEvents" src/services/event/event-service.ts
```

Add to `EventService` if absent (see above).

- [ ] **Step 2: Write failing test**

```typescript
// test/bot/commands/search.test.ts
import { test, expect, mock } from "bun:test";
import { handleSearch } from "../../../src/bot/commands/search.ts";

test("handleSearch in group uses searchGroupEvents", async () => {
  const eventService = {
    searchEvents: mock(() => []),
    searchGroupEvents: mock(() => [{ id: 1, title: "Встреча" }]),
  };
  const ctx = {
    chat: { type: "group", id: -100 },
    dbUser: { telegram_id: 1, language: "ru", timezone: "UTC" },
    args: "встреча",
    send: mock(() => {}),
  };
  await handleSearch(ctx as never, eventService as never);
  expect(eventService.searchGroupEvents).toHaveBeenCalledWith(-100, "встреча");
  expect(eventService.searchEvents).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run test — confirm it fails**

```bash
bun test test/bot/commands/search.test.ts
```

- [ ] **Step 4: Add group branch to `handleSearch`**

```typescript
if (isGroup(ctx)) {
  const groupId = getGroupId(ctx)!;
  const results = eventService.searchGroupEvents(groupId, query);
  // format same as personal search, send
  return;
}
```

- [ ] **Step 5: Add group branch to `handleFree`**

In group context, use group timezone and `getEventsInRangeForGroup` for the day to calculate free slots.

```typescript
if (isGroup(ctx)) {
  const groupId = getGroupId(ctx)!;
  const timezone = groupRepo?.getTimezone(groupId) ?? null;
  if (!timezone) {
    await ctx.send(lang === 'ru' ? '⚙️ Задайте таймзону через /settings' : '⚙️ Set timezone via /settings');
    return;
  }
  // compute free slots using group events for the requested date
  return;
}
```

- [ ] **Step 6: Update `index.ts`** to pass `groupRepo` to `handleFree`

```typescript
.command('free', (ctx) =>
  handleFree(ctx as unknown as BotCommandContext, eventService, holidayService, db.groupChats)
)
```

- [ ] **Step 7: Run tests**

```bash
bun test test/bot/commands/search.test.ts && bun test
```

- [ ] **Step 8: Commit**

```bash
git add src/bot/commands/search.ts src/bot/commands/free.ts src/services/event/event-service.ts src/bot/index.ts test/bot/commands/search.test.ts
git commit -m "feat(groups): /search and /free operate on group calendar in groups"
```

---

## Task 8: Adapt /settings for groups

**Files:**
- Modify: `src/bot/commands/settings.ts`
- Modify: `src/bot/handlers/callback.handler.ts`
- Modify: `src/config/constants.ts`
- Modify: `src/bot/index.ts`
- Test: `test/bot/commands/settings.test.ts`

Add new CB keys. The timezone/country selection reuses the existing onboarding timezone/country picker callbacks — check how `CB.ONBOARD_TZ` and `CB.ONBOARD_COUNTRY` are handled in `callback.handler.ts` and add parallel `GROUP_SETTINGS_TZ` / `GROUP_SETTINGS_COUNTRY` handlers that call `groupRepo.setTimezone` / `groupRepo.setCountry` instead of updating the user.

- [ ] **Step 1: Add CB keys to `src/config/constants.ts`**

```typescript
GROUP_SETTINGS_TZ: 'gst',
GROUP_SETTINGS_COUNTRY: 'gsc',
```

- [ ] **Step 2: Write failing test**

```typescript
// test/bot/commands/settings.test.ts
import { test, expect, mock } from "bun:test";
import { handleSettings } from "../../../src/bot/commands/settings.ts";

test("handleSettings in group shows group settings menu", async () => {
  const groupRepo = {
    findByChatId: mock(() => ({ chat_id: -100, timezone: "Europe/Moscow", country: "RU" })),
  };
  let sentText = "";
  const ctx = {
    chat: { type: "group", id: -100 },
    dbUser: { telegram_id: 1, language: "ru", timezone: "UTC" },
    send: mock((text: string) => { sentText = text; }),
  };
  await handleSettings(ctx as never, groupRepo as never);
  expect(sentText).toContain("Настройки группы");
  expect(sentText).toContain("Europe/Moscow");
});

test("handleSettings in group shows 'not set' when no timezone", async () => {
  const groupRepo = {
    findByChatId: mock(() => ({ chat_id: -100, timezone: null, country: null })),
  };
  let sentText = "";
  const ctx = {
    chat: { type: "group", id: -100 },
    dbUser: { telegram_id: 1, language: "ru", timezone: "UTC" },
    send: mock((text: string) => { sentText = text; }),
  };
  await handleSettings(ctx as never, groupRepo as never);
  expect(sentText).toContain("не задана");
});
```

- [ ] **Step 3: Run test — confirm it fails**

```bash
bun test test/bot/commands/settings.test.ts
```

- [ ] **Step 4: Add group branch to `handleSettings`**

```typescript
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';

export async function handleSettings(
  ctx: BotCommandContext,
  groupRepo?: GroupChatRepository,
): Promise<void> {
  if (isGroup(ctx)) {
    await handleGroupSettings(ctx, groupRepo!);
    return;
  }
  // existing personal settings flow
  ...
}

async function handleGroupSettings(ctx: BotCommandContext, groupRepo: GroupChatRepository): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';
  const groupId = getGroupId(ctx)!;
  const group = groupRepo.findByChatId(groupId);

  const tz = group?.timezone ?? (lang === 'ru' ? '❌ не задана' : '❌ not set');
  const country = group?.country ?? (lang === 'ru' ? '❌ не задана' : '❌ not set');

  const text = lang === 'ru'
    ? `⚙️ <b>Настройки группы</b>\n\n🌍 Таймзона: <code>${tz}</code>\n🏳️ Страна: <code>${country}</code>`
    : `⚙️ <b>Group settings</b>\n\n🌍 Timezone: <code>${tz}</code>\n🏳️ Country: <code>${country}</code>`;

  const kb = new InlineKeyboard()
    .text(lang === 'ru' ? '🌍 Изменить таймзону' : '🌍 Change timezone', `${CB.GROUP_SETTINGS_TZ}:select`)
    .row()
    .text(lang === 'ru' ? '🏳️ Изменить страну' : '🏳️ Change country', `${CB.GROUP_SETTINGS_COUNTRY}:select`);

  await ctx.send(text, { parse_mode: 'HTML', reply_markup: kb });
}
```

- [ ] **Step 5: Wire callbacks in `callback.handler.ts`**

Find the block that handles `CB.ONBOARD_TZ` (sets `user.timezone`) in callback.handler.ts. Add a parallel block for `CB.GROUP_SETTINGS_TZ` that calls `groupRepo.setTimezone(chatId, tz)` instead.

Similarly for `CB.GROUP_SETTINGS_COUNTRY` → `groupRepo.setCountry(chatId, country)`.

The actual timezone region picker (keyboard showing regions/zones) can be reused as-is since it's just a keyboard — the final action is different.

- [ ] **Step 6: Update `index.ts`**

```typescript
.command('settings', (ctx) =>
  handleSettings(ctx as unknown as BotCommandContext, db.groupChats)
)
```

- [ ] **Step 7: Run tests**

```bash
bun test test/bot/commands/settings.test.ts && bun test
```

- [ ] **Step 8: Commit**

```bash
git add src/bot/commands/settings.ts src/bot/handlers/callback.handler.ts src/config/constants.ts src/bot/index.ts test/bot/commands/settings.test.ts
git commit -m "feat(groups): /settings shows group settings menu with timezone/country"
```

---

## Task 9: Adapt /import and /holidays

**Files:**
- Modify: `src/bot/commands/import.ts`
- Modify: `src/bot/commands/holidays.ts`
- Modify: `src/bot/index.ts`
- Test: `test/bot/commands/holidays.test.ts`

- [ ] **Step 1: Write failing test for /holidays group branch**

```typescript
// test/bot/commands/holidays.test.ts
import { test, expect, mock } from "bun:test";
import { handleHolidays } from "../../../src/bot/commands/holidays.ts";

test("handleHolidays in group prompts to set country when not set", async () => {
  const groupRepo = {
    findByChatId: mock(() => ({ chat_id: -100, timezone: "Europe/Moscow", country: null })),
  };
  let sentText = "";
  const ctx = {
    chat: { type: "group", id: -100 },
    dbUser: { telegram_id: 1, language: "ru", timezone: "UTC" },
    args: "",
    send: mock((text: string) => { sentText = text; }),
  };
  await handleHolidays(ctx as never, {} as never, groupRepo as never);
  expect(sentText).toContain("страну");
});

test("handleHolidays in group with country shows holidays menu", async () => {
  const groupRepo = {
    findByChatId: mock(() => ({ chat_id: -100, timezone: "Europe/Moscow", country: "RU" })),
  };
  const holidayService = { getHolidaySubscriptions: mock(() => []) };
  let sentText = "";
  const ctx = {
    chat: { type: "group", id: -100 },
    dbUser: { telegram_id: 1, language: "ru", timezone: "UTC" },
    args: "",
    send: mock((text: string) => { sentText = text; }),
  };
  await handleHolidays(ctx as never, holidayService as never, groupRepo as never);
  expect(sentText).not.toContain("страну");
});
```

- [ ] **Step 2: Run test — confirm it fails**

```bash
bun test test/bot/commands/holidays.test.ts
```

- [ ] **Step 3: Add group branch to `handleHolidays`**

```typescript
export async function handleHolidays(
  ctx: BotCommandContext,
  holidayService: HolidayService,
  groupRepo?: GroupChatRepository,
): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';

  if (isGroup(ctx)) {
    const groupId = getGroupId(ctx)!;
    const group = groupRepo?.findByChatId(groupId);
    if (!group?.country) {
      await ctx.send(lang === 'ru'
        ? '🏳️ Сначала задайте страну группы через /settings'
        : '🏳️ Set the group country first via /settings');
      return;
    }
    // Show holiday menu scoped to group's country
    // Use holidayService with group.country as filter
    await sendGroupHolidaysMenu(ctx, holidayService, group, lang);
    return;
  }

  // existing personal flow
  ...
}
```

- [ ] **Step 4: Update `handleImport` to redirect in group context**

```typescript
export async function handleImport(ctx: BotCommandContext, importScene: AnyScene): Promise<void> {
  if (isGroup(ctx)) {
    const lang = (ctx.dbUser?.language ?? 'en') as 'en' | 'ru';
    await ctx.send(lang === 'ru'
      ? '📥 Импорт доступен только в личном чате с ботом'
      : '📥 Import is only available in private chat with the bot');
    return;
  }
  await ctx.scene.enter(importScene);
}
```

- [ ] **Step 5: Update `index.ts`**

```typescript
.command('holidays', (ctx) =>
  handleHolidays(ctx as unknown as BotCommandContext, holidayService, db.groupChats)
)
```

- [ ] **Step 6: Run tests**

```bash
bun test test/bot/commands/holidays.test.ts && bun test
```

- [ ] **Step 7: Commit**

```bash
git add src/bot/commands/import.ts src/bot/commands/holidays.ts src/bot/index.ts test/bot/commands/holidays.test.ts
git commit -m "feat(groups): /holidays uses group country; /import redirects to DM in groups"
```

---

## Task 10: Adapt /share and /invite

**Files:**
- Modify: `src/bot/commands/share.ts`
- Modify: `src/bot/commands/invite.ts`
- Modify: `src/bot/index.ts`
- Test: `test/bot/commands/share.test.ts`

In group context:
- `/share`: show upcoming group events, share selected as event card to external chat
- `/invite`: invite external person to selected group event

- [ ] **Step 1: Write failing test for /share group branch**

```typescript
// test/bot/commands/share.test.ts
import { test, expect, mock } from "bun:test";
import { handleShare } from "../../../src/bot/commands/share.ts";

test("handleShare in group shows group events picker", async () => {
  const groupOccurrences = [{ id: 3, title: "Demo Day", start_at: new Date().toISOString() }];
  const eventService = {
    getUpcomingForGroup: mock(() => groupOccurrences),
    getUpcoming: mock(() => []),
  };
  const groupRepo = { getTimezone: mock(() => "Europe/Moscow") };
  let sentText = "";
  const ctx = {
    chat: { type: "group", id: -100 },
    dbUser: { telegram_id: 1, language: "ru", timezone: "UTC" },
    args: "",
    send: mock((text: string) => { sentText = text; }),
  };
  await handleShare(ctx as never, eventService as never, {} as never, {} as never, groupRepo as never);
  expect(eventService.getUpcomingForGroup).toHaveBeenCalledWith(-100, 10);
  expect(eventService.getUpcoming).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test — confirm it fails**

```bash
bun test test/bot/commands/share.test.ts
```

- [ ] **Step 3: Add group branch to `handleShare`**

```typescript
export async function handleShare(
  ctx: BotCommandContext,
  eventService: EventService,
  privacyService: PrivacyService,
  deepLinkService: DeepLinkService,
  groupRepo?: GroupChatRepository,
): Promise<void> {
  if (isGroup(ctx)) {
    const groupId = getGroupId(ctx)!;
    const occurrences = eventService.getUpcomingForGroup(groupId, 10);
    if (occurrences.length === 0) {
      const lang = (ctx.dbUser?.language ?? 'en') as 'en' | 'ru';
      await ctx.send(lang === 'ru' ? '📭 Нет событий в группе' : '📭 No group events');
      return;
    }
    // Show event picker, reuse existing shareEvent flow for the selected event
    await showGroupSharePicker(ctx, occurrences, deepLinkService);
    return;
  }
  // existing personal flow
  ...
}
```

Apply similar group branch to `handleInvite`: show group events picker, then proceed with existing invitation flow using the selected event id.

- [ ] **Step 4: Update `index.ts`** to pass `groupRepo` to `handleShare` and `handleInvite`

- [ ] **Step 5: Run tests**

```bash
bun test test/bot/commands/share.test.ts && bun test
```

- [ ] **Step 6: Commit**

```bash
git add src/bot/commands/share.ts src/bot/commands/invite.ts src/bot/index.ts test/bot/commands/share.test.ts
git commit -m "feat(groups): /share and /invite operate on group events in group context"
```

---

## Task 11: Disable /connect-google and /disconnect-google in groups

**Files:**
- Modify: `src/bot/commands/connect-google.ts`
- Modify: `src/bot/commands/disconnect-google.ts`
- Test: `test/bot/commands/connect-google.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/bot/commands/connect-google.test.ts
import { test, expect, mock } from "bun:test";
import { handleConnectGoogle } from "../../../src/bot/commands/connect-google.ts";

test("handleConnectGoogle in group sends 'private chat only' message", async () => {
  let sentText = "";
  const ctx = {
    chat: { type: "group", id: -100 },
    dbUser: { telegram_id: 1, language: "ru" },
    send: mock((text: string) => { sentText = text; }),
  };
  await handleConnectGoogle(ctx as never, {} as never);
  expect(sentText).toContain("личном чате");
});
```

- [ ] **Step 2: Run test — confirm it fails**

```bash
bun test test/bot/commands/connect-google.test.ts
```

- [ ] **Step 3: Add group guard to `handleConnectGoogle`**

```typescript
if (isGroup(ctx)) {
  const lang = (ctx.dbUser?.language ?? 'en') as 'en' | 'ru';
  await ctx.send(lang === 'ru'
    ? '🔗 Google Calendar подключается только в личном чате'
    : '🔗 Connect Google Calendar in private chat with the bot');
  return;
}
```

Apply same guard to `handleDisconnectGoogle`.

- [ ] **Step 4: Run tests**

```bash
bun test test/bot/commands/connect-google.test.ts && bun test
```

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/connect-google.ts src/bot/commands/disconnect-google.ts test/bot/commands/connect-google.test.ts
git commit -m "feat(groups): disable /connect-google and /disconnect-google in groups"
```

---

## Task 12: Final verification

- [ ] **Step 1: Run full test suite with coverage**

```bash
bun test --coverage
```

Expected: all tests pass, coverage ≥ 80%

- [ ] **Step 2: Run lint**

```bash
bun run lint
```

Expected: zero warnings

- [ ] **Step 3: Smoke test in Telegram**

1. Add bot to a test group
2. `/settings` → shows group settings menu with timezone/country
3. Set timezone via settings → `/today` shows group calendar
4. `/add Встреча завтра в 10:00` → creates group event; `/tomorrow` shows it
5. `/delete` → shows group events, deletes correctly
6. `/search встреча` → finds group event
7. `/connect-google` in group → "only in private chat"
8. In DM: `/today` still shows personal calendar
