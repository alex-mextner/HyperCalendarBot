# Chat History Summarization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent context overflow on any AI provider by summarizing chat history before feeding it to the model — trimming individual oversized messages and collapsing old history into a compact summary when total tokens exceed the budget.

**Architecture:** Two-layer reduction applied in `CalendarBotAgent.run()` after `buildMessages()`.
Layer 1 (per-message): each message whose content exceeds 600 chars is summarized individually via the fast AI chain; the result is cached in Redis by DB row ID so repeated requests don't re-summarize.
Layer 2 (full-history): after per-message reduction, if total estimated tokens still exceed `HISTORY_TOKEN_BUDGET`, the oldest messages are collapsed into a single compact summary block and replaced, keeping only the 5 most recent messages verbatim.
Both layers fail gracefully (truncation / drop-to-recent) if the fast AI chain is unavailable.

**Tech Stack:** Bun, TypeScript, `bun:test`, `aiStreamRound` (fast chain, `fast: true`), `Bun.RedisClient`, Biome

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Create | `src/utils/token-estimate.ts` | Char-based token estimator |
| Create | `src/services/ai/history-summarizer.ts` | Per-message + full-history condensation with Redis cache |
| Modify | `src/services/ai/types.ts` | Add `summarizer?: HistorySummarizer` to `AgentConfig` |
| Modify | `src/services/ai/agent.ts` | Make `buildMessages()` async; call summarizer in `run()` |
| Modify | `src/index.ts` | Create `HistorySummarizer` with Redis and inject into agent |
| Create | `test/utils/token-estimate.test.ts` | Unit tests for estimator |
| Create | `test/services/ai/history-summarizer.test.ts` | Unit tests for summarizer |

---

### Task 1: Token estimator utility

**Files:**
- Create: `src/utils/token-estimate.ts`
- Create: `test/utils/token-estimate.test.ts`

- [x] **Step 1: Write failing tests**

Create `test/utils/token-estimate.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { estimateMessageListTokens, estimateTokens } from '../../src/utils/token-estimate.ts';

describe('estimateTokens', () => {
  test('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  test('estimates English text — ceil(11/3.5) = 4', () => {
    expect(estimateTokens('Hello world')).toBe(4);
  });

  test('exact multiple — 350 chars = 100 tokens', () => {
    expect(estimateTokens('a'.repeat(350))).toBe(100);
  });

  test('rounds up — 10 chars = ceil(2.857) = 3', () => {
    expect(estimateTokens('1234567890')).toBe(3);
  });
});

describe('estimateMessageListTokens', () => {
  test('sums content across messages', () => {
    const msgs = [
      { role: 'user' as const, content: 'a'.repeat(350) },    // 100 tokens
      { role: 'assistant' as const, content: 'b'.repeat(70) }, // ceil(20) = 20 tokens
    ];
    expect(estimateMessageListTokens(msgs)).toBe(120);
  });

  test('handles null content (tool_calls message)', () => {
    const msgs = [
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: [{ id: 'x', type: 'function' as const, function: { name: 'f', arguments: '{}' } }],
      },
    ];
    expect(estimateMessageListTokens(msgs)).toBe(0);
  });

  test('returns 0 for empty list', () => {
    expect(estimateMessageListTokens([])).toBe(0);
  });
});
```

- [x] **Step 2: Run — verify fails**

```bash
bun test test/utils/token-estimate.test.ts 2>&1 | tail -10
```

Expected: Cannot find module or FAIL.

- [x] **Step 3: Implement `src/utils/token-estimate.ts`**

```typescript
import type OpenAI from 'openai';

const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

type MessageParam = OpenAI.ChatCompletionMessageParam;

function extractContent(msg: MessageParam): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (typeof block === 'object' && block !== null && 'text' in block && typeof block.text === 'string')
          return block.text;
        return '';
      })
      .join('');
  }
  return '';
}

export function estimateMessageListTokens(messages: MessageParam[]): number {
  return messages.reduce((sum, msg) => sum + estimateTokens(extractContent(msg)), 0);
}
```

- [x] **Step 4: Run — verify passes**

```bash
bun test test/utils/token-estimate.test.ts 2>&1 | tail -10
```

Expected: all tests PASS.

- [x] **Step 5: Commit**

```bash
git add src/utils/token-estimate.ts test/utils/token-estimate.test.ts
git commit -m "feat(utils): add token estimator for history budget management"
```

---

### Task 2: HistorySummarizer — per-message condensation

**Files:**
- Create: `src/services/ai/history-summarizer.ts`
- Create: `test/services/ai/history-summarizer.test.ts`

The class accepts an optional `RedisLike` for caching and a `StreamFn` for the actual AI call. Summarization only triggers when content exceeds `PER_MSG_CHARS_LIMIT`. Failures fall back to truncation — never throw.

- [x] **Step 1: Write failing tests for condenseMessage**

Create `test/services/ai/history-summarizer.test.ts`:

```typescript
import { describe, expect, mock, test } from 'bun:test';
import type { StreamRoundResult } from '../../../src/services/ai/streaming.ts';
import { HistorySummarizer, PER_MSG_CHARS_LIMIT } from '../../../src/services/ai/history-summarizer.ts';

const shortContent = 'short message';
const longContent = 'x'.repeat(PER_MSG_CHARS_LIMIT + 1);

function makeStreamResult(text: string): StreamRoundResult {
  return {
    text,
    toolCalls: [],
    finishReason: 'stop',
    assistantMessage: { role: 'assistant', content: text },
    providerUsed: 'mock',
  };
}

describe('HistorySummarizer.condenseMessage', () => {
  test('returns short content unchanged without calling AI', async () => {
    const mockStream = mock(async () => makeStreamResult('should not be called'));
    const s = new HistorySummarizer(null, mockStream);
    const result = await s.condenseMessage(1, 'tool', shortContent);
    expect(result).toBe(shortContent);
    expect(mockStream).not.toHaveBeenCalled();
  });

  test('summarizes long content via fast AI chain', async () => {
    const mockStream = mock(async () => makeStreamResult('summary text'));
    const s = new HistorySummarizer(null, mockStream);
    const result = await s.condenseMessage(2, 'tool', longContent);
    expect(result).toBe('summary text');
    expect(mockStream).toHaveBeenCalledTimes(1);
    // verify it used fast: true
    const callArgs = mockStream.mock.calls[0] as unknown as [{ fast?: boolean }, unknown];
    expect(callArgs[0].fast).toBe(true);
  });

  test('truncates with ellipsis when AI call fails', async () => {
    const mockStream = mock(async () => { throw new Error('AI unavailable'); });
    const s = new HistorySummarizer(null, mockStream);
    const result = await s.condenseMessage(3, 'tool', longContent);
    expect(result).toContain('[…]');
    expect(result.length).toBeLessThanOrEqual(PER_MSG_CHARS_LIMIT + 5);
  });

  test('caches summarized result in Redis by row ID', async () => {
    const store = new Map<string, string>();
    const redis = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string, _exMode?: string, _ttl?: string) => { store.set(k, v); },
    };
    const mockStream = mock(async () => makeStreamResult('cached summary'));
    const s = new HistorySummarizer(redis, mockStream);

    const first = await s.condenseMessage(4, 'tool', longContent);
    const second = await s.condenseMessage(4, 'tool', longContent);

    expect(first).toBe('cached summary');
    expect(second).toBe('cached summary');
    expect(mockStream).toHaveBeenCalledTimes(1); // second call hits cache
  });
});
```

- [x] **Step 2: Run — verify fails**

```bash
bun test test/services/ai/history-summarizer.test.ts 2>&1 | tail -15
```

Expected: Cannot find module or missing export FAIL.

- [x] **Step 3: Implement `src/services/ai/history-summarizer.ts`**

```typescript
import type OpenAI from 'openai';
import { logger } from '../../utils/logger.ts';
import { estimateMessageListTokens } from '../../utils/token-estimate.ts';
import type { aiStreamRound } from './streaming.ts';

const histLogger = logger.child({ module: 'history-summarizer' });

export const PER_MSG_CHARS_LIMIT = 600;
export const HISTORY_TOKEN_BUDGET = 6000;
const SUMMARY_CACHE_TTL_SECS = 86400; // 24 hours
const RECENT_KEEP = 5;

type MessageParam = OpenAI.ChatCompletionMessageParam;
type StreamFn = typeof aiStreamRound;

interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, exMode?: string, ttl?: string): Promise<unknown>;
}

const perMsgCacheKey = (id: number) => `hist:sum:msg:${id}`;

export class HistorySummarizer {
  constructor(
    private redis: RedisLike | null,
    private streamFn: StreamFn,
  ) {}

  /**
   * Summarize a single history message content if it exceeds PER_MSG_CHARS_LIMIT.
   * Cached by DB row ID — same row is never re-summarized.
   * On AI failure: truncate to PER_MSG_CHARS_LIMIT with a '[…]' marker.
   */
  async condenseMessage(rowId: number, role: string, content: string): Promise<string> {
    if (content.length <= PER_MSG_CHARS_LIMIT) return content;

    const cacheKey = perMsgCacheKey(rowId);
    if (this.redis) {
      const cached = await this.redis.get(cacheKey).catch(() => null);
      if (cached) return cached;
    }

    try {
      const result = await this.streamFn(
        {
          messages: [
            {
              role: 'user',
              content:
                `Summarize this ${role} message from a calendar bot conversation in 1-3 sentences. ` +
                `Keep all key facts: event names, times, dates, IDs, error messages. Reply with the summary only.\n\n` +
                content.slice(0, 3000),
            },
          ],
          maxTokens: 256,
          temperature: 0,
          fast: true,
        },
        {},
      );

      const summary = result.text.trim();

      if (this.redis) {
        await this.redis
          .set(cacheKey, summary, 'EX', String(SUMMARY_CACHE_TTL_SECS))
          .catch((err) => histLogger.warn({ err }, 'Redis set failed for per-message summary'));
      }

      return summary;
    } catch (err) {
      histLogger.warn({ err, rowId }, 'Per-message summarization failed — truncating');
      return `${content.slice(0, PER_MSG_CHARS_LIMIT)}[…]`;
    }
  }

  /**
   * Condense the full message list if total estimated tokens exceed HISTORY_TOKEN_BUDGET.
   * Keeps the RECENT_KEEP most recent messages verbatim; collapses everything older into
   * a single compact summary block inserted as a user message at the head of the list.
   * On AI failure: drops old messages, returns only the most recent RECENT_KEEP.
   */
  async condenseHistory(messages: MessageParam[]): Promise<MessageParam[]> {
    const total = estimateMessageListTokens(messages);
    if (total <= HISTORY_TOKEN_BUDGET) return messages;

    histLogger.info({ total, budget: HISTORY_TOKEN_BUDGET }, 'History over token budget — condensing');

    if (messages.length <= RECENT_KEEP) return messages;

    const older = messages.slice(0, messages.length - RECENT_KEEP);
    const recent = messages.slice(messages.length - RECENT_KEEP);

    const olderText = older
      .map((m) => {
        const content = typeof m.content === 'string' ? m.content.slice(0, 300) : '[structured message]';
        return `[${m.role}]: ${content}`;
      })
      .join('\n');

    try {
      const result = await this.streamFn(
        {
          messages: [
            {
              role: 'user',
              content:
                `Summarize this older portion of a calendar bot conversation in 3-6 bullet points. ` +
                `Preserve all event names, dates, times, IDs, user preferences, and decisions made. ` +
                `Reply with bullet points only.\n\n` +
                olderText.slice(0, 4000),
            },
          ],
          maxTokens: 400,
          temperature: 0,
          fast: true,
        },
        {},
      );

      const summary = result.text.trim();
      const summaryMsg: MessageParam = {
        role: 'user',
        content: `[Earlier conversation summary]\n${summary}`,
      };

      return [summaryMsg, ...recent];
    } catch (err) {
      histLogger.warn({ err }, 'Full-history summarization failed — keeping recent messages only');
      return recent;
    }
  }
}
```

- [x] **Step 4: Run — verify passes**

```bash
bun test test/services/ai/history-summarizer.test.ts 2>&1 | tail -20
```

Expected: all 4 tests PASS.

- [x] **Step 5: Commit**

```bash
git add src/services/ai/history-summarizer.ts test/services/ai/history-summarizer.test.ts
git commit -m "feat(ai): add HistorySummarizer — per-message and full-history condensation with Redis cache"
```

---

### Task 3: Full-history condensation tests

**Files:**
- Modify: `test/services/ai/history-summarizer.test.ts`

- [x] **Step 1: Add failing tests for condenseHistory**

Append to `test/services/ai/history-summarizer.test.ts`:

```typescript
import type OpenAI from 'openai';
import { HISTORY_TOKEN_BUDGET } from '../../../src/services/ai/history-summarizer.ts';

type MessageParam = OpenAI.ChatCompletionMessageParam;

// 350 chars per message = 100 tokens each
const bigMsg = (role: 'user' | 'assistant'): MessageParam => ({
  role,
  content: 'x'.repeat(350),
});

describe('HistorySummarizer.condenseHistory', () => {
  test('returns same reference when under budget', async () => {
    const mockStream = mock(async () => makeStreamResult('unused'));
    const s = new HistorySummarizer(null, mockStream);
    const msgs: MessageParam[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    const result = await s.condenseHistory(msgs);
    expect(result).toBe(msgs);
    expect(mockStream).not.toHaveBeenCalled();
  });

  test('collapses old messages into summary + keeps 5 recent', async () => {
    const mockStream = mock(async () => makeStreamResult('• event A\n• event B'));
    const s = new HistorySummarizer(null, mockStream);

    // 80 messages × 100 tokens = 8000 tokens > HISTORY_TOKEN_BUDGET
    const msgs: MessageParam[] = Array.from({ length: 80 }, (_, i) =>
      bigMsg(i % 2 === 0 ? 'user' : 'assistant'),
    );

    const result = await s.condenseHistory(msgs);

    expect(result.length).toBe(6); // 1 summary + 5 recent
    const first = result[0];
    expect(first!.role).toBe('user');
    expect(typeof first!.content === 'string' && first!.content).toContain('[Earlier conversation summary]');
    expect(mockStream).toHaveBeenCalledTimes(1);
  });

  test('falls back to 5 most recent when AI fails', async () => {
    const mockStream = mock(async () => { throw new Error('AI down'); });
    const s = new HistorySummarizer(null, mockStream);

    const msgs: MessageParam[] = Array.from({ length: 80 }, (_, i) =>
      bigMsg(i % 2 === 0 ? 'user' : 'assistant'),
    );

    const result = await s.condenseHistory(msgs);
    expect(result.length).toBe(5);
    // most recent 5 are the last in the array
    expect(result).toEqual(msgs.slice(-5));
  });

  test('does not condense when message count <= RECENT_KEEP', async () => {
    const mockStream = mock(async () => makeStreamResult('unused'));
    const s = new HistorySummarizer(null, mockStream);

    // 5 massive messages — still only 5, can't split
    const msgs: MessageParam[] = Array.from({ length: 5 }, () => ({
      role: 'user' as const,
      content: 'x'.repeat(350 * 100), // huge
    }));

    const result = await s.condenseHistory(msgs);
    expect(result).toBe(msgs); // returned as-is, can't split further
    expect(mockStream).not.toHaveBeenCalled();
  });
});
```

- [x] **Step 2: Run — verify all pass (condenseHistory already implemented)**

```bash
bun test test/services/ai/history-summarizer.test.ts 2>&1 | tail -20
```

Expected: all 8 tests PASS. If any fail, fix the implementation in `history-summarizer.ts`.

- [x] **Step 3: Run full suite — no regressions**

```bash
bun test 2>&1 | tail -20
```

Expected: all tests PASS.

- [x] **Step 4: Commit**

```bash
git add test/services/ai/history-summarizer.test.ts
git commit -m "test(ai): add condenseHistory coverage — budget enforcement, fallback, edge cases"
```

---

### Task 4: Wire summarizer into AgentConfig and agent.ts

**Files:**
- Modify: `src/services/ai/types.ts` — add `summarizer?` to `AgentConfig`
- Modify: `src/services/ai/agent.ts` — store + call summarizer; make `buildMessages()` async

- [x] **Step 1: Add `summarizer` to AgentConfig in types.ts**

Find (around line 322):
```typescript
export interface AgentConfig {
  debugLogger?: import('./debug-logger.ts').AiDebugLogger;
}
```

Replace with:
```typescript
export interface AgentConfig {
  debugLogger?: import('./debug-logger.ts').AiDebugLogger;
  summarizer?: import('./history-summarizer.ts').HistorySummarizer;
}
```

- [x] **Step 2: Add import and field to CalendarBotAgent**

At the top of `src/services/ai/agent.ts`, add after existing imports:
```typescript
import type { HistorySummarizer } from './history-summarizer.ts';
```

In the class body, add the field and store it in the constructor:
```typescript
export class CalendarBotAgent {
  private sender: TelegramSender;
  private debugLogger?: AiDebugLogger;
  private streamImpl: typeof aiStreamRound;
  private summarizer?: HistorySummarizer;  // ADD

  constructor(config: AgentConfig, sender: TelegramSender, opts?: { streamImpl?: typeof aiStreamRound }) {
    this.sender = sender;
    this.debugLogger = config.debugLogger;
    this.streamImpl = opts?.streamImpl ?? aiStreamRound;
    this.summarizer = config.summarizer;   // ADD
  }
```

- [x] **Step 3: Make buildMessages() async; apply per-message condensation**

Change the method signature:
```typescript
async buildMessages(
  ctx: AgentContext,
  history: ChatHistoryMessage[],
  caps?: UserCapabilities,
): Promise<{ systemPrompt: string; messages: MessageParam[] }>
```

Inside the inner loop that processes `parsedMessages`, apply per-message condensation for tool messages. Find the section that does:
```typescript
for (const msg of parsedMessages) {
  // ... group-chat attribution ...
  messages.push(msg);
}
```

Change to use `let` and apply condensation:
```typescript
for (let msg of parsedMessages) {
  if (this.summarizer && msg.role === 'tool' && typeof msg.content === 'string') {
    const condensed = await this.summarizer.condenseMessage(row.id, 'tool', msg.content);
    if (condensed !== msg.content) {
      msg = { ...msg, content: condensed };
    }
  }

  if (ctx.isGroup && ctx.groupChatId && msg.role === 'user' && typeof msg.content === 'string') {
    // ... existing group attribution code ...
  }
  messages.push(msg);
}
```

- [x] **Step 4: Await buildMessages() and apply full-history condensation in run()**

In `run()`, find:
```typescript
const history = ctx.chatHistory.getRecent(ctx.user.telegram_id, 30);
const { systemPrompt, messages: historyMessages } = this.buildMessages(ctx, history, caps);
```

Replace with:
```typescript
const history = ctx.chatHistory.getRecent(ctx.user.telegram_id, 30);
const { systemPrompt, messages: rawHistoryMessages } = await this.buildMessages(ctx, history, caps);
const historyMessages = this.summarizer
  ? await this.summarizer.condenseHistory(rawHistoryMessages)
  : rawHistoryMessages;
```

- [x] **Step 5: Find and update any test callers of buildMessages()**

```bash
grep -n "buildMessages" test/services/ai/agent.test.ts 2>/dev/null | head -10
```

For each direct `buildMessages()` call in tests, add `await`.

- [x] **Step 6: Type check**

```bash
tsc --noEmit 2>&1 | head -30
```

Expected: zero errors.

- [x] **Step 7: Run full test suite**

```bash
bun test 2>&1 | tail -30
```

Expected: all tests PASS.

- [x] **Step 8: Commit**

```bash
git add src/services/ai/types.ts src/services/ai/agent.ts
git commit -m "feat(ai): wire HistorySummarizer into CalendarBotAgent — per-message and full-history condensation"
```

---

### Task 5: Inject summarizer with Redis in src/index.ts

**Files:**
- Modify: `src/index.ts` — create `HistorySummarizer` with a `Bun.RedisClient`, inject into agent

- [ ] **Step 1: Find where CalendarBotAgent is constructed**

```bash
grep -n "new CalendarBotAgent\|CalendarBotAgent(" src/index.ts | head -5
```

Note the line numbers.

- [ ] **Step 2: Add imports near other AI imports**

```typescript
import { HistorySummarizer } from './services/ai/history-summarizer.ts';
import { aiStreamRound } from './services/ai/streaming.ts';
```

- [ ] **Step 3: Create the summarizer before agent construction**

Before the `new CalendarBotAgent(...)` call, add:

```typescript
const summarizerRedis = new Bun.RedisClient(config.REDIS_URL);
const historySummarizer = new HistorySummarizer(
  {
    get: (key) => summarizerRedis.get(key),
    set: (key, value, exMode, ttl) =>
      exMode && ttl
        ? summarizerRedis.set(key, value, exMode, Number(ttl))
        : summarizerRedis.set(key, value),
  },
  aiStreamRound,
);
```

- [ ] **Step 4: Pass to CalendarBotAgent**

In the constructor call, add `summarizer`:
```typescript
const agent = new CalendarBotAgent(
  { debugLogger, summarizer: historySummarizer },
  sender,
);
```

If there are multiple construction sites, add `summarizer` to each.

- [ ] **Step 5: Type check + lint**

```bash
tsc --noEmit 2>&1 | head -20
bun run lint 2>&1 | tail -10
```

Expected: zero errors, zero warnings.

- [ ] **Step 6: Run full test suite**

```bash
bun test 2>&1 | tail -30
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/index.ts
git commit -m "feat(ai): inject HistorySummarizer with Redis into CalendarBotAgent production path"
```

---

### Task 6: Final verification

- [ ] **Step 1: Full test suite with coverage**

```bash
bun test --coverage 2>&1 | tail -40
```

Expected: all PASS, coverage ≥80% on `history-summarizer.ts` and `token-estimate.ts`.

- [ ] **Step 2: knip — no unused exports**

```bash
bunx knip 2>&1 | head -20
```

Expected: no unused exports or files introduced by this change.

- [ ] **Step 3: Format check**

```bash
bun run format 2>&1
bun run lint 2>&1 | tail -10
```

Expected: no changes, zero warnings.

- [ ] **Step 4: Smoke test on server after deploy**

```bash
ssh root@104.248.84.190 "docker logs hypercal-bot --since 30m 2>&1 | grep -E '413|History over token|condensing|history-summarizer' | tail -20"
```

Expected: see `History over token budget — condensing` log lines instead of 413 errors for oversized contexts.

---

## Self-Review

**Spec coverage:**
- ✅ Per-message summarization when content > threshold → Tasks 2, 4
- ✅ Full-history summarization when total > budget → Tasks 2, 3, 4
- ✅ Redis caching by row ID → Tasks 2, 5
- ✅ Graceful fallback when AI unavailable → truncation / keep-recent
- ✅ Tests for all branches (cache hit, AI fail, under budget, edge cases) → Tasks 2, 3

**No placeholders:** all steps have code. No TBDs.

**Type consistency:** `HistorySummarizer` / `PER_MSG_CHARS_LIMIT` / `HISTORY_TOKEN_BUDGET` exported from `history-summarizer.ts` and imported consistently in tests and `agent.ts`. `condenseMessage(rowId, role, content)` and `condenseHistory(messages)` used identically across Tasks 2–4.

**Known limitation:** `HISTORY_TOKEN_BUDGET = 6000` is a conservative fixed constant. If a provider has a very small context window and the system prompt alone already exceeds the budget, history summarization won't save it — but that's a different problem (tool list trimming). The budget chosen (6K) leaves headroom for a ~5K system prompt and 4K response in a 16K context window.
