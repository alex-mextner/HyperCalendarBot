> Part 3 of 3 of [STT Corrections Dictionary Implementation Plan](../2026-03-21-stt-corrections.md) — previous: [02-tasks-4-7.md](02-tasks-4-7.md)

## Task 8: /dict Bot Command

**Files:**
- Create: `src/bot/commands/dict.ts`
- Modify: `src/bot/index.ts`
- Modify: `src/config/constants.ts` — add MSG strings for /dict UI
- Modify: `src/bot/handlers/callback.handler.ts` — handle dict callbacks via ID store
- Modify: `src/bot/handlers/message.handler.ts` — complete edit flow

> **Callback safety:** All callbacks that carry payload (wrong/correct values) use a short opaque ID looked up from an in-memory `DictCallbackStore`. This solves three problems at once: 64-byte limit, unsafe `:` delimiter splitting, and unbounded payload size.
>
> **Edit flow completion:** After `dict:edit` sends a prompt, `dictEditPending` (Map<userId, { wrong, expiry }>) stores the pending state. The message handler checks this map before normal message routing.

- [ ] **Step 1: Add bot message strings to constants.ts**

Add under `MSG.ru` and `MSG.en` (not in `aiTools` — these are direct bot messages):

```ts
// In MSG.ru:
dict_header: '📖 Твой словарь исправлений',
dict_global_section: (n: number) => `🌐 Общий (${n}):`,
dict_user_section: (n: number) => `👤 Твой (${n}):`,
dict_empty: 'Словарь пуст.',
dict_add_prompt: 'Напиши исправление в формате:\nкак слышится → как правильно',
dict_add_correct_prompt: (correct: string) =>
  `Как бот мог расслышать «${correct}» неправильно? Напиши вариант, который получается — например, «визором». Или нажми пропустить.`,
dict_add_skip_btn: 'Пропустить',
dict_saved: (wrong: string, correct: string) => `✅ Сохранено: «${wrong}» → «${correct}»`,
dict_deleted: (wrong: string) => `🗑 Удалено: «${wrong}»`,
dict_select_to_delete: 'Выбери запись для удаления:',
dict_select_to_edit: 'Выбери запись для изменения:',
dict_edit_prompt: (wrong: string) => `Новое значение для «${wrong}»:`,
dict_global_only_notice: 'Это глобальная запись — только администратор может её изменить.',
dict_admin_promote_prompt: 'Сохранить это исправление для всех пользователей?',
dict_promoted_global: '✅ Сохранено для всех пользователей.',

// In MSG.en: (mirror with English text)
```

- [ ] **Step 2: Create dict command handler with DictCallbackStore**

```ts
// src/bot/commands/dict.ts
import { InlineKeyboard } from 'gramio';
import type { SttCorrectionsRepository } from '../../database/repositories/stt-corrections.repository.ts';
import { t } from '../../config/constants.ts';
import { splitMessage } from '../../utils/telegram.ts';
import type { User } from '../../database/types.ts';

// ---------------------------------------------------------------------------
// Callback ID store — avoids 64-byte limit and colon-parsing issues
// ---------------------------------------------------------------------------

type DictCallbackPayload =
  | { type: 'del'; wrong: string }
  | { type: 'edit'; wrong: string }
  | { type: 'skip'; correct: string }
  | { type: 'promote'; wrong: string; correct: string };

let _seq = 0;
const _store = new Map<string, DictCallbackPayload>();

export function storeDictPayload(payload: DictCallbackPayload): string {
  const id = (++_seq).toString(36); // 'dict:del:1a' is always ≤ 20 bytes
  _store.set(id, payload);
  return id;
}

export function getDictPayload(id: string): DictCallbackPayload | undefined {
  return _store.get(id);
}

// ---------------------------------------------------------------------------
// Pending state — Map<userId, { ... }>
// Two modes: edit (waiting for new correct value) and add (waiting for "wrong → correct")
// ---------------------------------------------------------------------------

const PENDING_TTL_MS = 5 * 60 * 1000;

interface EditPending { mode: 'edit'; wrong: string; expiry: number }
interface AddPending  { mode: 'add';  expiry: number }
type DictPending = EditPending | AddPending;

const _pending = new Map<number, DictPending>();

export function setEditPending(userId: number, wrong: string): void {
  _pending.set(userId, { mode: 'edit', wrong, expiry: Date.now() + PENDING_TTL_MS });
}

export function setAddPending(userId: number): void {
  _pending.set(userId, { mode: 'add', expiry: Date.now() + PENDING_TTL_MS });
}

export function consumePending(userId: number): DictPending | undefined {
  const entry = _pending.get(userId);
  if (!entry) return undefined;
  if (Date.now() > entry.expiry) { _pending.delete(userId); return undefined; }
  _pending.delete(userId);
  return entry;
}

// Keep old name as alias for callers that only deal with edit
export function consumeEditPending(userId: number): string | undefined {
  const p = consumePending(userId);
  return p?.mode === 'edit' ? p.wrong : undefined;
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

export interface DictCommandDeps {
  sttCorrectionsRepo: SttCorrectionsRepository;
}

export async function handleDictList(
  ctx: { user: User; send: (text: string, opts?: unknown) => Promise<unknown> },
  deps: DictCommandDeps,
): Promise<void> {
  const lang = ctx.user.language as 'ru' | 'en';
  const msgs = t(lang);
  const userId = ctx.user.telegram_id;
  const global_ = deps.sttCorrectionsRepo.findByLevel(null);
  const personal = deps.sttCorrectionsRepo.findByLevel(userId);
  const lines: string[] = [msgs.dict_header];

  if (global_.length > 0) {
    lines.push('');
    lines.push(msgs.dict_global_section(global_.length));
    for (const e of global_) lines.push(`  • ${e.wrong} → ${e.correct}`);
  }
  if (personal.length > 0) {
    lines.push('');
    lines.push(msgs.dict_user_section(personal.length));
    for (const e of personal) lines.push(`  • ${e.wrong} → ${e.correct}`);
  }
  if (global_.length === 0 && personal.length === 0) {
    lines.push('');
    lines.push(msgs.dict_empty);
  }

  const keyboard = new InlineKeyboard()
    .text('+ Добавить', 'dict:add')
    .text('🗑 Удалить', 'dict:del_list')
    .text('✏️ Изменить', 'dict:edit_list');

  const text = lines.join('\n');
  const parts = splitMessage(text);
  for (const part of parts) {
    await ctx.send(part);
  }
  await ctx.send(msgs.dict_header, { reply_markup: keyboard });
}

// /dict <correct>
export async function handleDictAddCorrect(
  correct: string,
  ctx: { user: User; send: (text: string, opts?: unknown) => Promise<unknown> },
): Promise<void> {
  const lang = ctx.user.language as 'ru' | 'en';
  const msgs = t(lang);
  const id = storeDictPayload({ type: 'skip', correct });
  const keyboard = new InlineKeyboard().text(msgs.dict_add_skip_btn, `dict:skip:${id}`);
  await ctx.send(msgs.dict_add_correct_prompt(correct), { reply_markup: keyboard });
}

// /dict <wrong> -> <correct>
export async function handleDictAddDirect(
  wrong: string,
  correct: string,
  ctx: { user: User; send: (text: string, opts?: unknown) => Promise<unknown>; botAdminId?: number },
  deps: DictCommandDeps,
): Promise<void> {
  const lang = ctx.user.language as 'ru' | 'en';
  const msgs = t(lang);
  const userId = ctx.user.telegram_id;
  deps.sttCorrectionsRepo.add(userId, wrong, correct);
  await ctx.send(msgs.dict_saved(wrong, correct));

  if (ctx.botAdminId && userId === ctx.botAdminId) {
    const id = storeDictPayload({ type: 'promote', wrong, correct });
    const keyboard = new InlineKeyboard()
      .text('Да, для всех', `dict:p:${id}`)
      .text('Только для меня', 'dict:pskip');
    await ctx.send(msgs.dict_admin_promote_prompt, { reply_markup: keyboard });
  }
}

// Called from message.handler.ts when user is in edit pending state
export async function completeEditFlow(
  userId: number,
  wrong: string,
  newCorrect: string,
  ctx: { send: (text: string, opts?: unknown) => Promise<unknown>; botAdminId?: number; lang: 'ru' | 'en' },
  deps: DictCommandDeps,
): Promise<void> {
  const msgs = t(ctx.lang);
  deps.sttCorrectionsRepo.add(userId, wrong, newCorrect);
  await ctx.send(msgs.dict_saved(wrong, newCorrect));

  if (ctx.botAdminId && userId === ctx.botAdminId) {
    const id = storeDictPayload({ type: 'promote', wrong, correct: newCorrect });
    const keyboard = new InlineKeyboard()
      .text('Да, для всех', `dict:p:${id}`)
      .text('Только для меня', 'dict:pskip');
    await ctx.send(msgs.dict_admin_promote_prompt, { reply_markup: keyboard });
  }
}
```

- [ ] **Step 3: Register /dict command in bot/index.ts**

```ts
import { handleDictList, handleDictAddCorrect, handleDictAddDirect } from './commands/dict.ts';

bot.command('dict', async (ctx) => {
  const user = ctx.user as User;
  const args = ctx.args?.trim() ?? '';
  const send = (text: string, opts?: unknown) => ctx.send(text, opts as never);

  if (!args) {
    await handleDictList({ user, send }, { sttCorrectionsRepo: db.sttCorrections });
    return;
  }

  // /dict <wrong> -> <correct>
  const arrowMatch = args.match(/^(.+?)\s*->\s*(.+)$/);
  if (arrowMatch) {
    await handleDictAddDirect(
      arrowMatch[1]!.trim(), arrowMatch[2]!.trim(),
      { user, send, botAdminId: config.BOT_ADMIN_ID ? Number(config.BOT_ADMIN_ID) : undefined },
      { sttCorrectionsRepo: db.sttCorrections },
    );
    return;
  }

  // /dict <correct>
  await handleDictAddCorrect(args, { user, send });
});
```

- [ ] **Step 4: Handle callbacks in callback.handler.ts**

All payloads go through `getDictPayload(id)` — no raw values in callback_data, no colon-splitting:

```ts
import { completeEditFlow, consumePending, getDictPayload, setAddPending, setEditPending, storeDictPayload } from '../commands/dict.ts';

// dict:add — show prompt, set add-pending state
if (data === 'dict:add') {
  setAddPending(user.telegram_id);
  await ctx.send(msgs.dict_add_prompt);
  await ctx.answer();
  return;
}

// dict:del_list
if (data === 'dict:del_list') {
  const entries = db.sttCorrections.findByLevel(user.telegram_id);
  if (entries.length === 0) { await ctx.answer(); return; }
  const kb = new InlineKeyboard();
  for (const e of entries.slice(0, 20)) {
    const id = storeDictPayload({ type: 'del', wrong: e.wrong });
    kb.text(`${e.wrong} → ${e.correct}`, `dict:del:${id}`).row();
  }
  await ctx.send(msgs.dict_select_to_delete, { reply_markup: kb });
  await ctx.answer();
  return;
}

// dict:del:<id>
if (data.startsWith('dict:del:')) {
  const payload = getDictPayload(data.slice('dict:del:'.length));
  if (payload?.type === 'del') {
    db.sttCorrections.delete(user.telegram_id, payload.wrong);
    await ctx.send(msgs.dict_deleted(payload.wrong));
  }
  await ctx.answer();
  return;
}

// dict:edit_list
if (data === 'dict:edit_list') {
  const entries = db.sttCorrections.findByLevel(user.telegram_id);
  if (entries.length === 0) { await ctx.answer(); return; }
  const kb = new InlineKeyboard();
  for (const e of entries.slice(0, 20)) {
    const id = storeDictPayload({ type: 'edit', wrong: e.wrong });
    kb.text(`${e.wrong} → ${e.correct}`, `dict:edit:${id}`).row();
  }
  await ctx.send(msgs.dict_select_to_edit, { reply_markup: kb });
  await ctx.answer();
  return;
}

// dict:edit:<id> — store pending state, send prompt
if (data.startsWith('dict:edit:')) {
  const payload = getDictPayload(data.slice('dict:edit:'.length));
  if (payload?.type === 'edit') {
    setEditPending(user.telegram_id, payload.wrong);
    await ctx.send(msgs.dict_edit_prompt(payload.wrong));
  }
  await ctx.answer();
  return;
}

// dict:skip:<id> — save wrong=correct (hint-only)
if (data.startsWith('dict:skip:')) {
  const payload = getDictPayload(data.slice('dict:skip:'.length));
  if (payload?.type === 'skip') {
    db.sttCorrections.add(user.telegram_id, payload.correct, payload.correct);
    await ctx.send(msgs.dict_saved(payload.correct, payload.correct));
  }
  await ctx.answer();
  return;
}

// dict:p:<id> — admin promote to global
if (data.startsWith('dict:p:')) {
  const payload = getDictPayload(data.slice('dict:p:'.length));
  if (payload?.type === 'promote') {
    db.sttCorrections.add(null, payload.wrong, payload.correct);
    await ctx.send(msgs.dict_promoted_global);
  }
  await ctx.answer();
  return;
}

if (data === 'dict:pskip') {
  await ctx.answer();
  return;
}
```

- [ ] **Step 5: Wire pending dict state in message.handler.ts**

At the top of the text message handler (before normal routing):

```ts
import { completeEditFlow, consumePending, handleDictAddCorrect, handleDictAddDirect } from '../commands/dict.ts';

// In message handler, before normal pipeline — check dict pending state:
if (messageText && deps.sttCorrectionsRepo) {
  const pending = consumePending(user.telegram_id);
  if (pending) {
    const send = (text: string, opts?: unknown) => ctx.send(text, opts as never);
    const lang = user.language as 'ru' | 'en';
    const botAdminId = deps.botAdminId;
    const dictDeps = { sttCorrectionsRepo: deps.sttCorrectionsRepo };

    if (pending.mode === 'edit') {
      // User typed new correct value for pending.wrong
      await completeEditFlow(user.telegram_id, pending.wrong, messageText, { send, botAdminId, lang }, dictDeps);
    } else {
      // pending.mode === 'add': parse "wrong → correct" or treat as correct-only
      const arrowMatch = messageText.match(/^(.+?)\s*(?:->|→)\s*(.+)$/);
      if (arrowMatch) {
        await handleDictAddDirect(
          arrowMatch[1]!.trim(), arrowMatch[2]!.trim(),
          { user, send, botAdminId },
          dictDeps,
        );
      } else {
        // Single word: ask for the wrong form (same as /dict <correct>)
        await handleDictAddCorrect(messageText.trim(), { user, send });
      }
    }
    return; // consumed — skip normal pipeline
  }
}
```

Also add `botAdminId?: number` to `MessageHandlerDeps` and pass `Number(config.BOT_ADMIN_ID)` when constructing deps.

- [ ] **Step 6: Wire admin promotion after dict_add AI tool**

In `message.handler.ts` after `deps.agent.run(agentContext)`:

```ts
if (agentContext.sttAdminPromotion && agentContext.sender?.sendMessageWithKeyboard) {
  const { wrong, correct } = agentContext.sttAdminPromotion;
  const id = storeDictPayload({ type: 'promote', wrong, correct });
  const keyboard = new InlineKeyboard()
    .text('Да, для всех', `dict:p:${id}`)
    .text('Только для меня', 'dict:pskip');
  agentContext.sender.sendMessageWithKeyboard(
    agentContext.chatId,
    t(agentContext.user.language as 'ru' | 'en').dict_admin_promote_prompt,
    keyboard,
  ).catch((err) => botLogger.error({ err }, 'Failed to send admin promotion keyboard'));
}
```

Same block goes in `call-session.ts` `runAgent()` after `this.cfg.agent.run(ctx)`.

- [ ] **Step 7: Write tests for dict.ts pending state and message handler integration**

Two test files:

**`test/bot/commands/dict.test.ts`** — unit tests for pending state and handlers:

```ts
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  completeEditFlow,
  consumePending,
  getDictPayload,
  handleDictAddCorrect,
  handleDictAddDirect,
  handleDictList,
  setAddPending,
  setEditPending,
  storeDictPayload,
} from '../../../src/bot/commands/dict.ts';
import { SttCorrectionsRepository } from '../../../src/database/repositories/stt-corrections.repository.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import type { User } from '../../../src/database/types.ts';

function makeDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

function makeUser(id = 1): User {
  return { telegram_id: id, language: 'ru' } as User;
}

describe('DictCallbackStore', () => {
  test('storeDictPayload + getDictPayload round-trips payload', () => {
    const id = storeDictPayload({ type: 'del', wrong: 'визором' });
    expect(id.length).toBeLessThanOrEqual(10); // always short
    expect(getDictPayload(id)).toMatchObject({ type: 'del', wrong: 'визором' });
  });

  test('callback ID fits within 64-byte limit for all types', () => {
    const payloads = [
      { type: 'del' as const, wrong: 'предположительно' },
      { type: 'edit' as const, wrong: 'предположительно' },
      { type: 'skip' as const, correct: 'очень длинное исправление которое не влезет' },
      { type: 'promote' as const, wrong: 'длинное слово', correct: 'другое длинное слово' },
    ] satisfies Parameters<typeof storeDictPayload>[0][];

    for (const payload of payloads) {
      const id = storeDictPayload(payload);
      const prefix = payload.type === 'del' ? 'dict:del:' :
                     payload.type === 'edit' ? 'dict:edit:' :
                     payload.type === 'skip' ? 'dict:skip:' : 'dict:p:';
      const callbackData = `${prefix}${id}`;
      expect(Buffer.byteLength(callbackData, 'utf8')).toBeLessThanOrEqual(64);
    }
  });
});

describe('pending state', () => {
  test('consumePending returns undefined when nothing pending', () => {
    expect(consumePending(9999)).toBeUndefined();
  });

  test('setAddPending + consumePending returns add entry', () => {
    setAddPending(1);
    const p = consumePending(1);
    expect(p?.mode).toBe('add');
  });

  test('setEditPending + consumePending returns edit entry with wrong', () => {
    setEditPending(2, 'визором');
    const p = consumePending(2);
    expect(p?.mode).toBe('edit');
    if (p?.mode === 'edit') expect(p.wrong).toBe('визором');
  });

  test('consumePending removes the entry (one-shot)', () => {
    setAddPending(3);
    consumePending(3);
    expect(consumePending(3)).toBeUndefined();
  });

  test('edit pending expires after TTL', () => {
    const original = Date.now;
    try {
      setEditPending(4, 'тест');
      Date.now = () => original() + 6 * 60 * 1000; // 6 min later
      expect(consumePending(4)).toBeUndefined();
    } finally {
      Date.now = original;
    }
  });
});

describe('handleDictAddDirect', () => {
  let db: Database;
  let repo: SttCorrectionsRepository;

  beforeEach(() => { db = makeDb(); repo = new SttCorrectionsRepository(db); });
  afterEach(() => db.close());

  test('saves entry and confirms', async () => {
    const sent: string[] = [];
    const send = mock((text: string) => { sent.push(text); return Promise.resolve(); });
    await handleDictAddDirect('питер', 'Санкт-Петербург', { user: makeUser(1), send }, { sttCorrectionsRepo: repo });
    expect(repo.findMerged(1)).toHaveLength(1);
    expect(sent[0]).toContain('Сохранено');
  });

  test('shows admin promotion keyboard when user is admin', async () => {
    const keyboards: unknown[] = [];
    const send = mock((_, opts?: unknown) => { if (opts) keyboards.push(opts); return Promise.resolve(); });
    await handleDictAddDirect(
      'питер', 'Санкт-Петербург',
      { user: makeUser(42), send, botAdminId: 42 },
      { sttCorrectionsRepo: repo },
    );
    expect(keyboards.length).toBe(1);
  });

  test('no admin keyboard for non-admin user', async () => {
    const keyboards: unknown[] = [];
    const send = mock((_, opts?: unknown) => { if (opts) keyboards.push(opts); return Promise.resolve(); });
    await handleDictAddDirect(
      'питер', 'Санкт-Петербург',
      { user: makeUser(1), send, botAdminId: 99 },
      { sttCorrectionsRepo: repo },
    );
    expect(keyboards.length).toBe(0);
  });
});

describe('handleDictAddCorrect', () => {
  test('sends prompt with skip button', async () => {
    const sent: string[] = [];
    const keyboards: unknown[] = [];
    const send = mock((text: string, opts?: unknown) => {
      sent.push(text);
      if (opts) keyboards.push(opts);
      return Promise.resolve();
    });
    await handleDictAddCorrect('виза-ран', { user: makeUser(), send });
    expect(sent[0]).toContain('виза-ран');
    expect(keyboards.length).toBe(1);
  });
});

describe('completeEditFlow', () => {
  let db: Database;
  let repo: SttCorrectionsRepository;

  beforeEach(() => { db = makeDb(); repo = new SttCorrectionsRepository(db); });
  afterEach(() => db.close());

  test('saves new correct value', async () => {
    const send = mock(() => Promise.resolve());
    repo.add(1, 'питер', 'старое');
    await completeEditFlow(1, 'питер', 'Санкт-Петербург', { send, lang: 'ru' }, { sttCorrectionsRepo: repo });
    expect(repo.findMerged(1)[0]?.correct).toBe('санкт-петербург');
  });
});

describe('handleDictList', () => {
  let db: Database;
  let repo: SttCorrectionsRepository;

  beforeEach(() => { db = makeDb(); repo = new SttCorrectionsRepository(db); });
  afterEach(() => db.close());

  test('shows empty message when dictionary is empty', async () => {
    const sent: string[] = [];
    const send = mock((text: string) => { sent.push(text); return Promise.resolve(); });
    await handleDictList({ user: makeUser(), send }, { sttCorrectionsRepo: repo });
    expect(sent.some((s) => s.includes('пуст'))).toBe(true);
  });

  test('shows global and personal sections', async () => {
    repo.add(null, 'один', 'one');
    repo.add(1, 'два', 'two');
    const sent: string[] = [];
    const send = mock((text: string) => { sent.push(text); return Promise.resolve(); });
    await handleDictList({ user: makeUser(), send }, { sttCorrectionsRepo: repo });
    const all = sent.join('\n');
    expect(all).toContain('Общий');
    expect(all).toContain('Твой');
  });
});
```

**Additions to `test/bot/handlers/message.handler.test.ts`** — pending state integration:

```ts
// Add these tests inside the existing describe('createMessageHandler') block.
// They need sttCorrectionsRepo in deps and dictEditPending/setAddPending imported.
import { setAddPending, setEditPending } from '../../../src/bot/commands/dict.ts';
import { Database } from 'bun:sqlite';
import { SttCorrectionsRepository } from '../../../src/database/repositories/stt-corrections.repository.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { runMigrations } from '../../../src/database/schema.ts';

function makeRepoDb() {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  return { db, repo: new SttCorrectionsRepository(db) };
}

test('dict add pending: arrow format saves entry without calling agent', async () => {
  const { db, repo } = makeRepoDb();
  const deps = makeDeps({ sttCorrectionsRepo: repo });
  const handler = createMessageHandler(deps as never);
  setAddPending(100); // user 100 has add pending
  await handler(makeCtx({ text: 'питер → Санкт-Петербург' }) as never);
  expect(deps.agent.run).not.toHaveBeenCalled();
  expect(repo.findMerged(100)).toHaveLength(1);
  db.close();
});

test('dict add pending: single word prompts for wrong form, skips agent', async () => {
  const { db, repo } = makeRepoDb();
  const sent: string[] = [];
  const deps = makeDeps({ sttCorrectionsRepo: repo });
  const handler = createMessageHandler(deps as never);
  setAddPending(100);
  await handler(makeCtx({ send: mock((t: string) => { sent.push(t); return Promise.resolve(); }), text: 'виза-ран' }) as never);
  expect(deps.agent.run).not.toHaveBeenCalled();
  // handleDictAddCorrect sends a prompt containing the word
  expect(sent.some((s) => s.includes('виза-ран'))).toBe(true);
  db.close();
});

test('dict edit pending: saves new value without calling agent', async () => {
  const { db, repo } = makeRepoDb();
  repo.add(100, 'питер', 'старое');
  const deps = makeDeps({ sttCorrectionsRepo: repo });
  const handler = createMessageHandler(deps as never);
  setEditPending(100, 'питер');
  await handler(makeCtx({ text: 'Санкт-Петербург' }) as never);
  expect(deps.agent.run).not.toHaveBeenCalled();
  expect(repo.findMerged(100)[0]?.correct).toBe('санкт-петербург');
  db.close();
});

test('no pending state: message routes normally to agent', async () => {
  const { db, repo } = makeRepoDb();
  const deps = makeDeps({ sttCorrectionsRepo: repo });
  const handler = createMessageHandler(deps as never);
  // no setAddPending / setEditPending called
  await handler(makeCtx({ text: 'обычное сообщение' }) as never);
  expect(deps.agent.run).toHaveBeenCalledTimes(1);
  db.close();
});
```

- [ ] **Step 8: Run tests — confirm they pass**

```bash
bun test test/bot/commands/dict.test.ts test/bot/handlers/message.handler.test.ts
```
Expected: all pass. Fix any issues with imports or missing exports before committing.

- [ ] **Step 9: Run all tests**

```bash
bun test
bun run lint
```
Fix any lint warnings before committing.

- [ ] **Step 8: Commit**

```bash
git add src/bot/commands/dict.ts src/bot/index.ts src/bot/handlers/callback.handler.ts src/bot/handlers/message.handler.ts src/config/constants.ts
git commit -m "feat(stt): /dict bot command with safe ID-based callbacks, edit flow, admin promotion"
```

---

## Final Verification

- [ ] Run full test suite and confirm green:
```bash
bun test --coverage
```
Expected: ≥ 93% line coverage, 0 failures.

- [ ] Run linter:
```bash
bun run lint
```
Expected: 0 warnings, 0 errors.

- [ ] Manual smoke test (if bot is running):
  1. `/dict` — see empty dictionary
  2. `/dict Санкт-Петербург` — bot asks for wrong form
  3. `/dict питер -> Санкт-Петербург` — saves directly
  4. `/dict` — entry appears in "Твой" section
  5. Send voice message saying "питер" — agent should see correction candidate in sttMeta
