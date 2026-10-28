> Part 1 of 2 of [Group Commands Implementation Plan](../2026-03-18-group-commands.md) — next: [02-tasks-6-12.md](02-tasks-6-12.md)

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

