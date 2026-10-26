> Part 2 of 3 of [STT Corrections Dictionary Implementation Plan](../2026-03-21-stt-corrections.md) — previous: [01-overview-tasks-1-3.md](01-overview-tasks-1-3.md) · next: [03-task-8.md](03-task-8.md)

## Task 4: CallSession Integration

**Files:**
- Modify: `src/services/voice/call-session.ts`
- Modify: `src/index.ts`
- Modify: `test/services/voice/call-session.test.ts`

- [ ] **Step 1: Add failing tests**

In `test/services/voice/call-session.test.ts`, add tests for enricher wiring:

```ts
test('onEnoughToRespond enriches transcript with corrections', async () => {
  // Build a session with sttCorrectionsRepo that returns one correction
  const corrections = [{ wrong: 'визором', correct: 'виза-ран', isGlobal: true }];
  const mockRepo = {
    findMerged: () => corrections,
    add: () => {},
    delete: () => {},
    findByLevel: () => [],
  };
  let capturedCtx: AgentContext | undefined;
  const cfg = buildTestCfg({
    sttCorrectionsRepo: mockRepo,
    agent: { run: async (ctx) => { capturedCtx = ctx; return {}; } },
  });
  const session = CallSession.create(cfg);
  // simulate VAD_START, Nova final transcript, VAD_END
  await session.handleMessage(JSON.stringify({ type: 'CALL_CONNECTED' }));
  await session.handleMessage(JSON.stringify({ type: 'VAD_START' }));
  cfg.createNovaStt().fireOnFinal('визором', [{ word: 'визором', confidence: 0.41 }]);
  await session.handleMessage(JSON.stringify({ type: 'VAD_END' }));
  await Bun.sleep(10);
  expect(capturedCtx?.messageText).toBe('визором[0.41]');
  expect(capturedCtx?.sttMeta?.corrections[0]?.candidate).toBe('виза-ран');
});

test('lastWords reset on VAD_START', async () => {
  // Verify that a new VAD cycle starts with no words from previous cycle
  // (simulate two VAD cycles, only second cycle's words reach agent)
  // ... test implementation
});
```

> Note: the test file currently uses a `buildTestCfg` helper. Extend it to accept `sttCorrectionsRepo` and verify the enricher path.

- [ ] **Step 2: Run — confirm fails**

```bash
bun test test/services/voice/call-session.test.ts
```

- [ ] **Step 3: Update CallSessionConfig and CallSession**

In `src/services/voice/call-session.ts`:

Add import:
```ts
import { TranscriptEnricher } from './transcript-enricher.ts';
import type { SttCorrectionsRepository } from '../../database/repositories/stt-corrections.repository.ts';
```

Add to `CallSessionConfig`:
```ts
sttCorrectionsRepo?: SttCorrectionsRepository;
```

Add private field to `CallSession`:
```ts
private lastWords: Array<{ word: string; confidence: number }> | undefined;
```

In `onVadStart()`, reset `lastWords`:
```ts
private onVadStart(): void {
  this.lastWords = undefined;  // add this line
  // ... rest unchanged
  if (this.cfg.language === 'ru') {
    this.novaStt = this.cfg.createNovaStt();
    this.novaStt.connect({
      onInterim: (t: string) => this.onNovaInterim(t),
      onFinal: (t: string, words) => {
        this.rollingTranscript = t;
        this.lastWords = words;  // capture words
      },
      // ...
    });
  }
}
```

For Flux (EN), in `onCallConnected()` update `onEndOfTurn`:
```ts
onEndOfTurn: (confidence: number, finalTranscript: string, words) => {
  if (finalTranscript) this.rollingTranscript = finalTranscript;
  this.lastWords = words;  // capture words
  // ...
},
```

Also add reset in `onStartOfTurn` (Flux):
```ts
onStartOfTurn: () => {
  this.lastWords = undefined;
  // ...
},
```

In `onEnoughToRespond()`, replace the `const transcript = this.rollingTranscript;` block:
```ts
const transcript = this.rollingTranscript;
this.rollingTranscript = '';
const words = this.lastWords;
this.lastWords = undefined;

let messageText = transcript;
let sttMeta: import('../ai/types.ts').SttMeta | undefined;

if (this.cfg.sttCorrectionsRepo) {
  const corrections = this.cfg.sttCorrectionsRepo.findMerged(this.cfg.userId);
  const enriched = TranscriptEnricher.enrich({ transcript, words, corrections });
  messageText = enriched.annotated;
  if (enriched.corrections.length > 0 || enriched.lowConfidence.length > 0) {
    sttMeta = { corrections: enriched.corrections, lowConfidence: enriched.lowConfidence };
  }
}

this.runAgent(messageText, sttMeta).catch((err) => {
  voiceLogger.error({ err, sessionId: this.cfg.sessionId }, 'Agent error during call');
});
```

Update `runAgent` signature:
```ts
private async runAgent(transcript: string, sttMeta?: import('../ai/types.ts').SttMeta): Promise<void> {
  // ...
  const ctx = {
    ...(this.cfg.agentContextBase ?? {}),
    user,
    chatId: this.cfg.userId,
    messageText: transcript,
    inputMode: 'live_call',
    isGroup: false,
    sttMeta,
    sttCorrectionsRepo: this.cfg.sttCorrectionsRepo,
  } as AgentContext;
  // ...
}
```

- [ ] **Step 4: Wire sttCorrectionsRepo in src/index.ts**

In the `CallSession.create(...)` call (around line 279), add to `agentContextBase` or directly to config:
```ts
CallSession.create({
  // ...existing fields...
  sttCorrectionsRepo: db.sttCorrections,
  agentContextBase: {
    // ...existing...
    sttCorrectionsRepo: db.sttCorrections,
  },
}),
```

- [ ] **Step 5: Run tests — confirm they pass**

```bash
bun test test/services/voice/call-session.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/services/voice/call-session.ts src/index.ts test/services/voice/call-session.test.ts
git commit -m "feat(stt): wire TranscriptEnricher into CallSession"
```

---

## Task 5: AgentContext Types + System Prompt

**Files:**
- Modify: `src/services/ai/types.ts`
- Modify: `src/services/ai/system-prompt.ts`

- [ ] **Step 1: Add SttMeta and update AgentContext in types.ts**

Add before `AgentContext` interface:
```ts
export interface SttMeta {
  corrections: Array<{ word: string; candidate: string; score: number }>;
  lowConfidence: Array<{ word: string; confidence: number }>;
}
```

Add to `AgentContext` (near the end, before `agentDispatcher`):
```ts
sttMeta?: SttMeta;
sttCorrectionsRepo?: import('../../database/repositories/stt-corrections.repository.ts').SttCorrectionsRepository;
/** Set by dict_add tool when acting user is botAdminId. Caller sends promotion keyboard after turn. */
sttAdminPromotion?: { wrong: string; correct: string };
```

- [ ] **Step 2: Update system-prompt.ts**

In `buildSystemPrompt()`, add STT metadata section. Find where other optional sections are appended (e.g., `eventsWindowSection`) and add:

```ts
let sttMetaSection = '';
if (ctx.sttMeta) {
  const { corrections, lowConfidence } = ctx.sttMeta;
  if (corrections.length > 0 || lowConfidence.length > 0) {
    const lines: string[] = ['STT metadata for this turn:'];
    if (corrections.length > 0) {
      for (const c of corrections) {
        lines.push(`- Possible correction: ${c.word} → ${c.candidate} (score ${c.score.toFixed(2)})`);
      }
    }
    if (lowConfidence.length > 0) {
      const lcList = lowConfidence.map((w) => `${w.word}: ${w.confidence.toFixed(2)}`).join(', ');
      lines.push(`- Low-confidence words: [${lcList}]`);
    }
    lines.push('');
    lines.push(
      'If any of these words seem relevant, consider asking the user to confirm what they meant. Use dict_add to save confirmed corrections.',
    );
    sttMetaSection = `\n${lines.join('\n')}`;
  }
}
```

Include `sttMetaSection` in the returned string.

- [ ] **Step 3: Run all tests — confirm no regression**

```bash
bun test
```

- [ ] **Step 4: Commit**

```bash
git add src/services/ai/types.ts src/services/ai/system-prompt.ts
git commit -m "feat(stt): SttMeta in AgentContext, STT metadata section in system prompt"
```

---

## Task 6: Whisper Path Integration

**Files:**
- Modify: `src/bot/handlers/message.handler.ts`

The Whisper path is `handleVoiceMessage()` (around line 280). After getting `transcription` from `deps.transcriptionService!.transcribe(audioBuffer)`:

- [ ] **Step 1: Add `sttCorrectionsRepo` to MessageHandlerDeps**

Find the `MessageHandlerDeps` interface in `message.handler.ts`. Add:
```ts
sttCorrectionsRepo?: import('../../database/repositories/stt-corrections.repository.ts').SttCorrectionsRepository;
```

- [ ] **Step 2: Wire enricher in handleVoiceMessage**

After the `transcription` check, before building `agentContext`:

```ts
import { TranscriptEnricher } from '../../services/voice/transcript-enricher.ts';
import type { SttMeta } from '../../services/ai/types.ts';

// In handleVoiceMessage, after: const transcription = await deps.transcriptionService!.transcribe(...)
let messageText = transcription;
let sttMeta: SttMeta | undefined;

if (deps.sttCorrectionsRepo) {
  const corrections = deps.sttCorrectionsRepo.findMerged(user.telegram_id);
  const enriched = TranscriptEnricher.enrich({ transcript: transcription, corrections });
  // annotated === transcript for Whisper (no words), but corrections still run
  if (enriched.corrections.length > 0) {
    sttMeta = { corrections: enriched.corrections, lowConfidence: [] };
  }
}

const agentContext: AgentContext = {
  ...buildAgentContextFactory(deps)(user, Number(chatId), messageText),
  inputMode: 'voice_message',
  sttMeta,
  sttCorrectionsRepo: deps.sttCorrectionsRepo,
};
```

- [ ] **Step 3: Wire in bot/index.ts and src/index.ts**

Pass `sttCorrectionsRepo: db.sttCorrections` into the `MessageHandlerDeps` object where `createMessageHandler` is called.

- [ ] **Step 4: Run tests**

```bash
bun test test/bot/handlers/message.handler.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/bot/handlers/message.handler.ts src/bot/index.ts
git commit -m "feat(stt): wire TranscriptEnricher into Whisper voice message path"
```

---

## Task 7: AI Tools (dict_*)

**Files:**
- Modify: `src/services/ai/tools.ts` — add 4 tool schemas
- Create: `src/services/ai/tool-handlers/dict.ts`
- Modify: `src/services/ai/tool-executor.ts`
- Modify: `src/config/constants.ts` — add bilingual strings
- Create: `test/services/ai/tool-handlers/dict.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// test/services/ai/tool-handlers/dict.test.ts
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SttCorrectionsRepository } from '../../../../src/database/repositories/stt-corrections.repository.ts';
import { migrations } from '../../../../src/database/migrations.ts';
import { runMigrations } from '../../../../src/database/schema.ts';
import { handleDictAdd, handleDictDelete, handleDictList, handleDictSearch } from '../../../../src/services/ai/tool-handlers/dict.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';

function makeDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

function makeCtx(userId: number, overrides: Partial<AgentContext> = {}): AgentContext {
  const db = makeDb();
  const repo = new SttCorrectionsRepository(db);
  return {
    user: { telegram_id: userId, language: 'ru' } as never,
    sttCorrectionsRepo: repo,
    ...overrides,
  } as AgentContext;
}

test('dict_add adds entry and returns success', () => {
  const ctx = makeCtx(1);
  const result = handleDictAdd({ wrong: 'визором', correct: 'виза-ран' }, ctx);
  expect(result.success).toBe(true);
  const entries = ctx.sttCorrectionsRepo!.findMerged(1);
  expect(entries).toHaveLength(1);
  expect(entries[0]?.candidate ?? entries[0]?.correct).toBe('виза-ран');
});

test('dict_add sets sttAdminPromotion when user is admin', () => {
  const ctx = makeCtx(42, { botAdminId: 42 });
  handleDictAdd({ wrong: 'тест', correct: 'тест2' }, ctx);
  expect(ctx.sttAdminPromotion).toMatchObject({ wrong: 'тест', correct: 'тест2' });
});

test('dict_add does not set sttAdminPromotion for non-admin', () => {
  const ctx = makeCtx(1, { botAdminId: 99 });
  handleDictAdd({ wrong: 'тест', correct: 'тест2' }, ctx);
  expect(ctx.sttAdminPromotion).toBeUndefined();
});

test('dict_delete removes entry', () => {
  const ctx = makeCtx(1);
  ctx.sttCorrectionsRepo!.add(1, 'питер', 'Петербург');
  const result = handleDictDelete({ wrong: 'питер' }, ctx);
  expect(result.success).toBe(true);
  expect(ctx.sttCorrectionsRepo!.findMerged(1)).toHaveLength(0);
});

test('dict_delete returns error for global entry by non-admin', () => {
  const ctx = makeCtx(1, { botAdminId: 99 });
  ctx.sttCorrectionsRepo!.add(null, 'глобал', 'global');
  // Trying to delete an entry that only exists globally — repo.findByLevel(userId) won't have it
  const result = handleDictDelete({ wrong: 'глобал' }, ctx);
  expect(result.success).toBe(false);
});

test('dict_list returns merged dictionary', () => {
  const ctx = makeCtx(1);
  ctx.sttCorrectionsRepo!.add(null, 'один', 'one');
  ctx.sttCorrectionsRepo!.add(1, 'два', 'two');
  const result = handleDictList({}, ctx);
  expect(result.success).toBe(true);
  expect(result.data).toHaveLength(2);
});

test('dict_search returns top-5 phonetic matches', () => {
  const ctx = makeCtx(1);
  ctx.sttCorrectionsRepo!.add(1, 'питер', 'Санкт-Петербург');
  const result = handleDictSearch({ word: 'питер' }, ctx);
  expect(result.success).toBe(true);
  const data = result.data as { candidate: string }[];
  expect(data[0]?.candidate).toBe('санкт-петербург');
});
```

- [ ] **Step 2: Run — confirm fails**

```bash
bun test test/services/ai/tool-handlers/dict.test.ts
```

- [ ] **Step 3: Add bilingual strings to constants.ts**

In `MSG.ru.aiTools` and `MSG.en.aiTools`, add a `dict` namespace:

```ts
// ru:
dict: {
  added: (wrong: string, correct: string) => `✅ Добавлено: «${wrong}» → «${correct}»`,
  deleted: (wrong: string) => `🗑 Удалено: «${wrong}»`,
  notFound: 'Такое исправление не найдено в личном словаре.',
  globalOnly: 'Это глобальная запись — её может удалять только администратор.',
  listEmpty: 'Словарь пуст.',
  searchEmpty: (word: string) => `Совпадений для «${word}» не найдено.`,
  searchResults: (word: string, count: number) => `Совпадения для «${word}» (${count}):`,
},
// en:
dict: {
  added: (wrong: string, correct: string) => `✅ Added: "${wrong}" → "${correct}"`,
  deleted: (wrong: string) => `🗑 Deleted: "${wrong}"`,
  notFound: 'Entry not found in your personal dictionary.',
  globalOnly: 'This is a global entry — only the admin can delete it.',
  listEmpty: 'Dictionary is empty.',
  searchEmpty: (word: string) => `No matches for "${word}".`,
  searchResults: (word: string, count: number) => `Matches for "${word}" (${count}):`,
},
```

- [ ] **Step 4: Create tool handler**

```ts
// src/services/ai/tool-handlers/dict.ts
import { t } from '../../../config/constants.ts';
import { TranscriptEnricher } from '../../voice/transcript-enricher.ts';
import type { AgentContext, ToolResult } from '../types.ts';

interface DictAddInput { wrong: string; correct: string; }
interface DictDeleteInput { wrong: string; }
interface DictSearchInput { word: string; }

export function handleDictAdd(input: DictAddInput, ctx: AgentContext): ToolResult {
  const repo = ctx.sttCorrectionsRepo;
  if (!repo) return { success: false, error: 'STT corrections not available' };
  const lang = ctx.user.language as 'ru' | 'en';
  repo.add(ctx.user.telegram_id, input.wrong, input.correct);
  if (ctx.botAdminId && ctx.user.telegram_id === ctx.botAdminId) {
    ctx.sttAdminPromotion = { wrong: input.wrong, correct: input.correct };
  }
  return { success: true, output: t(lang).aiTools.dict.added(input.wrong, input.correct) };
}

export function handleDictDelete(input: DictDeleteInput, ctx: AgentContext): ToolResult {
  const repo = ctx.sttCorrectionsRepo;
  if (!repo) return { success: false, error: 'STT corrections not available' };
  const lang = ctx.user.language as 'ru' | 'en';
  const userEntries = repo.findByLevel(ctx.user.telegram_id);
  const has = userEntries.some((e) => e.wrong === input.wrong.trim().toLowerCase());
  if (!has) {
    // Check if it's global-only
    const globalEntries = repo.findByLevel(null);
    const isGlobal = globalEntries.some((e) => e.wrong === input.wrong.trim().toLowerCase());
    if (isGlobal) return { success: false, error: t(lang).aiTools.dict.globalOnly };
    return { success: false, error: t(lang).aiTools.dict.notFound };
  }
  repo.delete(ctx.user.telegram_id, input.wrong);
  return { success: true, output: t(lang).aiTools.dict.deleted(input.wrong) };
}

export function handleDictList(_input: Record<never, never>, ctx: AgentContext): ToolResult {
  const repo = ctx.sttCorrectionsRepo;
  if (!repo) return { success: false, error: 'STT corrections not available' };
  const entries = repo.findMerged(ctx.user.telegram_id);
  return { success: true, data: entries, output: entries.length === 0
    ? t(ctx.user.language as 'ru' | 'en').aiTools.dict.listEmpty
    : entries.map((e) => `${e.wrong} → ${e.correct}${e.isGlobal ? ' [global]' : ''}`).join('\n')
  };
}

export function handleDictSearch(input: DictSearchInput, ctx: AgentContext): ToolResult {
  const repo = ctx.sttCorrectionsRepo;
  if (!repo) return { success: false, error: 'STT corrections not available' };
  const lang = ctx.user.language as 'ru' | 'en';
  const corrections = repo.findMerged(ctx.user.telegram_id);
  const results = TranscriptEnricher.search(input.word, corrections);
  if (results.length === 0) return { success: true, output: t(lang).aiTools.dict.searchEmpty(input.word), data: [] };
  return {
    success: true,
    output: t(lang).aiTools.dict.searchResults(input.word, results.length) + '\n' +
      results.map((r) => `  ${r.word} → ${r.candidate} (${r.score.toFixed(2)})`).join('\n'),
    data: results,
  };
}
```

- [ ] **Step 5: Add tool schemas to tools.ts**

Add four tools near the end of the tool definitions array:

```ts
{
  name: 'dict_search_phonetic',
  description: 'Search the STT corrections dictionary for phonetic matches to a given word. Returns top-5 matches with scores.',
  input_schema: {
    type: 'object',
    properties: {
      word: { type: 'string', description: 'Word or phrase to search for phonetic matches' },
    },
    required: ['word'],
  },
},
{
  name: 'dict_add',
  description: 'Add or update a correction in the user\'s personal STT dictionary. Use after confirming with the user what a word should be.',
  input_schema: {
    type: 'object',
    properties: {
      wrong: { type: 'string', description: 'How the word is typically misrecognized by STT' },
      correct: { type: 'string', description: 'The correct form of the word' },
    },
    required: ['wrong', 'correct'],
  },
},
{
  name: 'dict_delete',
  description: 'Remove a correction from the user\'s personal STT dictionary.',
  input_schema: {
    type: 'object',
    properties: {
      wrong: { type: 'string', description: 'The wrong form of the word to remove' },
    },
    required: ['wrong'],
  },
},
{
  name: 'dict_list',
  description: 'List all corrections in the merged dictionary (global + personal) for the current user.',
  input_schema: { type: 'object', properties: {} },
},
```

- [ ] **Step 6: Wire in tool-executor.ts**

Add import:
```ts
import { handleDictAdd, handleDictDelete, handleDictList, handleDictSearch } from './tool-handlers/dict.ts';
```

Add cases to the switch:
```ts
case 'dict_search_phonetic':
  return handleDictSearch(input as { word: string }, ctx);
case 'dict_add':
  return handleDictAdd(input as { wrong: string; correct: string }, ctx);
case 'dict_delete':
  return handleDictDelete(input as { wrong: string }, ctx);
case 'dict_list':
  return handleDictList({}, ctx);
```

After agent turn in `message.handler.ts` (and call-session.ts), handle admin promotion:

```ts
const { responseText } = await deps.agent.run(agentContext);
// Admin promotion keyboard
if (agentContext.sttAdminPromotion && agentContext.sender?.sendMessageWithKeyboard) {
  const { wrong, correct } = agentContext.sttAdminPromotion;
  const keyboard = new InlineKeyboard()
    .text('Да, для всех', `dict_promote:global:${encodeURIComponent(wrong)}:${encodeURIComponent(correct)}`)
    .text('Только для меня', `dict_promote:skip`);
  agentContext.sender.sendMessageWithKeyboard(
    agentContext.chatId,
    'Сохранить это исправление для всех пользователей?',
    keyboard,
  ).catch((err) => botLogger.error({ err }, 'Failed to send admin promotion keyboard'));
}
```

> `callback_data` must stay ≤ 64 bytes. If `wrong + correct > 40 chars`, store the payload server-side and pass a short ID instead.

- [ ] **Step 7: Run tests — confirm they pass**

```bash
bun test test/services/ai/tool-handlers/dict.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add src/services/ai/tools.ts src/services/ai/tool-handlers/dict.ts src/services/ai/tool-executor.ts src/config/constants.ts test/services/ai/tool-handlers/dict.test.ts
git commit -m "feat(stt): dict_* AI tools with phonetic search, add/delete/list"
```

---

