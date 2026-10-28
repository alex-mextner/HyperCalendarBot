> Part 1 of 2 of [Bot UX & Automation System — Implementation Plan](../2026-03-17-bot-ux-automation.md) — next: [02-tasks-10-20.md](02-tasks-10-20.md)

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

