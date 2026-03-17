# Bot UX & Automation System — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add pipeline message routing, intent automation, unified settings, feedback system, voice response prompt, auto-pin, and timezone in invitations.

**Architecture:** Sequential pipeline replaces monolithic message handler. IntentMatcher (SQLite + in-memory index) handles known phrases without AI. FeedbackRouter enriches context for AI. IntentLearner runs async after AI responses. Unified `manage_settings` tool replaces 7 fragmented tools.

**Tech Stack:** Bun, GramIO, bun:sqlite, Anthropic SDK (Haiku for IntentLearner)

**Spec:** `docs/specs/2026-03-17-bot-ux-automation.md`

---

## Task 1: BOT_ADMIN_ID Configuration

**Files:**
- Modify: `src/config/env.ts`
- Modify: `.env.example`
- Test: `test/config/env.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/config/env.test.ts — add to existing tests
test("parses BOT_ADMIN_ID as number", () => {
  process.env.BOT_ADMIN_ID = "123456789";
  const config = loadConfig();
  expect(config.botAdminId).toBe(123456789);
});

test("BOT_ADMIN_ID is undefined when not set", () => {
  delete process.env.BOT_ADMIN_ID;
  const config = loadConfig();
  expect(config.botAdminId).toBeUndefined();
});

test("throws if BOT_ADMIN_ID is set but not a number", () => {
  process.env.BOT_ADMIN_ID = "not-a-number";
  expect(() => loadConfig()).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/config/env.test.ts`
Expected: FAIL — `botAdminId` property doesn't exist

- [ ] **Step 3: Implement BOT_ADMIN_ID in config**

In `src/config/env.ts`, add:
- `botAdminId`: Read `process.env.BOT_ADMIN_ID`. If set: parse with `Number()`, validate `!Number.isNaN()`, throw if invalid. If not set: `undefined`.
- `intentLearnerDailyLimit`: Read `process.env.INTENT_LEARNER_DAILY_LIMIT`, default `100`. Parse as number.

- [ ] **Step 4: Add to .env.example**

```
# Bot admin Telegram user ID (for feedback forwarding and intent verification)
BOT_ADMIN_ID=
# Max IntentLearner API calls per day (default: 100)
INTENT_LEARNER_DAILY_LIMIT=100
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/config/env.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/config/env.ts .env.example test/config/env.test.ts
git commit -m "feat: add BOT_ADMIN_ID config"
```

---

## Task 2: Database Migrations (016–019)

**Files:**
- Modify: `src/database/migrations.ts`
- Modify: `src/database/types.ts`
- Test: `test/database/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/database/schema.test.ts — add to existing migration tests
test("migration 016 adds voice_response_enabled to users", () => {
  // run migrations up to 016
  const row = db.query("PRAGMA table_info(users)").all();
  const col = row.find((r: any) => r.name === "voice_response_enabled");
  expect(col).toBeDefined();
  expect(col.dflt_value).toBe("NULL");
});

test("migration 017 creates intents table", () => {
  const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='intents'").get();
  expect(tables).toBeDefined();
});

test("migration 018 creates feedback tables", () => {
  const threads = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='feedback_threads'").get();
  const messages = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='feedback_messages'").get();
  expect(threads).toBeDefined();
  expect(messages).toBeDefined();
});

test("migration 019 adds pin_hint_shown to group_chats", () => {
  const row = db.query("PRAGMA table_info(group_chats)").all();
  const col = row.find((r: any) => r.name === "pin_hint_shown");
  expect(col).toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/database/schema.test.ts`
Expected: FAIL — columns/tables don't exist

- [ ] **Step 3: Implement migration 016 — voice_response_enabled**

In `src/database/migrations.ts`, add migration 016:
```sql
ALTER TABLE users ADD COLUMN voice_response_enabled INTEGER DEFAULT NULL
```

- [ ] **Step 4: Implement migration 017 — intents table**

```sql
CREATE TABLE IF NOT EXISTS intents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_name TEXT UNIQUE NOT NULL,
  phrases TEXT NOT NULL DEFAULT '[]',
  trigger_words TEXT DEFAULT '[]',
  pattern TEXT,
  workflow TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'text',
  status TEXT NOT NULL DEFAULT 'pending',
  source_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_intents_status ON intents(status);
```

- [ ] **Step 5: Implement migration 018 — feedback tables**

```sql
CREATE TABLE IF NOT EXISTS feedback_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  type TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT
);
CREATE INDEX idx_feedback_threads_user_status ON feedback_threads(user_id, status);

CREATE TABLE IF NOT EXISTS feedback_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL,
  sender TEXT NOT NULL,
  text TEXT NOT NULL,
  telegram_message_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (thread_id) REFERENCES feedback_threads(id) ON DELETE CASCADE
);
CREATE INDEX idx_feedback_messages_thread ON feedback_messages(thread_id);
```

- [ ] **Step 6: Implement migration 019 — pin_hint_shown**

```sql
ALTER TABLE group_chats ADD COLUMN pin_hint_shown INTEGER NOT NULL DEFAULT 0
```

- [ ] **Step 7: Add TypeScript types**

In `src/database/types.ts`, add:
- `voice_response_enabled: number | null` to `User` interface
- `Intent` interface (id, canonical_name, phrases, trigger_words, pattern, workflow, format, status, source_message, created_at)
- `FeedbackThread` interface (id, user_id, status, type, subject, created_at, closed_at)
- `FeedbackMessage` interface (id, thread_id, sender, text, telegram_message_id, created_at)
- `pin_hint_shown: number` to `GroupChat` interface

- [ ] **Step 8: Run test to verify it passes**

Run: `bun test test/database/schema.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/database/migrations.ts src/database/types.ts test/database/schema.test.ts
git commit -m "feat(db): migrations 016-019 for UX automation"
```

---

## Task 3: Intent Repository

**Files:**
- Create: `src/database/repositories/intent.repository.ts`
- Test: `test/database/repositories/intent.repository.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/database/repositories/intent.repository.test.ts
import { test, expect, beforeEach } from "bun:test";

test("creates intent with pending status", () => {
  const id = repo.create({
    canonical_name: "show_today",
    phrases: ["что сегодня", "today"],
    workflow: { tools: [{ name: "get_events", input: { start_date: "{{today}}" } }] },
    format: "events_list",
    source_message: "что у меня сегодня?",
  });
  const intent = repo.getById(id);
  expect(intent).toBeDefined();
  expect(intent!.status).toBe("pending");
  expect(JSON.parse(intent!.phrases)).toEqual(["что сегодня", "today"]);
});

test("getApproved returns only approved intents", () => {
  repo.create({ canonical_name: "a", phrases: ["a"], workflow: {}, format: "text" });
  const id2 = repo.create({ canonical_name: "b", phrases: ["b"], workflow: {}, format: "text" });
  repo.updateStatus(id2, "approved");
  const approved = repo.getApproved();
  expect(approved.length).toBe(1);
  expect(approved[0].canonical_name).toBe("b");
});

test("updateStatus changes status", () => {
  const id = repo.create({ canonical_name: "c", phrases: ["c"], workflow: {}, format: "text" });
  repo.updateStatus(id, "approved");
  expect(repo.getById(id)!.status).toBe("approved");
});

test("appendPhrases adds to existing phrases", () => {
  const id = repo.create({ canonical_name: "d", phrases: ["hello"], workflow: {}, format: "text" });
  repo.appendPhrases(id, ["hi", "hey"]);
  const intent = repo.getById(id);
  expect(JSON.parse(intent!.phrases)).toEqual(["hello", "hi", "hey"]);
});

test("findByCanonicalName returns intent or null", () => {
  repo.create({ canonical_name: "e", phrases: ["e"], workflow: {}, format: "text" });
  expect(repo.findByCanonicalName("e")).toBeDefined();
  expect(repo.findByCanonicalName("nonexistent")).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/database/repositories/intent.repository.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement IntentRepository**

Create `src/database/repositories/intent.repository.ts`:
- `create(data)` — INSERT, return id. Serialize `phrases`, `trigger_words`, `workflow` as JSON.
- `getById(id)` — SELECT by id
- `getApproved()` — SELECT WHERE status = 'approved'
- `updateStatus(id, status)` — UPDATE status
- `appendPhrases(id, newPhrases)` — read existing, merge, UPDATE
- `findByCanonicalName(name)` — SELECT WHERE canonical_name
- `update(id, data)` — partial UPDATE (for admin edits)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/database/repositories/intent.repository.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/database/repositories/intent.repository.ts test/database/repositories/intent.repository.test.ts
git commit -m "feat(db): intent repository"
```

---

## Task 4: Feedback Repository

**Files:**
- Create: `src/database/repositories/feedback.repository.ts`
- Test: `test/database/repositories/feedback.repository.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
test("creates thread and first message", () => {
  const threadId = repo.createThread({
    user_id: 123,
    type: "bug",
    subject: "Button broken",
  });
  const msgId = repo.addMessage({
    thread_id: threadId,
    sender: "user",
    text: "The add button doesn't work",
  });
  expect(threadId).toBeGreaterThan(0);
  expect(msgId).toBeGreaterThan(0);
});

test("getOpenThreadForUser returns open thread", () => {
  const threadId = repo.createThread({ user_id: 456, type: "feature", subject: "Dark mode" });
  const open = repo.getOpenThreadForUser(456);
  expect(open).toBeDefined();
  expect(open!.id).toBe(threadId);
});

test("getOpenThreadForUser returns null when no open thread", () => {
  expect(repo.getOpenThreadForUser(999)).toBeNull();
});

test("closeThread sets status and closed_at", () => {
  const threadId = repo.createThread({ user_id: 789, type: "bug", subject: "Crash" });
  repo.closeThread(threadId);
  const thread = repo.getThread(threadId);
  expect(thread!.status).toBe("closed");
  expect(thread!.closed_at).toBeDefined();
});

test("getMessages returns all messages in order", () => {
  const threadId = repo.createThread({ user_id: 100, type: "question", subject: "How?" });
  repo.addMessage({ thread_id: threadId, sender: "user", text: "First" });
  repo.addMessage({ thread_id: threadId, sender: "admin", text: "Second" });
  const msgs = repo.getMessages(threadId);
  expect(msgs.length).toBe(2);
  expect(msgs[0].text).toBe("First");
  expect(msgs[1].sender).toBe("admin");
});

test("countOpenThreads counts correctly", () => {
  repo.createThread({ user_id: 200, type: "bug", subject: "A" });
  repo.createThread({ user_id: 200, type: "bug", subject: "B" });
  expect(repo.countOpenThreads(200)).toBe(2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/database/repositories/feedback.repository.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement FeedbackRepository**

Create `src/database/repositories/feedback.repository.ts`:
- `createThread(data)` — INSERT into feedback_threads, return id
- `getThread(id)` — SELECT by id
- `getOpenThreadForUser(userId)` — Returns the most recent open thread (SELECT WHERE user_id AND status = 'open' ORDER BY created_at DESC LIMIT 1). Multiple open threads can coexist (max 3 per spec), but FeedbackRouter uses the most recent for context enrichment.
- `closeThread(id)` — UPDATE status = 'closed', closed_at = datetime('now')
- `addMessage(data)` — INSERT into feedback_messages, return id
- `getMessages(threadId)` — SELECT WHERE thread_id ORDER BY created_at ASC
- `countOpenThreads(userId)` — SELECT COUNT WHERE user_id AND status = 'open'

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/database/repositories/feedback.repository.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/database/repositories/feedback.repository.ts test/database/repositories/feedback.repository.test.ts
git commit -m "feat(db): feedback repository"
```

---

## Task 5: Intent Matcher Service

**Files:**
- Create: `src/services/intent/intent-matcher.ts`
- Create: `src/services/intent/normalizer.ts`
- Test: `test/services/intent/intent-matcher.test.ts`
- Test: `test/services/intent/normalizer.test.ts`

- [ ] **Step 1: Write normalizer tests**

```typescript
// test/services/intent/normalizer.test.ts
test("normalizes to lowercase, trims, strips punctuation", () => {
  expect(normalize("  Что Сегодня?!  ")).toBe("что сегодня");
  expect(normalize("Hello, World.")).toBe("hello world");
});

test("tokenize splits into word set", () => {
  expect(tokenize("найди встречу с доктором")).toEqual(new Set(["найди", "встречу", "с", "доктором"]));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/services/intent/normalizer.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement normalizer**

Create `src/services/intent/normalizer.ts`:
- `normalize(text: string): string` — lowercase, trim, replace punctuation with space, collapse whitespace
- `tokenize(text: string): Set<string>` — normalize then split on whitespace

- [ ] **Step 4: Run normalizer test**

Run: `bun test test/services/intent/normalizer.test.ts`
Expected: PASS

- [ ] **Step 5: Write IntentMatcher tests**

```typescript
// test/services/intent/intent-matcher.test.ts
test("exact match returns intent id", () => {
  matcher.load([{
    id: 1, canonical_name: "show_today", status: "approved",
    phrases: '["что сегодня", "today"]', trigger_words: "[]", pattern: null,
    workflow: '{}', format: "events_list", source_message: null, created_at: ""
  }]);
  expect(matcher.match("Что сегодня?")).toEqual({ intentId: 1, captures: {} });
  expect(matcher.match("today")).toEqual({ intentId: 1, captures: {} });
});

test("regex match with capture groups", () => {
  matcher.load([{
    id: 2, canonical_name: "search", status: "approved",
    phrases: "[]", trigger_words: '["найди", "поиск"]',
    pattern: "^(?:найди|поиск)\\s+(.+)$",
    workflow: '{}', format: "text", source_message: null, created_at: ""
  }]);
  const result = matcher.match("найди встречу с доктором");
  expect(result).toEqual({ intentId: 2, captures: { "$1": "встречу с доктором" } });
});

test("returns null on no match", () => {
  matcher.load([]);
  expect(matcher.match("random text")).toBeNull();
});

test("exact match has priority over regex", () => {
  matcher.load([
    { id: 1, phrases: '["найди"]', trigger_words: "[]", pattern: null, /* ... */ },
    { id: 2, phrases: "[]", trigger_words: '["найди"]', pattern: "^найди\\s+(.+)$", /* ... */ },
  ]);
  expect(matcher.match("найди")!.intentId).toBe(1);
  expect(matcher.match("найди событие")!.intentId).toBe(2);
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `bun test test/services/intent/intent-matcher.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 7: Implement IntentMatcher**

Create `src/services/intent/intent-matcher.ts`:
- Constructor takes `IntentRepository`
- `load(intents: Intent[])` — build `phraseMap: Map<string, number>` and `triggerIndex: Map<string, {intentId, pattern}[]>`
- `reload()` — call `repo.getApproved()` then `load()`
- `match(text: string): { intentId: number, captures: Record<string, string> } | null`
  1. Normalize text → check phraseMap → if found, return `{ intentId, captures: {} }`
  2. Tokenize text → check triggerIndex for each word → collect candidate regex intents
  3. Test each candidate regex → if match, extract capture groups `$1`, `$2`, ...
  4. Return first match or null

- [ ] **Step 8: Run test to verify it passes**

Run: `bun test test/services/intent/intent-matcher.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/services/intent/ test/services/intent/
git commit -m "feat: intent matcher with exact + regex matching"
```

---

## Task 6: Workflow Expression Evaluator

**Files:**
- Create: `src/services/intent/expression-evaluator.ts`
- Test: `test/services/intent/expression-evaluator.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
test("evaluates simple comparisons", () => {
  const ctx = { results: { length: 0 } };
  expect(evaluate("results.length == 0", ctx)).toBe(true);
  expect(evaluate("results.length > 0", ctx)).toBe(false);
  expect(evaluate("results.length != 0", ctx)).toBe(false);
});

test("evaluates boolean operators", () => {
  const ctx = { a: true, b: false };
  expect(evaluate("a && b", ctx)).toBe(false);
  expect(evaluate("a || b", ctx)).toBe(true);
});

test("accesses nested properties", () => {
  const ctx = { results: [{ id: 1 }, { id: 2 }] };
  expect(evaluate("results.length > 1", ctx)).toBe(true);
});

test("throws on invalid expression", () => {
  expect(() => evaluate("process.exit(1)", {})).toThrow();
});

test("handles string comparisons", () => {
  const ctx = { status: "pending" };
  expect(evaluate('status == "pending"', ctx)).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/services/intent/expression-evaluator.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement expression evaluator**

Create `src/services/intent/expression-evaluator.ts`:
- Hand-rolled recursive descent parser
- Tokenizer: splits into tokens (identifiers, numbers, strings, operators)
- Parser: `expression → orExpr`, `orExpr → andExpr ('||' andExpr)*`, `andExpr → comparison ('&&' comparison)*`, `comparison → value (op value)?`, `value → literal | property_access`
- Property access: `a.b.c` → safe chain on context object. Only `.` and `.length` on arrays.
- No function calls, no assignments, no arbitrary property access beyond provided context

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/services/intent/expression-evaluator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/intent/expression-evaluator.ts test/services/intent/expression-evaluator.test.ts
git commit -m "feat: safe expression evaluator for workflow conditions"
```

---

## Task 7: Workflow Variable Resolver & Executor

**Files:**
- Create: `src/services/intent/variable-resolver.ts`
- Create: `src/services/intent/intent-executor.ts`
- Test: `test/services/intent/variable-resolver.test.ts`
- Test: `test/services/intent/intent-executor.test.ts`

- [ ] **Step 1: Write variable resolver tests**

```typescript
// test/services/intent/variable-resolver.test.ts
test("resolves {{today}} to current date in user timezone", () => {
  const ctx = { timezone: "Europe/Moscow" };
  const result = resolveVariables("{{today}}", {}, ctx);
  // Should be YYYY-MM-DD format in Moscow timezone
  expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("resolves capture groups {{$1}}", () => {
  const captures = { "$1": "встречу с доктором" };
  expect(resolveVariables("{{$1}}", captures, {})).toBe("встречу с доктором");
});

test("resolves step results {{results[0].id}}", () => {
  const stepResults = { results: [{ id: 42 }] };
  expect(resolveVariables("{{results[0].id}}", {}, {}, stepResults)).toBe("42");
});

test("resolves user context {{user.timezone}}", () => {
  const ctx = { timezone: "Europe/Kyiv", language: "ru" };
  expect(resolveVariables("{{user.timezone}}", {}, ctx)).toBe("Europe/Kyiv");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/services/intent/variable-resolver.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement variable resolver**

Create `src/services/intent/variable-resolver.ts`:
- `resolveVariables(template, captures, userCtx, stepResults?)` — find all `{{...}}` patterns, resolve each:
  - `{{today}}`, `{{tomorrow}}`, `{{week_start}}`, etc. — compute date in user timezone using `@date-fns/tz`
  - `{{$N}}` — lookup in captures
  - `{{user.field}}` — lookup in user context
  - `{{step.field}}` or `{{step[N].field}}` — lookup in step results
- Returns resolved string (for string values) or the raw value (for objects in JSON input)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/services/intent/variable-resolver.test.ts`
Expected: PASS

- [ ] **Step 5: Write IntentExecutor tests**

```typescript
// test/services/intent/intent-executor.test.ts
test("executes Level 1 workflow (single tool call)", async () => {
  const workflow = {
    tools: [{ name: "get_events", input: { start_date: "{{today}}", end_date: "{{today}}" } }],
    format: "events_list"
  };
  // Mock tool executor that returns events
  const mockExecutor = (name: string, input: any) => ({
    success: true, output: JSON.stringify([{ title: "Meeting", start_at: "2026-03-17T10:00:00Z" }])
  });
  const result = await executor.run(workflow, {}, userCtx, mockExecutor);
  expect(result.success).toBe(true);
  expect(result.response).toContain("Meeting");
});

test("executes Level 2 workflow with conditions", async () => {
  const workflow = {
    steps: [
      { call: "search_events", input: { query: "{{$1}}" }, as: "results" },
      { when: "results.length == 0", respond: "Ничего не найдено", stop: true },
    ]
  };
  const mockExecutor = () => ({ success: true, output: "[]" });
  const result = await executor.run(workflow, { "$1": "test" }, userCtx, mockExecutor);
  expect(result.response).toBe("Ничего не найдено");
});

test("workflow with ask_user suspends execution", async () => {
  const workflow = {
    steps: [
      { call: "search_events", input: { query: "test" }, as: "results" },
      { when: "results.length > 1", call: "ask_user", input: { question: "Which?" }, as: "choice" },
    ]
  };
  const mockExecutor = () => ({ success: true, output: '[{"id":1},{"id":2}]' });
  const result = await executor.run(workflow, {}, userCtx, mockExecutor);
  expect(result.suspended).toBe(true);
  expect(result.suspendedAt).toBe(1); // step index
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `bun test test/services/intent/intent-executor.test.ts`
Expected: FAIL

- [ ] **Step 7: Implement IntentExecutor**

Create `src/services/intent/intent-executor.ts`:
- `run(workflow, captures, userCtx, toolExecutor, resumeState?)`:
  - If workflow has `tools` array (Level 1): resolve variables in each tool input, call toolExecutor, format result
  - If workflow has `steps` array (Level 2): iterate steps:
    - Check `when` condition (if present) via expression evaluator
    - If `call` → resolve variables → call toolExecutor → store result in `stepResults[as]`
    - If `respond` → return response text, stop if `stop: true`
    - If `call` is `ask_user` → return `{ suspended: true, suspendedAt: stepIndex, stepResults }`
  - `resumeState` allows continuing from a suspended step with user's answer
- Returns `{ success, response, suspended?, suspendedAt?, stepResults? }`

- [ ] **Step 8: Run test to verify it passes**

Run: `bun test test/services/intent/intent-executor.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/services/intent/variable-resolver.ts src/services/intent/intent-executor.ts test/services/intent/
git commit -m "feat: workflow variable resolver and intent executor"
```

---

## Task 8: Response Formatters for Intents

**Files:**
- Create: `src/services/intent/response-formatter.ts`
- Test: `test/services/intent/response-formatter.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
test("formats events_list", () => {
  const events = [{ title: "Meeting", start_at: "2026-03-17T10:00:00Z", end_at: "2026-03-17T11:00:00Z" }];
  const result = formatResponse("events_list", JSON.stringify(events), "Europe/Moscow", "ru");
  expect(result).toContain("Meeting");
  expect(result).toContain("13:00"); // UTC+3
});

test("formats text as-is", () => {
  expect(formatResponse("text", "hello", "UTC", "en")).toBe("hello");
});

test("formats search_results", () => {
  const events = [{ title: "Doctor", start_at: "2026-03-20T09:00:00Z" }];
  const result = formatResponse("search_results", JSON.stringify(events), "UTC", "en");
  expect(result).toContain("Doctor");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/services/intent/response-formatter.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement response formatter**

Create `src/services/intent/response-formatter.ts`:
- `formatResponse(format: string, toolOutput: string, timezone: string, language: string): string`
- Reuse existing formatters from `src/services/event/formatters.ts` where possible (import `formatDayAgenda`, etc.)
- Format types: `events_list` (parse events JSON, format with timezone), `free_slots`, `text` (passthrough), `holidays`, `search_results`, `settings`

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/services/intent/response-formatter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/intent/response-formatter.ts test/services/intent/response-formatter.test.ts
git commit -m "feat: intent response formatters"
```

---

## Task 9: Pipeline Architecture — Refactor Message Handler

**Files:**
- Create: `src/bot/pipeline/types.ts`
- Create: `src/bot/pipeline/intent-matcher-layer.ts`
- Create: `src/bot/pipeline/feedback-router-layer.ts`
- Create: `src/bot/pipeline/ai-agent-layer.ts`
- Create: `src/bot/pipeline/pipeline.ts`
- Modify: `src/bot/handlers/message.handler.ts`
- Test: `test/bot/pipeline/pipeline.test.ts`
- Test: `test/bot/pipeline/intent-matcher-layer.test.ts`

- [ ] **Step 1: Create pipeline types**

Create `src/bot/pipeline/types.ts`:
```typescript
export type FeedbackThreadContext = {
  threadId: number;
  subject: string;
  messages: { sender: string; text: string }[];
};

export type PipelineResult =
  | { handled: true }
  | { handled: false }
  | { handled: false; feedbackContext: FeedbackThreadContext };

export type PipelineLayer = (
  ctx: BotContext,
  messageText: string,
  extra?: { feedbackContext?: FeedbackThreadContext }
) => Promise<PipelineResult>;
```

- [ ] **Step 2: Write pipeline orchestrator test**

```typescript
// test/bot/pipeline/pipeline.test.ts
test("stops at first layer that returns handled: true", async () => {
  const layer1 = async () => ({ handled: true as const });
  const layer2 = mock();
  await runPipeline(ctx, "test", [layer1, layer2]);
  expect(layer2).not.toHaveBeenCalled();
});

test("passes feedbackContext from FeedbackRouter to AIAgent", async () => {
  const feedbackRouter = async () => ({
    handled: false as const,
    feedbackContext: { threadId: 1, subject: "Bug", messages: [] }
  });
  const aiAgent = mock().mockResolvedValue({ handled: true });
  await runPipeline(ctx, "test", [feedbackRouter, aiAgent]);
  expect(aiAgent).toHaveBeenCalledWith(ctx, "test", {
    feedbackContext: { threadId: 1, subject: "Bug", messages: [] }
  });
});

test("continues through all layers if none handle", async () => {
  const layer1 = async () => ({ handled: false as const });
  const layer2 = async () => ({ handled: false as const });
  const result = await runPipeline(ctx, "test", [layer1, layer2]);
  // All layers ran, nothing handled
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test test/bot/pipeline/pipeline.test.ts`
Expected: FAIL

- [ ] **Step 4: Implement pipeline orchestrator**

Create `src/bot/pipeline/pipeline.ts`:
- `runPipeline(ctx, messageText, layers: PipelineLayer[])`:
  - Iterate layers in order
  - Track accumulated `feedbackContext`
  - Pass `extra` with `feedbackContext` to subsequent layers
  - Stop if `handled: true`

- [ ] **Step 5: Write IntentMatcher layer test**

```typescript
// test/bot/pipeline/intent-matcher-layer.test.ts
test("returns handled:true when intent matches and executes", async () => {
  // Setup: approved intent in DB, matcher loaded
  const result = await intentMatcherLayer(ctx, "что сегодня");
  expect(result.handled).toBe(true);
  // Verify ctx.send was called with formatted response
});

test("returns handled:false when no intent matches", async () => {
  const result = await intentMatcherLayer(ctx, "something random");
  expect(result.handled).toBe(false);
});

test("checks active workflow session before phrase matching", async () => {
  // Setup: suspended workflow for this user
  const result = await intentMatcherLayer(ctx, "option 1");
  expect(result.handled).toBe(true);
  // Verify workflow resumed
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `bun test test/bot/pipeline/intent-matcher-layer.test.ts`
Expected: FAIL

- [ ] **Step 7: Implement IntentMatcher layer**

Create `src/bot/pipeline/intent-matcher-layer.ts`:
- `createIntentMatcherLayer(matcher, repo, executor, workflowSessions)`:
  1. Check `workflowSessions` for active session → if found, resume workflow
  2. Call `matcher.match(text)` → if no match, return `{ handled: false }`
  3. Load workflow from repo by intentId
  4. Execute via IntentExecutor
  5. If suspended → store in `workflowSessions` with TTL
  6. If response → send to user via `ctx.send()`, return `{ handled: true }`

- [ ] **Step 8: Write FeedbackRouter layer test**

```typescript
// test/bot/pipeline/feedback-router-layer.test.ts
test("returns feedbackContext when open thread exists", async () => {
  feedbackRepo.createThread({ user_id: ctx.userId, type: "bug", subject: "Test" });
  feedbackRepo.addMessage({ thread_id: 1, sender: "admin", text: "Details?" });
  const result = await feedbackRouterLayer(ctx, "more details here");
  expect(result.handled).toBe(false);
  expect(result.feedbackContext).toBeDefined();
  expect(result.feedbackContext.subject).toBe("Test");
});

test("returns handled:false without context when no open thread", async () => {
  const result = await feedbackRouterLayer(ctx, "hello");
  expect(result.handled).toBe(false);
  expect(result.feedbackContext).toBeUndefined();
});
```

- [ ] **Step 9: Implement FeedbackRouter layer**

Create `src/bot/pipeline/feedback-router-layer.ts`:
- `createFeedbackRouterLayer(feedbackRepo)`:
  1. Check `feedbackRepo.getOpenThreadForUser(userId)` → if no open thread, return `{ handled: false }`
  2. Load recent messages from thread
  3. Return `{ handled: false, feedbackContext: { threadId, subject, messages } }`

- [ ] **Step 10: Refactor message.handler.ts to use pipeline**

Modify `src/bot/handlers/message.handler.ts`:
- Extract voice transcription as preprocessing (before pipeline)
- Build pipeline layers: `[intentMatcherLayer, feedbackRouterLayer, aiAgentLayer]`
- Call `runPipeline(ctx, messageText, layers)`
- Move existing AI agent invocation into `ai-agent-layer.ts`
- Keep group chat filtering logic (runs before pipeline)
- Keep scene/command filtering (runs before pipeline)

- [ ] **Step 11: Run all tests**

Run: `bun test`
Expected: All existing tests still pass + new pipeline tests pass

- [ ] **Step 12: Commit**

```bash
git add src/bot/pipeline/ src/bot/handlers/message.handler.ts test/bot/pipeline/
git commit -m "feat: pipeline message routing architecture"
```

---

## Task 10: Unified Settings Tool

**Files:**
- Modify: `src/services/ai/tools.ts`
- Modify: `src/services/ai/tool-executor.ts`
- Create: `src/services/ai/tool-handlers/settings.ts`
- Modify: `src/services/ai/tool-handlers/meta.ts`
- Modify: `src/services/ai/system-prompt.ts`
- Test: `test/services/ai/tool-handlers/settings.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/services/ai/tool-handlers/settings.test.ts
test("get all settings returns all categories", () => {
  const result = handleManageSettings(ctx, { action: "get" });
  expect(result.success).toBe(true);
  const output = JSON.parse(result.output!);
  expect(output.general).toBeDefined();
  expect(output.notifications).toBeDefined();
  expect(output.calls).toBeDefined();
  expect(output.privacy).toBeDefined();
  expect(output.voice).toBeDefined();
});

test("get single category", () => {
  const result = handleManageSettings(ctx, { action: "get", category: "general" });
  const output = JSON.parse(result.output!);
  expect(output.timezone).toBeDefined();
  expect(output.language).toBeDefined();
  expect(output.notifications).toBeUndefined(); // only general
});

test("update voice setting", () => {
  const result = handleManageSettings(ctx, {
    action: "update", category: "voice",
    updates: { voice_response_enabled: true }
  });
  expect(result.success).toBe(true);
  // Verify DB was updated
  const user = userRepo.getByTelegramId(ctx.userId);
  expect(user!.voice_response_enabled).toBe(1);
});

test("update notifications", () => {
  const result = handleManageSettings(ctx, {
    action: "update", category: "notifications",
    updates: { morning_agenda_enabled: false }
  });
  expect(result.success).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/services/ai/tool-handlers/settings.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement settings handler**

Create `src/services/ai/tool-handlers/settings.ts`:
- `handleManageSettings(ctx, input)`:
  - `get` action: aggregate from `userRepo`, `notificationPreferencesService`, `callSettingsRepo`, `sharingSettingsRepo`
  - `update` action: route to appropriate repo/service based on `category`
  - Includes `voice` category reading/writing `voice_response_enabled` on users table

- [ ] **Step 4: Remove old settings tools**

In `src/services/ai/tools.ts`:
- Remove 7 tool definitions: `get_user_settings`, `update_user_settings`, `get_notification_settings`, `update_notification_settings`, `get_call_settings`, `update_call_settings`, `update_sharing_settings`
- Add `manage_settings` definition (as per spec)

In `src/services/ai/tool-executor.ts`:
- Remove 7 switch cases
- Add `manage_settings` case → `handleManageSettings(ctx, input)`

In `src/services/ai/tool-handlers/meta.ts`:
- Remove: `handleGetUserSettings`, `handleUpdateUserSettings`, `handleGetNotificationSettings`, `handleUpdateNotificationSettings`, `handleGetCallSettings`, `handleUpdateCallSettings`
- Keep non-settings handlers (contacts, rendering, holidays, etc.)

- [ ] **Step 5: Update system prompt**

In `src/services/ai/system-prompt.ts`:
- Replace references to individual settings tools with `manage_settings`

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test test/services/ai/tool-handlers/settings.test.ts`
Expected: PASS

- [ ] **Step 7: Fix existing tests broken by tool removal**

Run: `bun test`
Check for failures in existing tool handler tests that reference removed tools. Update those tests to use `manage_settings`.

- [ ] **Step 8: Commit**

```bash
git add src/services/ai/ test/services/ai/
git commit -m "feat: unified manage_settings tool replacing 7 settings tools"
```

---

## Task 11: Unified /settings Command UI

**Files:**
- Modify: `src/bot/commands/settings.ts`
- Remove: `src/bot/commands/notify.ts`
- Remove: `src/bot/commands/call-settings.ts`
- Remove: `src/bot/commands/privacy.ts`
- Modify: `src/bot/index.ts`
- Modify: `src/bot/handlers/callback.handler.ts`
- Test: `test/bot/commands/settings.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/bot/commands/settings.test.ts
test("/settings shows category picker", async () => {
  await handleSettings(ctx);
  expect(ctx.send).toHaveBeenCalledWith(
    expect.stringContaining("Настройки"),
    expect.objectContaining({ reply_markup: expect.any(Object) })
  );
  // Verify 5 category buttons
  const keyboard = ctx.send.mock.calls[0][1].reply_markup;
  expect(JSON.stringify(keyboard)).toContain("Основные");
  expect(JSON.stringify(keyboard)).toContain("Уведомления");
  expect(JSON.stringify(keyboard)).toContain("Звонки");
  expect(JSON.stringify(keyboard)).toContain("Приватность");
  expect(JSON.stringify(keyboard)).toContain("Голос");
});

test("settings:general callback shows general settings", async () => {
  await handleSettingsCallback(ctx, "settings:general");
  expect(ctx.editText).toHaveBeenCalledWith(
    expect.stringContaining("Часовой пояс"),
    expect.any(Object)
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/bot/commands/settings.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement unified /settings command**

Rewrite `src/bot/commands/settings.ts`:
- Show InlineKeyboard with 5 category buttons: `settings:general`, `settings:notifications`, `settings:calls`, `settings:privacy`, `settings:voice`
- Each button text with emoji as per spec

- [ ] **Step 4: Add settings callback handlers**

In `src/bot/handlers/callback.handler.ts`, add routes for `settings:*` prefix:
- `settings:general` — show timezone, language, country with edit buttons
- `settings:notifications` — morning agenda toggle/time, evening review toggle/time, quiet hours, reminders
- `settings:calls` — enabled toggle, language
- `settings:privacy` — visibility level, inline mode, invitations
- `settings:voice` — voice_response_enabled toggle
- Each category has a `[⬅️ Назад]` button returning to category picker

Reuse existing callback logic from `notify.ts` for notification time pickers — move to settings callback handler.

- [ ] **Step 5: Remove old command files and registrations**

- Delete `src/bot/commands/notify.ts`
- Delete `src/bot/commands/call-settings.ts`
- Delete `src/bot/commands/privacy.ts`
- In `src/bot/index.ts`: remove `.command('notify', ...)`, `.command('callsettings', ...)`, `.command('privacy', ...)` registrations

- [ ] **Step 6: Run all tests**

Run: `bun test`
Expected: PASS. Delete old test files for removed commands if they exist.

- [ ] **Step 7: Commit**

```bash
git add src/bot/commands/settings.ts src/bot/index.ts src/bot/handlers/callback.handler.ts test/bot/commands/settings.test.ts
git rm src/bot/commands/notify.ts src/bot/commands/call-settings.ts src/bot/commands/privacy.ts
git rm test/bot/commands/notify.test.ts test/bot/commands/call-settings.test.ts test/bot/commands/privacy.test.ts
git commit -m "feat: unified /settings command with category picker UI"
```

---

## Task 12: Feedback Tool & Admin Messaging

**Files:**
- Create: `src/services/ai/tool-handlers/feedback.ts`
- Modify: `src/services/ai/tools.ts`
- Modify: `src/services/ai/tool-executor.ts`
- Create: `src/services/feedback/admin-messenger.ts`
- Modify: `src/bot/handlers/callback.handler.ts`
- Test: `test/services/ai/tool-handlers/feedback.test.ts`
- Test: `test/services/feedback/admin-messenger.test.ts`

- [ ] **Step 1: Write the failing test for send_feedback handler**

```typescript
// test/services/ai/tool-handlers/feedback.test.ts
test("creates thread and sends to admin", () => {
  const result = handleSendFeedback(ctx, {
    type: "bug",
    message: "Button doesn't work"
  });
  expect(result.success).toBe(true);
  // Verify thread created in DB
  const thread = feedbackRepo.getOpenThreadForUser(ctx.userId);
  expect(thread).toBeDefined();
  expect(thread!.type).toBe("bug");
  // Verify message sent to admin
  expect(adminMessenger.sendFeedbackNotification).toHaveBeenCalled();
});

test("rejects when 3 open threads already exist", () => {
  feedbackRepo.createThread({ user_id: ctx.userId, type: "bug", subject: "A" });
  feedbackRepo.createThread({ user_id: ctx.userId, type: "bug", subject: "B" });
  feedbackRepo.createThread({ user_id: ctx.userId, type: "bug", subject: "C" });
  const result = handleSendFeedback(ctx, { type: "bug", message: "D" });
  expect(result.success).toBe(false);
  expect(result.error).toContain("3");
});

test("rejects when BOT_ADMIN_ID not configured", () => {
  ctx.config.botAdminId = undefined;
  const result = handleSendFeedback(ctx, { type: "bug", message: "test" });
  expect(result.success).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/services/ai/tool-handlers/feedback.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement send_feedback handler**

Create `src/services/ai/tool-handlers/feedback.ts`:
- `handleSendFeedback(ctx, input)`:
  1. Check `config.botAdminId` exists → error if not
  2. Check `feedbackRepo.countOpenThreads(userId) < 3` → error if at limit
  3. Create thread with AI-extracted subject (from first ~50 chars of message)
  4. Add first message to feedback_messages
  5. Send notification to admin via adminMessenger

- [ ] **Step 4: Implement admin messenger**

Create `src/services/feedback/admin-messenger.ts`:
- `sendFeedbackNotification(bot, adminId, thread, message, username)`:
  - Sends formatted message with inline keyboard `[Reply] [Close]`
  - Callback data: `fb_reply:${threadId}`, `fb_close:${threadId}`

- [ ] **Step 5: Add callback handlers for admin actions**

In `src/bot/handlers/callback.handler.ts`:
- `fb_reply:{threadId}` → Set admin into "reply mode" (track in memory). Next message from admin → forward to user as bot message + save to feedback_messages.
- `fb_close:{threadId}` → Close thread, notify user that feedback was resolved.

- [ ] **Step 6: Add tool definition and executor**

In `src/services/ai/tools.ts`: add `send_feedback` definition.
In `src/services/ai/tool-executor.ts`: add case for `send_feedback`.

- [ ] **Step 7: Run test to verify it passes**

Run: `bun test test/services/ai/tool-handlers/feedback.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/services/ai/tool-handlers/feedback.ts src/services/feedback/ src/services/ai/tools.ts src/services/ai/tool-executor.ts src/bot/handlers/callback.handler.ts test/
git commit -m "feat: send_feedback tool with admin messaging"
```

---

## Task 13: Bot Info Tool

**Files:**
- Modify: `src/services/ai/tools.ts`
- Modify: `src/services/ai/tool-executor.ts`
- Modify: `src/services/ai/tool-handlers/meta.ts`
- Test: `test/services/ai/tool-handlers/meta.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
test("get_bot_info returns capabilities text", () => {
  const result = handleGetBotInfo();
  expect(result.success).toBe(true);
  expect(result.output).toContain("voice");
  expect(result.output).toContain("group");
  expect(result.output).toContain("@mxtnr");
  expect(result.output).toContain("feedback");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/services/ai/tool-handlers/meta.test.ts`
Expected: FAIL — function doesn't exist

- [ ] **Step 3: Implement get_bot_info handler**

In `src/services/ai/tool-handlers/meta.ts`, add `handleGetBotInfo()`:
- Returns static text block with non-obvious capabilities (per spec section 6)

In `src/services/ai/tools.ts`: add `get_bot_info` definition.
In `src/services/ai/tool-executor.ts`: add case.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/services/ai/tool-handlers/meta.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/ test/services/ai/
git commit -m "feat: get_bot_info tool for capabilities discovery"
```

---

## Task 14: Voice Response Prompt

**Files:**
- Modify: `src/bot/handlers/message.handler.ts` (or `src/bot/pipeline/ai-agent-layer.ts`)
- Modify: `src/bot/handlers/callback.handler.ts`
- Modify: `src/database/repositories/user.repository.ts`
- Test: `test/bot/handlers/voice-prompt.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
test("shows voice prompt after first voice message when voice_response_enabled is null", async () => {
  ctx.dbUser.voice_response_enabled = null;
  ctx.voice = { file_id: "abc", duration: 5 };
  await handleMessage(ctx);
  // After AI response, should send voice prompt
  expect(ctx.send).toHaveBeenCalledWith(
    expect.stringContaining("голосовые ответы"),
    expect.objectContaining({ reply_markup: expect.any(Object) })
  );
});

test("does NOT show voice prompt if voice_response_enabled is already set", async () => {
  ctx.dbUser.voice_response_enabled = 0;
  ctx.voice = { file_id: "abc", duration: 5 };
  await handleMessage(ctx);
  expect(ctx.send).not.toHaveBeenCalledWith(
    expect.stringContaining("голосовые ответы"),
    expect.any(Object)
  );
});

test("voice prompt callback sets voice_response_enabled", async () => {
  await handleCallback(ctx, "voice_prompt:yes");
  const user = userRepo.getByTelegramId(ctx.userId);
  expect(user!.voice_response_enabled).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/bot/handlers/voice-prompt.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement voice prompt**

In message handler (after AI response for voice messages):
- Check `ctx.dbUser.voice_response_enabled === null`
- If null → send InlineKeyboard message with `voice_prompt:yes` / `voice_prompt:no` callbacks
- Text: "🎤 Хочешь получать голосовые ответы?\nУдобно за рулём, на кухне или на ходу."

In `src/bot/handlers/callback.handler.ts`:
- Add `voice_prompt:yes` → update `voice_response_enabled = 1`, answer "Голосовые ответы включены!"
- Add `voice_prompt:no` → update `voice_response_enabled = 0`, answer "Ок, только текстом."

In `src/database/repositories/user.repository.ts`:
- Add `updateVoiceResponseEnabled(telegramId, enabled: number)` if not already covered by existing update methods

Modify voice response sending logic:
- Currently sends voice for all voice messages when TTS available
- Change to: only send voice when `voice_response_enabled === 1`

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/bot/handlers/voice-prompt.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/bot/handlers/ src/database/repositories/user.repository.ts test/bot/handlers/voice-prompt.test.ts
git commit -m "feat: one-time voice response opt-in prompt"
```

---

## Task 15: Auto-Pin Calendar Images

**Files:**
- Create: `src/utils/auto-pin.ts`
- Modify: `src/bot/commands/today.ts` (and tomorrow.ts, week.ts, month.ts)
- Modify: `src/services/ai/tool-handlers/meta.ts` (render handlers)
- Modify: `src/database/repositories/group-chat.repository.ts`
- Test: `test/utils/auto-pin.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/utils/auto-pin.test.ts
test("pins message silently in private chat", async () => {
  const ctx = mockContext({ chatType: "private" });
  await autoPin(ctx, 42);
  expect(ctx.api.pinChatMessage).toHaveBeenCalledWith(
    ctx.chatId, 42, { disable_notification: true }
  );
});

test("pins in group chat when bot is admin", async () => {
  const ctx = mockContext({ chatType: "group" });
  await autoPin(ctx, 42);
  expect(ctx.api.pinChatMessage).toHaveBeenCalledWith(
    ctx.chatId, 42, { disable_notification: true }
  );
});

test("shows hint once when pin fails in group", async () => {
  const ctx = mockContext({ chatType: "group" });
  ctx.api.pinChatMessage = mock().mockRejectedValue(new Error("not enough rights"));
  groupChatRepo.getByChat.mockReturnValue({ pin_hint_shown: 0 });
  await autoPin(ctx, 42);
  expect(ctx.send).toHaveBeenCalledWith(expect.stringContaining("права админа"));
  expect(groupChatRepo.setPinHintShown).toHaveBeenCalledWith(ctx.chatId);
});

test("silently skips when pin fails and hint already shown", async () => {
  const ctx = mockContext({ chatType: "group" });
  ctx.api.pinChatMessage = mock().mockRejectedValue(new Error("not enough rights"));
  groupChatRepo.getByChat.mockReturnValue({ pin_hint_shown: 1 });
  await autoPin(ctx, 42);
  expect(ctx.send).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/utils/auto-pin.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement autoPin utility**

Create `src/utils/auto-pin.ts`:
- `autoPin(ctx, messageId, groupChatRepo?)`:
  1. Try `ctx.api.pinChatMessage(chatId, messageId, { disable_notification: true })`
  2. On success → done
  3. On error + group chat + `pin_hint_shown === 0` → send hint, set `pin_hint_shown = 1`
  4. On error + group chat + `pin_hint_shown === 1` → silently skip
  5. On error + private chat → log warning (unexpected)

- [ ] **Step 4: Add `setPinHintShown` to group chat repository**

In `src/database/repositories/group-chat.repository.ts`:
- Add `setPinHintShown(chatId: number)` — UPDATE `pin_hint_shown = 1`

- [ ] **Step 5: Integrate autoPin into image-sending code**

In commands (`today.ts`, `tomorrow.ts`, `week.ts`, `month.ts`):
- After `ctx.sendPhoto()` → get returned message → `await autoPin(ctx, msg.message_id, groupChatRepo)`

In AI tool handlers (`meta.ts` — `handleRenderDayImage`, `handleRenderWeekImage`):
- After sending rendered image → `autoPin()`

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test test/utils/auto-pin.test.ts`
Expected: PASS

- [ ] **Step 7: Run all tests**

Run: `bun test`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/utils/auto-pin.ts src/bot/commands/ src/services/ai/tool-handlers/meta.ts src/database/repositories/group-chat.repository.ts test/utils/auto-pin.test.ts
git commit -m "feat: auto-pin calendar images with group admin hint"
```

---

## Task 16: Timezone in Invitations

**Files:**
- Modify: `src/services/sharing/invitation-service.ts`
- Modify: `src/services/event/formatters.ts`
- Test: `test/services/sharing/invitation-service.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/services/sharing/invitation-service.test.ts — add tests
test("invitation message shows recipient timezone", () => {
  const sender = { timezone: "Europe/Moscow" };
  const recipient = { timezone: "Europe/Kyiv", onboarding_completed: 1 };
  const event = { start_at: "2026-03-25T12:00:00Z", title: "Meeting" };
  const text = formatInvitationWithTimezones(event, sender, recipient);
  expect(text).toContain("(Europe/Kyiv)");
  expect(text).toContain("14:00"); // UTC+2
});

test("shows both timezones when different", () => {
  const sender = { timezone: "Europe/Moscow" };
  const recipient = { timezone: "Europe/Kyiv", onboarding_completed: 1 };
  const event = { start_at: "2026-03-25T12:00:00Z", title: "Meeting" };
  const text = formatInvitationWithTimezones(event, sender, recipient);
  expect(text).toContain("(Europe/Moscow)");
  expect(text).toContain("(Europe/Kyiv)");
});

test("shows only sender timezone when recipient has no timezone", () => {
  const sender = { timezone: "Europe/Moscow" };
  const recipient = { onboarding_completed: 0 };
  const event = { start_at: "2026-03-25T12:00:00Z", title: "Meeting" };
  const text = formatInvitationWithTimezones(event, sender, recipient);
  expect(text).toContain("(Europe/Moscow)");
  expect(text).not.toContain("UTC");
});

test("single timezone when sender and recipient match", () => {
  const sender = { timezone: "Europe/Moscow" };
  const recipient = { timezone: "Europe/Moscow", onboarding_completed: 1 };
  const event = { start_at: "2026-03-25T12:00:00Z", title: "Meeting" };
  const text = formatInvitationWithTimezones(event, sender, recipient);
  // Should show timezone only once, not duplicated
  const matches = text.match(/Europe\/Moscow/g);
  expect(matches!.length).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/services/sharing/invitation-service.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement timezone display in invitations**

Modify `src/services/sharing/invitation-service.ts` (or the formatter it uses):
- When formatting invitation message with event time:
  - Always show sender's timezone: `15:00 (Europe/Moscow)`
  - If recipient `onboarding_completed === 1` AND different timezone → append: `/ 14:00 (Europe/Kyiv)`
  - If recipient `onboarding_completed === 0` → show only sender's timezone
  - If same timezone → show once

Find the exact function that formats invitation text (likely in `formatters.ts` or inline in invitation-service) and modify it.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/services/sharing/invitation-service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/sharing/ src/services/event/formatters.ts test/services/sharing/
git commit -m "feat: timezone display in invitation messages"
```

---

## Task 17: IntentLearner Background Agent

**Files:**
- Create: `src/services/intent/intent-learner.ts`
- Create: `src/services/intent/learner-prompt.ts`
- Test: `test/services/intent/intent-learner.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/services/intent/intent-learner.test.ts
test("generates intent from simple tool call", async () => {
  const toolCalls = [{ name: "get_events", input: { start_date: "2026-03-17", end_date: "2026-03-17" } }];
  const result = await learner.analyze("что у меня сегодня", toolCalls, [{ success: true }]);
  expect(result).toBeDefined();
  expect(result!.canonical_name).toBe("show_today");
  expect(result!.phrases).toContain("что у меня сегодня");
  expect(result!.workflow).toBeDefined();
});

test("skips when no tool calls (chat response)", async () => {
  const result = await learner.analyze("привет как дела", [], []);
  expect(result).toBeNull();
});

test("skips when ask_user was called", async () => {
  const toolCalls = [{ name: "ask_user", input: { question: "Which one?" } }];
  const result = await learner.analyze("delete it", toolCalls, []);
  expect(result).toBeNull();
});

test("respects daily budget cap", async () => {
  learner.resetDailyCounter();
  for (let i = 0; i < 100; i++) {
    learner.incrementCounter();
  }
  const result = await learner.analyze("test", [{ name: "get_events", input: {} }], [{ success: true }]);
  expect(result).toBeNull(); // budget exceeded
});

test("deduplicates within 1 hour window", async () => {
  await learner.analyze("что сегодня", [{ name: "get_events", input: {} }], [{ success: true }]);
  const result = await learner.analyze("что сегодня", [{ name: "get_events", input: {} }], [{ success: true }]);
  expect(result).toBeNull(); // already processed recently
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/services/intent/intent-learner.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement IntentLearner**

Create `src/services/intent/intent-learner.ts`:
- `analyze(message, toolCalls, toolResults)`:
  1. Check skip conditions: no tool calls, ask_user used, budget exceeded, dedup hit
  2. Call Anthropic API (Haiku) with learner prompt + tool call data
  3. Parse response as intent record
  4. Check for existing intent with same canonical_name → append phrases if found
  5. Save to DB with `status: pending`
  6. Return intent record (or null if skipped)
- `sendToAdmin(bot, adminId, intent)`: format and send verification message
- Dedup: `recentMessages: Map<normalizedMessage, timestamp>`, cleanup entries older than 1 hour
- Daily counter: `dailyCallCount`, `lastResetDate`, auto-reset at midnight UTC

Create `src/services/intent/learner-prompt.ts`:
- System prompt for Haiku that instructs it to generate intent records from tool call data
- Includes: JSON schema for output, examples, list of built-in variables, format types

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/services/intent/intent-learner.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/intent/intent-learner.ts src/services/intent/learner-prompt.ts test/services/intent/intent-learner.test.ts
git commit -m "feat: IntentLearner background agent with rate limiting"
```

---

## Task 18: Admin Intent Verification UI

**Files:**
- Modify: `src/bot/handlers/callback.handler.ts`
- Modify: `src/bot/handlers/message.handler.ts` (or pipeline layer)
- Test: `test/bot/handlers/intent-verification.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
test("Accept callback approves intent and reloads matcher", async () => {
  const intentId = intentRepo.create({ canonical_name: "test", phrases: ["test"], workflow: {}, format: "text" });
  await handleCallback(ctx, `intent_accept:${intentId}`);
  expect(intentRepo.getById(intentId)!.status).toBe("approved");
  expect(intentMatcher.reload).toHaveBeenCalled();
  expect(ctx.answer).toHaveBeenCalledWith(expect.stringContaining("Approved"));
});

test("Reject callback rejects intent", async () => {
  const intentId = intentRepo.create({ canonical_name: "test2", phrases: ["test2"], workflow: {}, format: "text" });
  await handleCallback(ctx, `intent_reject:${intentId}`);
  expect(intentRepo.getById(intentId)!.status).toBe("rejected");
});

test("Edit callback enters edit mode for admin", async () => {
  const intentId = intentRepo.create({ canonical_name: "test3", phrases: ["test3"], workflow: {}, format: "text" });
  await handleCallback(ctx, `intent_edit:${intentId}`);
  expect(ctx.answer).toHaveBeenCalledWith(expect.stringContaining("Edit"));
  // Admin is now in edit mode for this intent
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/bot/handlers/intent-verification.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement intent verification callbacks**

In `src/bot/handlers/callback.handler.ts`:
- `intent_accept:{id}` → `intentRepo.updateStatus(id, 'approved')`, `intentMatcher.reload()`, answer "Approved"
- `intent_reject:{id}` → `intentRepo.updateStatus(id, 'rejected')`, answer "Rejected"
- `intent_edit:{id}` → store `adminEditSessions.set(adminId, { intentId, state: 'awaiting_instructions' })`, answer "Send edit instructions"

For edit mode: admin's next text message is intercepted (in pipeline, check if admin has active edit session):
- Pass admin instructions + current intent data to AI (Haiku/Sonnet)
- AI generates updated intent record
- Send updated intent preview with `[✅ Accept] [✏️ Edit] [❌ Reject]` buttons again
- Loop until Accept/Reject

Admin edit sessions stored in `Map<adminId, { intentId, state }>` with 10-minute TTL.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/bot/handlers/intent-verification.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/bot/handlers/ test/bot/handlers/intent-verification.test.ts
git commit -m "feat: admin intent verification UI with edit flow"
```

---

## Task 19: Wire IntentLearner into Pipeline

**Files:**
- Modify: `src/bot/pipeline/ai-agent-layer.ts`
- Modify: `src/bot/index.ts`
- Test: `test/bot/pipeline/ai-agent-layer.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
test("IntentLearner fires async after AI response", async () => {
  const learnerSpy = spyOn(intentLearner, "analyze");
  await aiAgentLayer(ctx, "что у меня на завтра");
  // Wait for async learner
  await Bun.sleep(50); // allow async learner to fire
  expect(learnerSpy).toHaveBeenCalled();
  expect(learnerSpy).toHaveBeenCalledWith(
    "что у меня на завтра",
    expect.any(Array), // tool calls
    expect.any(Array)  // tool results
  );
});

test("IntentLearner does not block AI response", async () => {
  // Make learner slow
  spyOn(intentLearner, "analyze").mockImplementation(
    () => new Promise(resolve => setTimeout(resolve, 5000))
  );
  const start = Date.now();
  await aiAgentLayer(ctx, "test");
  expect(Date.now() - start).toBeLessThan(1000); // AI response not blocked
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/bot/pipeline/ai-agent-layer.test.ts`
Expected: FAIL

- [ ] **Step 3: Wire IntentLearner**

In `src/bot/pipeline/ai-agent-layer.ts`:
- After AI agent completes and sends response:
  - Extract tool calls and results from agent run
  - Fire `intentLearner.analyze(message, toolCalls, toolResults)` with `.catch(err => logger.error(err))`
  - Do NOT await — fire and forget with error catching

In `src/bot/index.ts`:
- Create `IntentLearner` instance with dependencies
- Pass to AI agent layer factory

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/bot/pipeline/ai-agent-layer.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/bot/pipeline/ai-agent-layer.ts src/bot/index.ts test/bot/pipeline/
git commit -m "feat: wire IntentLearner async into AI pipeline"
```

---

## Task 20: Integration Test & Final Wiring

**Files:**
- Modify: `src/bot/index.ts` (final DI wiring)
- Create: `test/integration/pipeline.integration.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
// test/integration/pipeline.integration.test.ts
test("full pipeline: intent match bypasses AI", async () => {
  // Setup: approved intent for "что сегодня"
  intentRepo.create({ ... });
  intentRepo.updateStatus(id, "approved");
  intentMatcher.reload();

  // Send message
  await sendMessage(ctx, "что сегодня");

  // Verify: AI was NOT called
  expect(aiAgent.run).not.toHaveBeenCalled();
  // Verify: response was sent
  expect(ctx.send).toHaveBeenCalled();
});

test("full pipeline: unknown message goes to AI, triggers learner", async () => {
  await sendMessage(ctx, "покажи свободное время завтра");
  expect(aiAgent.run).toHaveBeenCalled();
  // Async: learner should have been triggered
  await Bun.sleep(50); // allow async learner to fire
  expect(intentLearner.analyze).toHaveBeenCalled();
});

test("full pipeline: feedback thread enriches AI context", async () => {
  // Setup: open feedback thread
  feedbackRepo.createThread({ user_id: ctx.userId, type: "bug", subject: "Test" });
  feedbackRepo.addMessage({ thread_id: 1, sender: "admin", text: "Can you elaborate?" });

  await sendMessage(ctx, "yes the button is blue and crashes");
  // AI should receive feedbackContext
  expect(aiAgent.run).toHaveBeenCalledWith(
    expect.objectContaining({ feedbackContext: expect.any(Object) })
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/integration/pipeline.integration.test.ts`
Expected: FAIL

- [ ] **Step 3: Final DI wiring in bot/index.ts**

In `src/bot/index.ts`:
- Create instances: `IntentRepository`, `FeedbackRepository`, `IntentMatcher`, `IntentExecutor`, `IntentLearner`
- Create pipeline layers: `intentMatcherLayer`, `feedbackRouterLayer`, `aiAgentLayer`
- Wire into message handler creation

- [ ] **Step 4: Run integration test**

Run: `bun test test/integration/pipeline.integration.test.ts`
Expected: PASS

- [ ] **Step 5: Run full test suite with coverage**

Run: `bun test --coverage`
Expected: ALL PASS, coverage ≥ 80%

- [ ] **Step 6: Run lint**

Run: `bun run lint`
Expected: Zero warnings

- [ ] **Step 7: Commit**

```bash
git add src/bot/index.ts test/integration/
git commit -m "feat: full pipeline integration with DI wiring"
```
