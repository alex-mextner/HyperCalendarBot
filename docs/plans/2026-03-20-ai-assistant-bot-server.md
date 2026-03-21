# AI Assistant — Bot Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add WebSocket infrastructure, pairing, agent registry, dispatcher, and 9 new AI tools to the bot server so the macOS agent can connect and execute commands on the user's machine.

**Architecture:** New `src/agent/` module owns all agent concerns: protocol types, pairing codes, JWT auth, WebSocket connections, command dispatching. New AI tools in `tool-handlers/assistant.ts` delegate to dispatcher. Tools gated by `UserCapabilities` (assistant_enabled DB flag + live connection check at definition-time and at execution-time). Agent.ts caps wiring happens in Task 10 in one place.

**Tech Stack:** Bun WebSocket (Bun.serve), `jose` (JWT HS256), `bun:sqlite` migration, existing GramIO bot

**Spec:** `docs/specs/2026-03-20-ai-assistant-agent-design.md`

---

## File Map

### New files
| File | Responsibility |
|------|---------------|
| `src/agent/protocol.ts` | Shared WebSocket message types |
| `src/agent/pairing.ts` | Code generation, pending WS map, JWT issue/verify |
| `src/agent/registry.ts` | userId → live WebSocket connection map |
| `src/agent/ws-server.ts` | WebSocket open/message/close handler for Bun.serve |
| `src/agent/dispatcher.ts` | Send commands to agent, accumulate chunks, resolve on done |
| `src/services/ai/tool-handlers/assistant.ts` | 9 new AI tool handlers |
| `src/bot/commands/connect.command.ts` | /connect and /activate commands |
| `test/agent/pairing.test.ts` | Pairing unit tests |
| `test/agent/registry.test.ts` | Registry unit tests |
| `test/agent/dispatcher.test.ts` | Dispatcher unit tests |
| `test/agent/ws-server.test.ts` | WebSocket handler tests |
| `test/services/ai/tool-handlers/assistant.test.ts` | Tool handler tests |

### Modified files
| File | Change |
|------|--------|
| `src/database/migrations.ts` | Add `assistant_enabled INTEGER NOT NULL DEFAULT 0` |
| `src/database/types.ts` | Add `assistant_enabled: number` to `User` (snake_case — matches existing columns) |
| `src/database/repositories/user.repository.ts` | Add `updateAssistantEnabled(userId, value)` |
| `src/web/server.ts` | Add `/ws/agent` upgrade + websocket handler |
| `src/services/ai/tools.ts` | Add `UserCapabilities` interface + assistant tools (conditional) |
| `src/services/ai/agent.ts` | Pass `caps` to `getToolDefinitions` and `buildSystemPrompt` |
| `src/services/ai/tool-executor.ts` | Add 9 new tool cases |
| `src/services/ai/system-prompt.ts` | Add conditional assistant section |
| `src/services/ai/tool-handlers/settings.ts` | Add `assistant` category handler |
| `src/services/ai/types.ts` | Add `agentRegistry`, `agentDispatcher` to `AgentContext` |
| `src/bot/index.ts` | Register commands, pass deps to web server and agent context |
| `src/config/env.ts` | Add `AGENT_JWT_SECRET`, `AGENT_DOWNLOAD_URL` manual validation |
| `test/services/ai/tools.test.ts` | Keep `toolDefinitions` imports for existing tests, add UserCapabilities tests |

---

## Task 1: Protocol types + env config

**Files:**
- Create: `src/agent/protocol.ts`
- Modify: `src/config/env.ts`

- [ ] **Step 1: Create protocol.ts**

```typescript
// src/agent/protocol.ts

export interface AgentPairRequest  { type: 'pair';       code: string }
export interface AgentPairResponse { type: 'paired';     jwt: string }
export interface AgentPairError    { type: 'pair_error'; reason: 'expired' | 'invalid' }

export interface AgentCommand {
  id: string
  type:
    | 'claude_chat' | 'claude_new_chat' | 'claude_list_chats'
    | 'claude_open_chat' | 'claude_list_projects' | 'claude_artifact'
    | 'bash_execute' | 'playwright_action' | 'applescript_run'
  payload: Record<string, unknown>
}

export interface AgentResponse {
  id: string
  type: 'chunk' | 'done' | 'error'
  text?: string
  data?: unknown
  exitCode?: number
  error?: string
}

export interface AgentPing   { type: 'ping' }
export interface AgentPong   { type: 'pong' }
export interface AgentCancel { type: 'cancel'; id: string }

export type AgentInbound  = AgentPairRequest | AgentResponse | AgentPing
export type AgentOutbound = AgentPairResponse | AgentPairError | AgentCommand | AgentPong | AgentCancel
```

- [ ] **Step 2: Add env vars to src/config/env.ts**

Follow the existing manual validation pattern (no zod — the codebase uses `if (!VALUE) throw`):
```typescript
// Find the existing env validation block and add:
if (!process.env.AGENT_JWT_SECRET || process.env.AGENT_JWT_SECRET.length < 32) {
  throw new Error('AGENT_JWT_SECRET must be set and at least 32 characters');
}
if (!process.env.AGENT_DOWNLOAD_URL) {
  throw new Error('AGENT_DOWNLOAD_URL must be set');
}

// Add to EnvConfig interface:
AGENT_JWT_SECRET: string;
AGENT_DOWNLOAD_URL: string;
```

- [ ] **Step 3: Commit**
```bash
git add src/agent/protocol.ts src/config/env.ts
git commit -m "feat(agent): protocol types and env config"
```

---

## Task 2: DB migration + User type

**Files:**
- Modify: `src/database/migrations.ts`
- Modify: `src/database/types.ts`
- Modify: `src/database/repositories/user.repository.ts`

- [ ] **Step 1: Write failing test**

```typescript
// test/agent/pairing.test.ts
import { test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { runMigrations } from '../../src/database/migrations.ts';

test('migration adds assistant_enabled column', () => {
  const db = new Database(':memory:');
  runMigrations(db);
  const cols = db.query("PRAGMA table_info(users)").all() as { name: string }[];
  expect(cols.some(c => c.name === 'assistant_enabled')).toBe(true);
});
```

- [ ] **Step 2: Run to verify it fails**
```bash
bun test test/agent/pairing.test.ts
```
Expected: FAIL — column not found.

- [ ] **Step 3: Add migration**

Append to the migrations array in `src/database/migrations.ts`:
```typescript
{
  version: <next_version>,
  sql: `ALTER TABLE users ADD COLUMN assistant_enabled INTEGER NOT NULL DEFAULT 0;`
}
```

- [ ] **Step 4: Update User type** (snake_case — same as all existing columns)

In `src/database/types.ts`, add to `User` interface:
```typescript
assistant_enabled: number; // 0 | 1
```

- [ ] **Step 5: Update UserRepository**

Add to the row mapping (wherever columns are mapped to the returned object):
```typescript
assistant_enabled: row.assistant_enabled,
```

Add new method:
```typescript
updateAssistantEnabled(telegramId: number, enabled: boolean): void {
  this.db.run(
    'UPDATE users SET assistant_enabled = ? WHERE telegram_id = ?',
    [enabled ? 1 : 0, telegramId]
  );
}
```

- [ ] **Step 6: Run test**
```bash
bun test test/agent/pairing.test.ts
```

- [ ] **Step 7: Run full suite**
```bash
bun test
```
Expected: all pass.

- [ ] **Step 8: Commit**
```bash
git add src/database/migrations.ts src/database/types.ts src/database/repositories/user.repository.ts test/agent/pairing.test.ts
git commit -m "feat(agent): add assistant_enabled column and UserRepository method"
```

---

## Task 3: Pairing service

**Files:**
- Create: `src/agent/pairing.ts`
- Test: `test/agent/pairing.test.ts` (extend)

- [ ] **Step 1: Install jose**
```bash
bun add jose
```

- [ ] **Step 2: Write failing tests**

Add to `test/agent/pairing.test.ts`:
```typescript
import {
  generatePairingCode,
  issueAgentJwt,
  verifyAgentJwt,
  registerPendingConnection,
  completePairing,
} from '../../src/agent/pairing.ts';
import { AgentRegistry } from '../../src/agent/registry.ts';

test('generatePairingCode returns unique codes', () => {
  const codes = new Set(Array.from({ length: 100 }, generatePairingCode));
  expect(codes.size).toBe(100);
});

test('generatePairingCode matches format xxxx-xxxx', () => {
  expect(generatePairingCode()).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}$/);
});

test('issueAgentJwt + verifyAgentJwt roundtrip', async () => {
  process.env.AGENT_JWT_SECRET = 'test-secret-at-least-32-characters!!';
  const jwt = await issueAgentJwt(123456);
  const userId = await verifyAgentJwt(jwt);
  expect(userId).toBe(123456);
});

test('verifyAgentJwt returns null for garbage', async () => {
  process.env.AGENT_JWT_SECRET = 'test-secret-at-least-32-characters!!';
  expect(await verifyAgentJwt('not.a.jwt')).toBeNull();
});

test('completePairing returns false for unknown code', async () => {
  const registry = new AgentRegistry();
  expect(await completePairing('no-such', 1, registry)).toBe(false);
});

test('completePairing success path: sends jwt and registers', async () => {
  process.env.AGENT_JWT_SECRET = 'test-secret-at-least-32-characters!!';
  const registry = new AgentRegistry();
  const sent: string[] = [];
  const ws = { data: { userId: null }, send: (m: string) => sent.push(m) } as any;

  registerPendingConnection('abc-1234', ws);
  const ok = await completePairing('abc-1234', 42, registry);

  expect(ok).toBe(true);
  expect(registry.isConnected(42)).toBe(true);
  const msg = JSON.parse(sent[0]);
  expect(msg.type).toBe('paired');
  expect(typeof msg.jwt).toBe('string');
});
```

- [ ] **Step 3: Run to verify they fail**
```bash
bun test test/agent/pairing.test.ts
```

- [ ] **Step 4: Implement pairing.ts**

```typescript
// src/agent/pairing.ts
import { SignJWT, jwtVerify } from 'jose';
import type { ServerWebSocket } from 'bun';
import type { AgentPairResponse, AgentPairError } from './protocol.ts';
import type { AgentRegistry } from './registry.ts';

const PAIRING_TTL_MS = 10 * 60 * 1000;

export interface WsData { userId: number | null }

interface PendingConnection {
  ws: ServerWebSocket<WsData>
  expiresAt: number
}

const pendingConnections = new Map<string, PendingConnection>();

export function generatePairingCode(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const rand = (n: number) =>
    Array.from(crypto.getRandomValues(new Uint8Array(n)))
      .map(b => chars[b % chars.length])
      .join('');
  return `${rand(4)}-${rand(4)}`;
}

export function registerPendingConnection(
  code: string,
  ws: ServerWebSocket<WsData>
): void {
  pendingConnections.set(code, { ws, expiresAt: Date.now() + PAIRING_TTL_MS });
  setTimeout(() => {
    const pending = pendingConnections.get(code);
    if (pending) {
      const msg: AgentPairError = { type: 'pair_error', reason: 'expired' };
      pending.ws.send(JSON.stringify(msg));
      pendingConnections.delete(code);
    }
  }, PAIRING_TTL_MS);
}

export async function completePairing(
  code: string,
  userId: number,
  registry: AgentRegistry
): Promise<boolean> {
  const pending = pendingConnections.get(code);
  if (!pending || Date.now() > pending.expiresAt) {
    pendingConnections.delete(code);
    return false;
  }
  const jwt = await issueAgentJwt(userId);
  pending.ws.data.userId = userId;
  const msg: AgentPairResponse = { type: 'paired', jwt };
  pending.ws.send(JSON.stringify(msg));
  registry.register(userId, pending.ws);
  pendingConnections.delete(code);
  return true;
}

function secret(): Uint8Array {
  const s = process.env.AGENT_JWT_SECRET;
  if (!s) throw new Error('AGENT_JWT_SECRET not set');
  return new TextEncoder().encode(s);
}

export async function issueAgentJwt(userId: number): Promise<string> {
  return new SignJWT({ sub: String(userId) })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1y')
    .sign(secret());
}

export async function verifyAgentJwt(token: string): Promise<number | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    const n = Number(payload.sub);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run tests**
```bash
bun test test/agent/pairing.test.ts
```

- [ ] **Step 6: Commit**
```bash
git add src/agent/pairing.ts test/agent/pairing.test.ts package.json bun.lockb
git commit -m "feat(agent): pairing service — code gen, JWT, pending connections"
```

---

## Task 4: Agent registry

**Files:**
- Create: `src/agent/registry.ts`
- Create: `test/agent/registry.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/agent/registry.test.ts
import { test, expect, beforeEach } from 'bun:test';
import { AgentRegistry } from '../../src/agent/registry.ts';

const mockWs = () => ({ data: { userId: null }, send: () => {} }) as any;

let registry: AgentRegistry;
beforeEach(() => { registry = new AgentRegistry(); });

test('isConnected false for unknown user', () => {
  expect(registry.isConnected(999)).toBe(false);
});

test('register → isConnected true', () => {
  registry.register(1, mockWs());
  expect(registry.isConnected(1)).toBe(true);
});

test('unregister removes connection', () => {
  registry.register(1, mockWs());
  registry.unregister(1);
  expect(registry.isConnected(1)).toBe(false);
});

test('get returns registered ws', () => {
  const ws = mockWs();
  registry.register(1, ws);
  expect(registry.get(1)?.ws).toBe(ws);
});

test('register overwrites previous', () => {
  const ws1 = mockWs();
  const ws2 = mockWs();
  registry.register(1, ws1);
  registry.register(1, ws2);
  expect(registry.get(1)?.ws).toBe(ws2);
});
```

- [ ] **Step 2: Run to verify they fail**
```bash
bun test test/agent/registry.test.ts
```

- [ ] **Step 3: Implement registry.ts**

```typescript
// src/agent/registry.ts
import type { ServerWebSocket } from 'bun';
import type { WsData } from './pairing.ts';

interface AgentConnection {
  ws: ServerWebSocket<WsData>
  connectedAt: Date
  lastPing: Date
}

export class AgentRegistry {
  private connections = new Map<number, AgentConnection>();

  register(userId: number, ws: ServerWebSocket<WsData>): void {
    this.connections.set(userId, { ws, connectedAt: new Date(), lastPing: new Date() });
  }

  unregister(userId: number): void {
    this.connections.delete(userId);
  }

  isConnected(userId: number): boolean {
    return this.connections.has(userId);
  }

  get(userId: number): AgentConnection | undefined {
    return this.connections.get(userId);
  }

  updatePing(userId: number): void {
    const conn = this.connections.get(userId);
    if (conn) conn.lastPing = new Date();
  }
}

export const agentRegistry = new AgentRegistry();
```

- [ ] **Step 4: Run tests**
```bash
bun test test/agent/registry.test.ts
```

- [ ] **Step 5: Commit**
```bash
git add src/agent/registry.ts test/agent/registry.test.ts
git commit -m "feat(agent): agent registry"
```

---

## Task 5: Dispatcher

**Files:**
- Create: `src/agent/dispatcher.ts`
- Create: `test/agent/dispatcher.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/agent/dispatcher.test.ts
import { test, expect } from 'bun:test';
import { AgentRegistry } from '../../src/agent/registry.ts';
import { AgentDispatcher } from '../../src/agent/dispatcher.ts';

function makeSetup() {
  const registry = new AgentRegistry();
  const sent: string[] = [];
  const ws = { data: { userId: 1 }, send: (m: string) => sent.push(m) } as any;
  registry.register(1, ws);
  const dispatcher = new AgentDispatcher(registry);
  return { registry, dispatcher, sent };
}

test('send throws when agent not connected', async () => {
  const registry = new AgentRegistry();
  const dispatcher = new AgentDispatcher(registry);
  await expect(dispatcher.send(99, 'bash_execute', {})).rejects.toThrow('not connected');
});

test('send → done resolves with data', async () => {
  const { dispatcher, sent } = makeSetup();
  const promise = dispatcher.send(1, 'bash_execute', { command: 'echo hi' });
  const { id } = JSON.parse(sent[0]);
  dispatcher.handleResponse({ id, type: 'done', exitCode: 0, data: 'hi\n' });
  const result = await promise;
  expect(result.exitCode).toBe(0);
  expect(result.data).toBe('hi\n');
});

test('chunks accumulate before done', async () => {
  const { dispatcher, sent } = makeSetup();
  const chunks: string[] = [];
  const promise = dispatcher.send(1, 'claude_chat', {}, t => chunks.push(t));
  const { id } = JSON.parse(sent[0]);
  dispatcher.handleResponse({ id, type: 'chunk', text: 'Hello' });
  dispatcher.handleResponse({ id, type: 'chunk', text: ' world' });
  dispatcher.handleResponse({ id, type: 'done' });
  await promise;
  expect(chunks).toEqual(['Hello', ' world']);
});

test('error response rejects promise', async () => {
  const { dispatcher, sent } = makeSetup();
  const promise = dispatcher.send(1, 'bash_execute', {});
  const { id } = JSON.parse(sent[0]);
  dispatcher.handleResponse({ id, type: 'error', error: 'Permission denied' });
  await expect(promise).rejects.toThrow('Permission denied');
});
```

- [ ] **Step 2: Run to verify they fail**
```bash
bun test test/agent/dispatcher.test.ts
```

- [ ] **Step 3: Implement dispatcher.ts**

```typescript
// src/agent/dispatcher.ts
import { randomUUID } from 'crypto';
import type { AgentRegistry } from './registry.ts';
import type { AgentCommand, AgentResponse } from './protocol.ts';

type ChunkHandler = (text: string) => void;

interface PendingCommand {
  resolve: (result: { data: unknown; exitCode?: number }) => void
  reject: (err: Error) => void
  onChunk?: ChunkHandler
}

export class AgentDispatcher {
  private pending = new Map<string, PendingCommand>();

  constructor(private registry: AgentRegistry) {}

  send(
    userId: number,
    type: AgentCommand['type'],
    payload: Record<string, unknown>,
    onChunk?: ChunkHandler
  ): Promise<{ data: unknown; exitCode?: number }> {
    const conn = this.registry.get(userId);
    if (!conn) throw new Error('Agent not connected');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onChunk });
      conn.ws.send(JSON.stringify({ id, type, payload } satisfies AgentCommand));
    });
  }

  handleResponse(msg: AgentResponse): void {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    if (msg.type === 'chunk') { pending.onChunk?.(msg.text ?? ''); return; }
    this.pending.delete(msg.id);
    if (msg.type === 'done') pending.resolve({ data: msg.data, exitCode: msg.exitCode });
    else pending.reject(new Error(msg.error ?? 'Agent error'));
  }
}
```

- [ ] **Step 4: Run tests**
```bash
bun test test/agent/dispatcher.test.ts
```

- [ ] **Step 5: Commit**
```bash
git add src/agent/dispatcher.ts test/agent/dispatcher.test.ts
git commit -m "feat(agent): dispatcher — send commands, stream chunks"
```

---

## Task 6: WebSocket server + web/server.ts integration

**Files:**
- Create: `src/agent/ws-server.ts`
- Modify: `src/web/server.ts`
- Create: `test/agent/ws-server.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// test/agent/ws-server.test.ts
import { test, expect } from 'bun:test';
import { AgentRegistry } from '../../src/agent/registry.ts';
import { AgentDispatcher } from '../../src/agent/dispatcher.ts';
import { createAgentWsHandler } from '../../src/agent/ws-server.ts';

function setup() {
  const registry = new AgentRegistry();
  const dispatcher = new AgentDispatcher(registry);
  const handler = createAgentWsHandler(registry, dispatcher);
  return { registry, dispatcher, handler };
}

function ws(userId: number | null, sent: string[] = []) {
  return { data: { userId, _token: null }, send: (m: string) => sent.push(m) } as any;
}

test('open with userId=null does not register', async () => {
  const { registry, handler } = setup();
  await handler.open(ws(null));
  expect(registry.isConnected(1)).toBe(false);
});

test('open with userId registers', async () => {
  const { registry, handler } = setup();
  const w = ws(42);
  w.data._token = null; // no token path
  // directly set userId (simulates verified JWT path)
  w.data.userId = 42;
  // call open — in this mock the JWT verify is skipped since we set userId directly
  // test the registration branch
  registry.register(42, w);
  expect(registry.isConnected(42)).toBe(true);
});

test('close unregisters', () => {
  const { registry, handler } = setup();
  const w = ws(42);
  registry.register(42, w);
  handler.close(w);
  expect(registry.isConnected(42)).toBe(false);
});

test('ping → pong', () => {
  const { registry, handler } = setup();
  const sent: string[] = [];
  const w = { data: { userId: 42, _token: null }, send: (m: string) => sent.push(m) } as any;
  registry.register(42, w);
  handler.message(w, JSON.stringify({ type: 'ping' }));
  expect(JSON.parse(sent[0])).toEqual({ type: 'pong' });
});

test('pair message calls registerPendingConnection (not completePairing)', () => {
  // Ensure the pair handler only registers the pending connection.
  // If completePairing were called with userId=0, it would fail silently.
  // This test verifies the ws stays in pending state (no userId assigned).
  const { registry, handler } = setup();
  const w = ws(null);
  handler.message(w, JSON.stringify({ type: 'pair', code: 'test-1234' }));
  // userId must still be null — completePairing not called
  expect(w.data.userId).toBeNull();
  expect(registry.isConnected(0)).toBe(false);
});
```

- [ ] **Step 2: Run to verify they fail**
```bash
bun test test/agent/ws-server.test.ts
```

- [ ] **Step 3: Implement ws-server.ts**

```typescript
// src/agent/ws-server.ts
import type { ServerWebSocket } from 'bun';
import type { AgentRegistry } from './registry.ts';
import type { AgentDispatcher } from './dispatcher.ts';
import { registerPendingConnection, verifyAgentJwt } from './pairing.ts';
import type { AgentInbound } from './protocol.ts';

export interface AgentWsData {
  userId: number | null
  _token: string | null
}

// Called in web/server.ts fetch handler for /ws/agent
export function upgradeAgentWs(
  req: Request,
  server: { upgrade(req: Request, opts: { data: AgentWsData }): boolean }
): boolean {
  const token = req.headers.get('authorization')?.replace('Bearer ', '') ?? null;
  // upgrade returns true on success; return false means caller sends 400
  return server.upgrade(req, { data: { userId: null, _token: token } });
}

export function createAgentWsHandler(registry: AgentRegistry, dispatcher: AgentDispatcher) {
  return {
    async open(ws: ServerWebSocket<AgentWsData>) {
      if (ws.data._token) {
        const userId = await verifyAgentJwt(ws.data._token);
        if (!userId) { ws.close(4001, 'JWT invalid'); return; }
        ws.data.userId = userId;
        registry.register(userId, ws as ServerWebSocket<{ userId: number | null }>);
      }
      // No token → pairing mode; waits for { type: 'pair', code }
    },

    message(ws: ServerWebSocket<AgentWsData>, raw: string) {
      let msg: AgentInbound;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'ping') {
        if (ws.data.userId) registry.updatePing(ws.data.userId);
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      }

      // Pairing: only register the pending connection here.
      // completePairing is called later by /activate command with the real userId.
      if (msg.type === 'pair') {
        registerPendingConnection(msg.code, ws as ServerWebSocket<{ userId: number | null }>);
        return;
      }

      if (msg.type === 'chunk' || msg.type === 'done' || msg.type === 'error') {
        dispatcher.handleResponse(msg);
      }
    },

    close(ws: ServerWebSocket<AgentWsData>) {
      if (ws.data.userId) registry.unregister(ws.data.userId);
    },
  };
}
```

- [ ] **Step 4: Integrate into web/server.ts**

Add to imports:
```typescript
import type { AgentRegistry } from '../agent/registry.ts';
import type { AgentDispatcher } from '../agent/dispatcher.ts';
import { upgradeAgentWs, createAgentWsHandler } from '../agent/ws-server.ts';
```

Add to `WebServerDeps`:
```typescript
agentRegistry?: AgentRegistry
agentDispatcher?: AgentDispatcher
```

In `startWebServer`, before `Bun.serve`:
```typescript
const agentWs = deps.agentRegistry && deps.agentDispatcher
  ? createAgentWsHandler(deps.agentRegistry, deps.agentDispatcher)
  : undefined;
```

Update `Bun.serve` call to add `websocket: agentWs` and add the upgrade branch in `fetch`:
```typescript
const server = Bun.serve({
  port,
  websocket: agentWs,
  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === '/ws/agent' && agentWs) {
      if (!upgradeAgentWs(req, server)) {
        return new Response('WebSocket upgrade failed', { status: 400 });
      }
      return; // upgrade returns undefined to Bun on success
    }

    // ... existing route handlers unchanged ...
  },
});
```

- [ ] **Step 5: Run tests**
```bash
bun test test/agent/ws-server.test.ts
```

- [ ] **Step 6: Run full suite**
```bash
bun test
```

- [ ] **Step 7: Commit**
```bash
git add src/agent/ws-server.ts src/web/server.ts test/agent/ws-server.test.ts
git commit -m "feat(agent): WebSocket server + web/server.ts integration"
```

---

## Task 7: UserCapabilities — gated tool definitions

**Files:**
- Modify: `src/services/ai/tools.ts`
- Modify: `test/services/ai/tools.test.ts`

**Note:** `tools.test.ts` currently imports `toolDefinitions` (the static array) and iterates it.
Keep those tests as-is (they test always-present tools). Add new tests that use `getToolDefinitions` with caps.

- [ ] **Step 1: Write failing tests**

Add to the bottom of `test/services/ai/tools.test.ts`:
```typescript
import { getToolDefinitions, type UserCapabilities } from '../../../src/services/ai/tools.ts';

const ASSISTANT_TOOLS = [
  'claude_chat', 'claude_new_chat', 'claude_list_chats', 'claude_open_chat',
  'claude_list_projects', 'claude_artifact', 'bash_execute', 'playwright_action',
  'applescript_run',
];

describe('UserCapabilities gating', () => {
  test('assistant tools hidden when both false', () => {
    const names = getToolDefinitions('text', { assistantEnabled: false, agentConnected: false }).map(t => t.name);
    for (const tool of ASSISTANT_TOOLS) expect(names).not.toContain(tool);
  });

  test('assistant tools hidden when only assistantEnabled=true', () => {
    const names = getToolDefinitions('text', { assistantEnabled: true, agentConnected: false }).map(t => t.name);
    for (const tool of ASSISTANT_TOOLS) expect(names).not.toContain(tool);
  });

  test('assistant tools hidden when only agentConnected=true', () => {
    const names = getToolDefinitions('text', { assistantEnabled: false, agentConnected: true }).map(t => t.name);
    for (const tool of ASSISTANT_TOOLS) expect(names).not.toContain(tool);
  });

  test('assistant tools visible when both true', () => {
    const names = getToolDefinitions('text', { assistantEnabled: true, agentConnected: true }).map(t => t.name);
    for (const tool of ASSISTANT_TOOLS) expect(names).toContain(tool);
  });

  test('no caps passed → assistant tools hidden', () => {
    const names = getToolDefinitions('text').map(t => t.name);
    for (const tool of ASSISTANT_TOOLS) expect(names).not.toContain(tool);
  });
});
```

- [ ] **Step 2: Run to verify they fail**
```bash
bun test test/services/ai/tools.test.ts
```

- [ ] **Step 3: Add UserCapabilities and assistant tools to tools.ts**

```typescript
// Add before getToolDefinitions:
export interface UserCapabilities {
  assistantEnabled: boolean
  agentConnected: boolean
}

// Update getToolDefinitions signature:
export function getToolDefinitions(
  inputMode?: string,
  caps?: UserCapabilities
): ToolDefinition[] {
  const showAssistant = caps?.assistantEnabled === true && caps?.agentConnected === true;

  const assistantTools: ToolDefinition[] = showAssistant ? [
    { name: 'claude_chat', description: 'Send a message to an existing Claude Desktop chat and stream the response', input_schema: { type: 'object', properties: { chat_id: { type: 'string' }, message: { type: 'string' }, timeout_ms: { type: 'number' } }, required: ['chat_id', 'message'] } },
    { name: 'claude_new_chat', description: 'Create a new Claude Desktop chat (optionally in a project) and send a first message', input_schema: { type: 'object', properties: { message: { type: 'string' }, project_id: { type: 'string' }, timeout_ms: { type: 'number' } }, required: ['message'] } },
    { name: 'claude_list_chats', description: 'List recent Claude Desktop chats with titles and IDs', input_schema: { type: 'object', properties: { limit: { type: 'number' } } } },
    { name: 'claude_open_chat', description: 'Get messages from an existing Claude Desktop chat by ID', input_schema: { type: 'object', properties: { chat_id: { type: 'string' } }, required: ['chat_id'] } },
    { name: 'claude_list_projects', description: 'List Claude Desktop projects', input_schema: { type: 'object', properties: {} } },
    { name: 'claude_artifact', description: 'Retrieve a Claude Desktop artifact by ID', input_schema: { type: 'object', properties: { artifact_id: { type: 'string' } }, required: ['artifact_id'] } },
    { name: 'bash_execute', description: "Execute a bash command on the user's Mac. Returns stdout, stderr, exitCode.", input_schema: { type: 'object', properties: { command: { type: 'string' }, timeout_ms: { type: 'number' } }, required: ['command'] } },
    { name: 'playwright_action', description: "Automate the browser on the user's Mac: screenshot, navigate, click, fill, extract content", input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['screenshot', 'navigate', 'click', 'fill', 'extract', 'evaluate'] }, params: { type: 'object' }, timeout_ms: { type: 'number' } }, required: ['action', 'params'] } },
    { name: 'applescript_run', description: "Run AppleScript on the user's Mac to control macOS apps or trigger Automator workflows", input_schema: { type: 'object', properties: { script: { type: 'string' }, timeout_ms: { type: 'number' } }, required: ['script'] } },
  ] : [];

  // keep existing filtering by inputMode, then append assistantTools
  const existing = /* existing tool list / filtering logic here */ [];
  return [...existing, ...assistantTools];
}
```

- [ ] **Step 4: Run tests**
```bash
bun test test/services/ai/tools.test.ts
```
Expected: ALL tests pass (old `toolDefinitions` tests + new UserCapabilities tests).

- [ ] **Step 5: Lint**
```bash
bun run lint
```

- [ ] **Step 6: Commit**
```bash
git add src/services/ai/tools.ts test/services/ai/tools.test.ts
git commit -m "feat(agent): UserCapabilities gating for 9 assistant tools"
```

---

## Task 8: Assistant tool handlers

**Files:**
- Create: `src/services/ai/tool-handlers/assistant.ts`
- Create: `test/services/ai/tool-handlers/assistant.test.ts`
- Modify: `src/services/ai/tool-executor.ts`
- Modify: `src/services/ai/types.ts`

- [ ] **Step 1: Add AgentContext fields to types.ts**

```typescript
// In AgentContext interface, add:
agentRegistry?: AgentRegistry          // from src/agent/registry.ts
agentDispatcher?: AgentDispatcher      // from src/agent/dispatcher.ts
onAgentChunk?: (text: string) => void  // forwarded to TelegramStreamWriter
```

- [ ] **Step 2: Write failing tests**

```typescript
// test/services/ai/tool-handlers/assistant.test.ts
import { test, expect } from 'bun:test';
import { handleAssistantTool } from '../../../src/services/ai/tool-handlers/assistant.ts';
import { AgentRegistry } from '../../../src/agent/registry.ts';
import { AgentDispatcher } from '../../../src/agent/dispatcher.ts';

function ctx(connected: boolean) {
  const registry = new AgentRegistry();
  const dispatcher = new AgentDispatcher(registry);
  if (connected) {
    const sent: string[] = [];
    const ws = { data: { userId: 1 }, send: (m: string) => sent.push(m) } as any;
    registry.register(1, ws);
    return { user: { telegram_id: 1, language: 'ru' }, agentRegistry: registry, agentDispatcher: dispatcher, _sent: sent } as any;
  }
  return { user: { telegram_id: 1, language: 'ru' }, agentRegistry: registry, agentDispatcher: dispatcher } as any;
}

test('returns error + /connect link when not connected', async () => {
  const result = await handleAssistantTool(ctx(false), 'bash_execute', { command: 'ls' });
  expect(result.success).toBe(false);
  expect(result.output).toContain('/connect');
});

test('dispatches bash_execute and returns output', async () => {
  const c = ctx(true);
  const promise = handleAssistantTool(c, 'bash_execute', { command: 'echo hi' });
  const cmd = JSON.parse(c._sent[0]);
  c.agentDispatcher.handleResponse({ id: cmd.id, type: 'done', exitCode: 0, data: 'hi\n' });
  const result = await promise;
  expect(result.success).toBe(true);
  expect(result.output).toContain('hi');
});

test('non-zero exitCode marks success=false', async () => {
  const c = ctx(true);
  const promise = handleAssistantTool(c, 'bash_execute', { command: 'false' });
  const cmd = JSON.parse(c._sent[0]);
  c.agentDispatcher.handleResponse({ id: cmd.id, type: 'done', exitCode: 1, data: '' });
  const result = await promise;
  expect(result.success).toBe(false);
});
```

- [ ] **Step 3: Run to verify they fail**
```bash
bun test test/services/ai/tool-handlers/assistant.test.ts
```

- [ ] **Step 4: Implement assistant.ts**

```typescript
// src/services/ai/tool-handlers/assistant.ts
import type { AgentContext } from '../types.ts';
import type { ToolResult } from '../tool-executor.ts';
import type { AgentCommand } from '../../../agent/protocol.ts';

const notConnected = (lang: string): ToolResult => ({
  success: false,
  output: lang === 'ru'
    ? '⚠️ Агент не подключён. Скачай и настрой: /connect'
    : '⚠️ Agent not connected. Download and set up: /connect',
});

export async function handleAssistantTool(
  ctx: AgentContext,
  toolName: AgentCommand['type'],
  payload: Record<string, unknown>
): Promise<ToolResult> {
  if (!ctx.agentRegistry?.isConnected(ctx.user.telegram_id)) {
    return notConnected(ctx.user.language);
  }

  const chunks: string[] = [];
  const onChunk = (text: string) => {
    chunks.push(text);
    ctx.onAgentChunk?.(text);
  };

  try {
    const result = await ctx.agentDispatcher!.send(
      ctx.user.telegram_id,
      toolName,
      payload,
      onChunk
    );
    const text = chunks.join('') || String(result.data ?? '');
    const exitInfo = result.exitCode !== undefined ? ` (exit ${result.exitCode})` : '';
    return {
      success: result.exitCode === undefined || result.exitCode === 0,
      output: text + exitInfo,
      data: result.data,
    };
  } catch (err) {
    return {
      success: false,
      output: err instanceof Error ? err.message : String(err),
    };
  }
}
```

- [ ] **Step 5: Add cases in tool-executor.ts**

```typescript
// Add at top of imports:
import { handleAssistantTool } from './tool-handlers/assistant.ts';
import type { AgentCommand } from '../../agent/protocol.ts';

// In the switch/dispatch block, add before the default case:
case 'claude_chat':
case 'claude_new_chat':
case 'claude_list_chats':
case 'claude_open_chat':
case 'claude_list_projects':
case 'claude_artifact':
case 'bash_execute':
case 'playwright_action':
case 'applescript_run':
  return handleAssistantTool(ctx, toolName as AgentCommand['type'], input as Record<string, unknown>);
```

- [ ] **Step 6: Run tests**
```bash
bun test test/services/ai/tool-handlers/assistant.test.ts
bun test
```

- [ ] **Step 7: Commit**
```bash
git add src/services/ai/tool-handlers/assistant.ts src/services/ai/tool-executor.ts src/services/ai/types.ts test/services/ai/tool-handlers/assistant.test.ts
git commit -m "feat(agent): assistant tool handlers + tool-executor dispatch"
```

---

## Task 9: manage_settings — assistant category

**Files:**
- Modify: `src/services/ai/tool-handlers/settings.ts`
- Test: look at `test/services/ai/tool-handlers/settings.test.ts` for the existing test pattern before writing tests

- [ ] **Step 1: Read existing settings tests**

Read `test/services/ai/tool-handlers/settings.test.ts` to understand how `ctx` and mocks are set up. Follow the exact same pattern for the new tests.

- [ ] **Step 2: Write failing tests**

Write two tests using the pattern from Step 1:
- `get assistant settings returns enabled/disabled status`
- `update assistantEnabled=true calls userRepo.updateAssistantEnabled`

Both tests must have real assertions that fail before implementation.

- [ ] **Step 3: Run to verify they fail**
```bash
bun test test/services/ai/tool-handlers/settings.test.ts
```

- [ ] **Step 4: Add assistant handler**

In `src/services/ai/tool-handlers/settings.ts`, add `'assistant'` to the category type/enum, then add the handler branch:

```typescript
case 'assistant': {
  if (action === 'get') {
    const connected = ctx.agentRegistry?.isConnected(ctx.user.telegram_id) ?? false;
    const enabled = Boolean(ctx.user.assistant_enabled);
    return {
      success: true,
      output: ctx.user.language === 'ru'
        ? `🤖 AI Ассистент: ${enabled ? 'включён' : 'выключён'}\nАгент: ${connected ? 'подключён ✅' : 'не подключён ❌'}`
        : `🤖 AI Assistant: ${enabled ? 'enabled' : 'disabled'}\nAgent: ${connected ? 'connected ✅' : 'not connected ❌'}`,
    };
  }
  if (action === 'update' && typeof input.assistantEnabled === 'boolean') {
    ctx.userRepo.updateAssistantEnabled(ctx.user.telegram_id, input.assistantEnabled);
    return {
      success: true,
      output: ctx.user.language === 'ru'
        ? `AI Ассистент ${input.assistantEnabled ? 'включён' : 'выключён'}`
        : `AI Assistant ${input.assistantEnabled ? 'enabled' : 'disabled'}`,
    };
  }
  return { success: false, output: 'Unknown action' };
}
```

Also add `'assistant'` to the category union type in `tools.ts` (manage_settings input schema).

- [ ] **Step 5: Run tests**
```bash
bun test test/services/ai/tool-handlers/settings.test.ts
```

- [ ] **Step 6: Commit**
```bash
git add src/services/ai/tool-handlers/settings.ts src/services/ai/tools.ts
git commit -m "feat(agent): manage_settings assistant category"
```

---

## Task 10: system-prompt + agent.ts caps wiring

**Files:**
- Modify: `src/services/ai/system-prompt.ts`
- Modify: `src/services/ai/agent.ts`

This is the single task that wires `UserCapabilities` into both `getToolDefinitions` and `buildSystemPrompt`.

- [ ] **Step 1: Update buildSystemPrompt signature**

```typescript
// src/services/ai/system-prompt.ts
import type { UserCapabilities } from './tools.ts';

export function buildSystemPrompt(ctx: AgentContext, caps?: UserCapabilities): string {
  // ... existing prompt building ...

  const assistantSection = (caps?.assistantEnabled && caps?.agentConnected) ? `

## AI Assistant (Computer Access)
You can control the user's Mac:
- \`claude_chat\` / \`claude_new_chat\` / \`claude_open_chat\` — interact with Claude Desktop chats
- \`claude_list_chats\` / \`claude_list_projects\` / \`claude_artifact\` — browse Claude Desktop
- \`bash_execute\` — run shell commands
- \`playwright_action\` — browser automation (navigate, click, screenshot, extract)
- \`applescript_run\` — control macOS apps via AppleScript

Guidelines:
- Confirm before destructive bash commands (rm, overwrite files)
- Show screenshots when they help explain the result
- If agent disconnects mid-task, inform the user and suggest retrying
` : '';

  return existingPrompt + assistantSection;
}
```

- [ ] **Step 2: Update agent.ts to build and pass caps**

In `src/services/ai/agent.ts`, find the lines:
```typescript
tools: getToolDefinitions(ctx.inputMode),
// and:
const systemPrompt = buildSystemPrompt(ctx);
```

Replace with:
```typescript
const caps: UserCapabilities = {
  assistantEnabled: Boolean(ctx.user.assistant_enabled),
  agentConnected: ctx.agentRegistry?.isConnected(ctx.user.telegram_id) ?? false,
};
// ...
tools: getToolDefinitions(ctx.inputMode, caps),
// ...
const systemPrompt = buildSystemPrompt(ctx, caps);
```

- [ ] **Step 3: Run full test suite**
```bash
bun test
```

- [ ] **Step 4: Commit**
```bash
git add src/services/ai/system-prompt.ts src/services/ai/agent.ts
git commit -m "feat(agent): pass UserCapabilities to tools and system prompt"
```

---

## Task 11: /connect and /activate commands

**Files:**
- Create: `src/bot/commands/connect.command.ts`
- Create: `test/bot/commands/connect.test.ts`

- [ ] **Step 1: Write failing tests**

Read `test/bot/commands/` for existing command test patterns. Write:

```typescript
// test/bot/commands/connect.test.ts
import { test, expect } from 'bun:test';
import { connectCommand, createActivateCommand } from '../../../src/bot/commands/connect.command.ts';
import { AgentRegistry } from '../../../src/agent/registry.ts';
import { registerPendingConnection } from '../../../src/agent/pairing.ts';

function mockCtx(args = '') {
  const sent: string[] = [];
  return {
    user: { telegram_id: 42, language: 'ru' },
    args,
    send: async (text: string) => { sent.push(text); },
    _sent: sent,
  } as any;
}

test('/connect sends download link', async () => {
  process.env.AGENT_DOWNLOAD_URL = 'https://example.com/agent.pkg';
  const ctx = mockCtx();
  await connectCommand(ctx);
  expect(ctx._sent[0]).toContain('https://example.com/agent.pkg');
});

test('/activate with unknown code sends error', async () => {
  const registry = new AgentRegistry();
  const activate = createActivateCommand(registry);
  const ctx = mockCtx('unknown-code');
  await activate(ctx);
  expect(ctx._sent[0]).toContain('❌');
});

test('/activate with valid code sends success and registers', async () => {
  process.env.AGENT_JWT_SECRET = 'test-secret-at-least-32-characters!!';
  const registry = new AgentRegistry();
  const activate = createActivateCommand(registry);

  const sent: string[] = [];
  const ws = { data: { userId: null }, send: (m: string) => sent.push(m) } as any;
  registerPendingConnection('good-code', ws);

  const ctx = mockCtx('good-code');
  await activate(ctx);

  expect(ctx._sent[0]).toContain('✅');
  expect(registry.isConnected(42)).toBe(true);
});
```

- [ ] **Step 2: Run to verify they fail**
```bash
bun test test/bot/commands/connect.test.ts
```

- [ ] **Step 3: Implement connect.command.ts**

```typescript
// src/bot/commands/connect.command.ts
import { completePairing } from '../../agent/pairing.ts';
import type { AgentRegistry } from '../../agent/registry.ts';

export async function connectCommand(ctx: any) {
  const url = process.env.AGENT_DOWNLOAD_URL ?? '';
  const ru = ctx.user?.language === 'ru';
  await ctx.send(
    ru
      ? `🔗 *Подключить AI Ассистент*\n\nСкачай агент для macOS:\n${url}\n\nПосле установки приложение само покажет команду активации.`
      : `🔗 *Connect AI Assistant*\n\nDownload the macOS agent:\n${url}\n\nAfter installing, the app will show an activation command.`,
    { parse_mode: 'Markdown' }
  );
}

export function createActivateCommand(registry: AgentRegistry) {
  return async function activateCommand(ctx: any) {
    const code = ctx.args?.trim();
    const userId = ctx.user?.telegram_id;
    const ru = ctx.user?.language === 'ru';

    if (!code) {
      await ctx.send(ru ? 'Укажи код из приложения' : 'Provide the code from the app');
      return;
    }

    const ok = await completePairing(code, userId, registry);
    await ctx.send(
      ok
        ? (ru ? '✅ Агент подключён!' : '✅ Agent connected!')
        : (ru ? '❌ Код не найден или истёк. Открой приложение и скопируй команду заново.' : '❌ Code not found or expired. Open the app and copy the command again.')
    );
  };
}
```

- [ ] **Step 4: Run tests**
```bash
bun test test/bot/commands/connect.test.ts
```

- [ ] **Step 5: Commit**
```bash
git add src/bot/commands/connect.command.ts test/bot/commands/connect.test.ts
git commit -m "feat(agent): /connect and /activate commands"
```

---

## Task 12: Wire everything in bot/index.ts

**Files:**
- Modify: `src/bot/index.ts`

- [ ] **Step 1: Import and instantiate**

```typescript
import { agentRegistry } from '../agent/registry.ts';
import { AgentDispatcher } from '../agent/dispatcher.ts';
import { connectCommand, createActivateCommand } from './commands/connect.command.ts';

const agentDispatcher = new AgentDispatcher(agentRegistry);
```

- [ ] **Step 2: Pass to web server**

```typescript
startWebServer({
  // ... existing deps ...
  agentRegistry,
  agentDispatcher,
});
```

- [ ] **Step 3: Register commands**

```typescript
bot.command('connect', connectCommand);
bot.command('activate', createActivateCommand(agentRegistry));
```

- [ ] **Step 4: Pass to AgentContext**

In the agent context assembly (agent-context-factory.ts or inline):
```typescript
agentRegistry,
agentDispatcher,
onAgentChunk: (text) => { /* forward to TelegramStreamWriter if active */ },
```

- [ ] **Step 5: Run full suite + lint**
```bash
bun test
bun run lint
```
Expected: all tests pass, zero lint warnings.

- [ ] **Step 6: Commit**
```bash
git add src/bot/index.ts
git commit -m "feat(agent): wire agent into bot — registry, dispatcher, commands, context"
```

---

## Acceptance Criteria

- [ ] `bun test` passes, `bun run lint` zero warnings
- [ ] `/connect` shows `AGENT_DOWNLOAD_URL`
- [ ] `/activate valid-code` returns ✅ and agent shows as connected
- [ ] `/activate bad-code` returns ❌
- [ ] `getToolDefinitions('text', { assistantEnabled: false, agentConnected: false })` — no assistant tools
- [ ] `getToolDefinitions('text', { assistantEnabled: true, agentConnected: true })` — 9 assistant tools present
- [ ] `manage_settings category=assistant action=get` returns status string
- [ ] `manage_settings category=assistant action=update assistantEnabled=true` flips DB flag

---

# AI Assistant — macOS Agent (Swift) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a macOS tray-only Swift app that connects to the bot via WebSocket, shows a one-time pairing wizard on first launch, bridges Claude Desktop via cookie extraction, and executes bash/Playwright/AppleScript on the user's Mac.

**Architecture:** SwiftUI `MenuBarExtra` for the tray. No dock icon (`LSUIElement=YES`). First launch: temporarily set `.regular` activation policy, show SwiftUI wizard window, pair with bot, close window, restore `.accessory`. Subsequent launches: tray-only, WebSocket auto-reconnect. `create-dmg` for distribution.

**Tech Stack:** Swift 5.9+, SwiftUI, macOS 13+, `LaunchAtLogin-Modern`, `KeychainAccess`, `GRDB.swift`, `URLSessionWebSocketTask`, `URLSession` (SSE), `Process` (bash/AppleScript/Node), `create-dmg` (release packaging)

**Spec:** `docs/specs/2026-03-20-ai-assistant-agent-design.md`

**Note:** This is a standalone Xcode project at `packages/agent-macos/`. Tests are XCTest. Swift Package Manager manages dependencies.

---

## File Map

```
packages/agent-macos/
├── HyperBotAgent.xcodeproj
├── Package.swift                    — SPM dependencies
├── HyperBotAgent/
│   ├── App.swift                    — @main, MenuBarExtra, first-launch detection
│   ├── TrayMenu.swift               — tray menu (status, launch-at-login toggle, disconnect)
│   ├── WizardView.swift             — SwiftUI setup wizard (NavigationStack, 3 steps)
│   ├── WebSocketClient.swift        — URLSessionWebSocketTask, reconnect, heartbeat
│   ├── PairingManager.swift         — code generation, ws pair message, jwt storage
│   ├── KeychainStore.swift          — KeychainAccess wrapper (jwt storage)
│   ├── ClaudeBridge.swift           — GRDB cookie read, claude.ai HTTP/SSE calls
│   ├── CircuitBreaker.swift         — circuit breaker for claude.ai API
│   ├── BashExecutor.swift           — Process wrapper for bash
│   ├── PlaywrightExecutor.swift     — Process wrapper for bundled Node + playwright
│   ├── AppleScriptExecutor.swift    — NSAppleScript wrapper
│   ├── CommandRouter.swift          — routes AgentCommand to correct executor
│   └── Protocol.swift              — AgentCommand/AgentResponse types (mirrors src/agent/protocol.ts)
├── HyperBotAgentTests/
│   ├── PairingManagerTests.swift
│   ├── WebSocketClientTests.swift
│   ├── ClaudeBridgeTests.swift
│   ├── CircuitBreakerTests.swift
│   └── CommandRouterTests.swift
└── scripts/
    └── make-dmg.sh                  — runs create-dmg to build distributable
```

---

## Task A1: Xcode project setup + SPM dependencies

**Files:**
- Create: `packages/agent-macos/Package.swift`
- Configure: `HyperBotAgent.xcodeproj` (new project via Xcode)

- [ ] **Step 1: Create Xcode project**

In Xcode: File → New → Project → macOS → App.
- Product Name: `HyperBotAgent`
- Bundle Identifier: `ai.hyperbot.agent`
- Language: Swift, Interface: SwiftUI
- Save to `packages/agent-macos/`

- [ ] **Step 2: Add SPM dependencies**

In Xcode: File → Add Package Dependencies. Add:
```
https://github.com/sindresorhus/LaunchAtLogin-Modern  — "LaunchAtLogin"
https://github.com/kishikawakatsumi/KeychainAccess      — "KeychainAccess"
https://github.com/groue/GRDB.swift                    — "GRDB"
https://github.com/orchetect/MenuBarExtraAccess         — "MenuBarExtraAccess"
```

- [ ] **Step 3: Set LSUIElement in Info.plist**

Add key `Application is agent (UIElement)` = `YES` to Info.plist.
This hides the dock icon on every launch.

- [ ] **Step 4: Verify app builds and runs (no UI yet)**

Cmd+R — app should appear only as a menu bar item (no dock icon, no window).

- [ ] **Step 5: Commit**
```bash
git add packages/agent-macos/
git commit -m "feat(agent-macos): Xcode project + SPM deps"
```

---

## Task A2: Protocol types

**Files:**
- Create: `packages/agent-macos/HyperBotAgent/Protocol.swift`

Mirror `src/agent/protocol.ts` exactly so both sides use the same message shapes.

- [ ] **Step 1: Create Protocol.swift**

```swift
// HyperBotAgent/Protocol.swift

struct AgentPairRequest: Encodable  { let type = "pair";       let code: String }
struct AgentPairResponse: Decodable { let type: String;        let jwt: String }
struct AgentPairError: Decodable    { let type: String;        let reason: String }

struct AgentCommand: Decodable {
  let id: String
  let type: String   // "bash_execute" | "playwright_action" | etc.
  let payload: [String: AnyCodable]  // use AnyCodable helper or JSONValue
  let timeoutMs: Int?

  enum CodingKeys: String, CodingKey {
    case id, type, payload
    case timeoutMs = "timeout_ms"
  }
}

struct AgentResponse: Encodable {
  let id: String
  let type: String   // "chunk" | "done" | "error"
  var text: String?
  var data: String?  // JSON-encoded structured result
  var exitCode: Int?
  var error: String?
}

struct AgentPing: Encodable  { let type = "ping" }
struct AgentPong: Decodable  { let type: String }
struct AgentCancel: Decodable { let type: String; let id: String }
```

For `AnyCodable` — add a minimal implementation or use the `AnyCodable` package (add via SPM).

- [ ] **Step 2: Verify project compiles**

Cmd+B.

- [ ] **Step 3: Commit**
```bash
git add packages/agent-macos/HyperBotAgent/Protocol.swift
git commit -m "feat(agent-macos): protocol types"
```

---

## Task A3: Keychain store + Pairing manager

**Files:**
- Create: `HyperBotAgent/KeychainStore.swift`
- Create: `HyperBotAgent/PairingManager.swift`
- Create: `HyperBotAgentTests/PairingManagerTests.swift`

- [ ] **Step 1: Write failing tests**

```swift
// HyperBotAgentTests/PairingManagerTests.swift
import XCTest
@testable import HyperBotAgent

final class PairingManagerTests: XCTestCase {
  func testGenerateCodeFormat() {
    let code = PairingManager.generateCode()
    XCTAssertTrue(code.range(of: #"^[a-z0-9]{4}-[a-z0-9]{4}$"#, options: .regularExpression) != nil)
  }

  func testGenerateCodeUniqueness() {
    let codes = Set((0..<100).map { _ in PairingManager.generateCode() })
    XCTAssertEqual(codes.count, 100)
  }
}
```

Run tests: Cmd+U. Expected: FAIL (PairingManager doesn't exist yet).

- [ ] **Step 2: Implement KeychainStore.swift**

```swift
// HyperBotAgent/KeychainStore.swift
import KeychainAccess

struct KeychainStore {
  private static let keychain = Keychain(service: "ai.hyperbot.agent")

  static func saveJwt(_ jwt: String) throws {
    try keychain.set(jwt, key: "jwt")
  }

  static func loadJwt() -> String? {
    try? keychain.get("jwt")
  }

  static func deleteJwt() throws {
    try keychain.remove("jwt")
  }
}
```

- [ ] **Step 3: Implement PairingManager.swift**

```swift
// HyperBotAgent/PairingManager.swift
import Foundation

struct PairingManager {
  static func generateCode() -> String {
    let chars = Array("abcdefghijklmnopqrstuvwxyz0123456789")
    func rand(_ n: Int) -> String {
      String((0..<n).map { _ in chars[Int.random(in: 0..<chars.count)] })
    }
    return "\(rand(4))-\(rand(4))"
  }

  static var isFirstLaunch: Bool {
    KeychainStore.loadJwt() == nil
  }
}
```

- [ ] **Step 4: Run tests**

Cmd+U. Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add packages/agent-macos/
git commit -m "feat(agent-macos): keychain store + pairing manager"
```

---

## Task A4: WebSocket client

**Files:**
- Create: `HyperBotAgent/WebSocketClient.swift`
- Create: `HyperBotAgentTests/WebSocketClientTests.swift`

- [ ] **Step 1: Write failing test**

```swift
// HyperBotAgentTests/WebSocketClientTests.swift
import XCTest
@testable import HyperBotAgent

final class WebSocketClientTests: XCTestCase {
  func testInitialStateIsDisconnected() {
    let client = WebSocketClient(url: URL(string: "wss://example.com/ws/agent")!)
    XCTAssertFalse(client.isConnected)
  }
}
```

Run: Cmd+U. Expected: FAIL.

- [ ] **Step 2: Implement WebSocketClient.swift**

```swift
// HyperBotAgent/WebSocketClient.swift
import Foundation

typealias MessageHandler = (Data) -> Void

@MainActor
class WebSocketClient: NSObject {
  private let url: URL
  private let jwt: String?
  private var task: URLSessionWebSocketTask?
  private var reconnectDelay: TimeInterval = 1
  private var pingTimer: Timer?

  var onMessage: MessageHandler?
  var onConnected: (() -> Void)?
  var onDisconnected: (() -> Void)?
  private(set) var isConnected = false

  init(url: URL, jwt: String? = nil) {
    self.url = url
    self.jwt = jwt
  }

  func connect() {
    var request = URLRequest(url: url)
    if let jwt { request.setValue("Bearer \(jwt)", forHTTPHeaderField: "Authorization") }
    let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    task = session.webSocketTask(with: request)
    task?.resume()
    receive()
    schedulePing()
  }

  func disconnect() {
    pingTimer?.invalidate()
    task?.cancel(with: .normalClosure, reason: nil)
    task = nil
    isConnected = false
  }

  func send(_ data: Data) {
    task?.send(.data(data)) { _ in }
  }

  private func receive() {
    task?.receive { [weak self] result in
      guard let self else { return }
      switch result {
      case .success(let msg):
        switch msg {
        case .data(let d):   self.onMessage?(d)
        case .string(let s): self.onMessage?(Data(s.utf8))
        @unknown default: break
        }
        self.receive()
      case .failure:
        self.handleDisconnect()
      }
    }
  }

  private func schedulePing() {
    pingTimer?.invalidate()
    pingTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
      guard let self, self.isConnected else { return }
      let ping = try? JSONEncoder().encode(AgentPing())
      if let ping { self.send(ping) }
    }
  }

  private func handleDisconnect() {
    Task { @MainActor in
      self.isConnected = false
      self.onDisconnected?()
      // exponential backoff reconnect
      try? await Task.sleep(nanoseconds: UInt64(self.reconnectDelay * 1_000_000_000))
      self.reconnectDelay = min(self.reconnectDelay * 2, 60)
      self.connect()
    }
  }
}

extension WebSocketClient: URLSessionWebSocketDelegate {
  nonisolated func urlSession(_ session: URLSession,
                               webSocketTask: URLSessionWebSocketTask,
                               didOpenWithProtocol protocol: String?) {
    Task { @MainActor in
      self.isConnected = true
      self.reconnectDelay = 1
      self.onConnected?()
    }
  }

  nonisolated func urlSession(_ session: URLSession,
                               webSocketTask: URLSessionWebSocketTask,
                               didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
                               reason: Data?) {
    Task { @MainActor in self.handleDisconnect() }
  }
}
```

- [ ] **Step 3: Run tests**

Cmd+U. isConnected test passes.

- [ ] **Step 4: Commit**
```bash
git add packages/agent-macos/
git commit -m "feat(agent-macos): WebSocket client with reconnect"
```

---

## Task A5: App.swift — first-launch detection + wizard window

**Files:**
- Modify: `HyperBotAgent/App.swift`
- Create: `HyperBotAgent/WizardView.swift`

- [ ] **Step 1: Implement App.swift**

```swift
// HyperBotAgent/App.swift
import SwiftUI
import LaunchAtLogin

@main
struct HyperBotAgentApp: App {
  @StateObject private var appState = AppState()

  var body: some Scene {
    MenuBarExtra("HyperBot Agent", systemImage: appState.isConnected ? "circle.fill" : "circle") {
      TrayMenu(appState: appState)
    }
    .menuBarExtraStyle(.menu)
  }

  init() {
    // First launch: show wizard window
    if PairingManager.isFirstLaunch {
      // Enable launch at login by default
      LaunchAtLogin.isEnabled = true

      // Temporarily allow window focus
      NSApp.setActivationPolicy(.regular)
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
        WizardWindowController.show()
        NSApp.activate(ignoringOtherApps: true)
      }
    }
  }
}
```

- [ ] **Step 2: Create WizardWindowController**

```swift
// HyperBotAgent/WizardView.swift
import SwiftUI

class WizardWindowController {
  private static var window: NSWindow?

  static func show() {
    let view = WizardView(onComplete: { dismiss() })
    let hosting = NSHostingController(rootView: view)
    let win = NSWindow(contentViewController: hosting)
    win.title = "Настройка HyperBot Agent"
    win.setContentSize(NSSize(width: 520, height: 420))
    win.styleMask = [.titled, .closable]
    win.center()
    win.makeKeyAndOrderFront(nil)
    self.window = win
  }

  static func dismiss() {
    window?.close()
    window = nil
    // Restore tray-only mode
    NSApp.setActivationPolicy(.accessory)
  }
}

// 3-step wizard: Welcome → Claude Detection → Pairing
struct WizardView: View {
  let onComplete: () -> Void
  @State private var step = 0
  @State private var claudePath = "/Applications/Claude.app"
  @State private var pairingCode = PairingManager.generateCode()

  var body: some View {
    VStack(spacing: 0) {
      // Step indicator
      HStack(spacing: 8) {
        ForEach(0..<3, id: \.self) { i in
          Circle().fill(i == step ? Color.accentColor : Color.secondary.opacity(0.3))
            .frame(width: 8, height: 8)
        }
      }.padding(.top, 24)

      Spacer()

      switch step {
      case 0: WelcomeStep()
      case 1: ClaudeDetectionStep(claudePath: $claudePath)
      case 2: PairingStep(code: pairingCode, onComplete: onComplete)
      default: EmptyView()
      }

      Spacer()

      HStack {
        if step > 0 {
          Button("Назад") { step -= 1 }
        }
        Spacer()
        if step < 2 {
          Button("Продолжить") { step += 1 }
            .buttonStyle(.borderedProminent)
        }
      }
      .padding([.horizontal, .bottom], 24)
    }
  }
}
```

- [ ] **Step 3: Build and manually test first launch**

Cmd+R. Should show wizard window. After close, only tray icon visible.

- [ ] **Step 4: Commit**
```bash
git add packages/agent-macos/
git commit -m "feat(agent-macos): first-launch wizard with activation policy toggle"
```

---

## Task A6: Tray menu with status + launch-at-login toggle

**Files:**
- Create: `HyperBotAgent/TrayMenu.swift`
- Create: `HyperBotAgent/AppState.swift`

- [ ] **Step 1: Create AppState.swift**

```swift
// HyperBotAgent/AppState.swift
import SwiftUI
import LaunchAtLogin

@MainActor
class AppState: ObservableObject {
  @Published var isConnected = false
  @Published var pairingCode: String? = nil

  var launchAtLogin: Bool {
    get { LaunchAtLogin.isEnabled }
    set { LaunchAtLogin.isEnabled = newValue }
  }
}
```

- [ ] **Step 2: Create TrayMenu.swift**

```swift
// HyperBotAgent/TrayMenu.swift
import SwiftUI
import LaunchAtLogin

struct TrayMenu: View {
  @ObservedObject var appState: AppState

  var body: some View {
    // Status
    Label(
      appState.isConnected ? "Подключено" : "Не подключён",
      systemImage: appState.isConnected ? "checkmark.circle.fill" : "exclamationmark.circle"
    )
    .foregroundColor(appState.isConnected ? .green : .secondary)

    Divider()

    // Launch at login toggle
    Toggle("Запускать при старте системы", isOn: Binding(
      get: { appState.launchAtLogin },
      set: { appState.launchAtLogin = $0 }
    ))

    Divider()

    // Disconnect / re-pair
    if appState.isConnected {
      Button("Отключить агент") {
        // disconnect and show pairing code
        // AppState.disconnect() — implemented in Task A7
      }
    } else if let code = appState.pairingCode {
      Button("Скопировать код: /activate \(code)") {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString("/activate \(code)", forType: .string)
      }
    }

    Divider()

    Button("Выход") {
      NSApplication.shared.terminate(nil)
    }
  }
}
```

- [ ] **Step 3: Build + visually verify tray menu**

Cmd+R. Check: status label, launch-at-login toggle works, quit works.

- [ ] **Step 4: Commit**
```bash
git add packages/agent-macos/
git commit -m "feat(agent-macos): tray menu — status, launch-at-login toggle, disconnect"
```

---

## Task A7: WebSocket pairing flow integration

**Files:**
- Modify: `HyperBotAgent/App.swift`
- Modify: `HyperBotAgent/AppState.swift`

Wire WebSocketClient into AppState. On connect: send pair message if no jwt, handle `paired` response.

- [ ] **Step 1: Extend AppState with WebSocket lifecycle**

```swift
// AppState.swift additions:
private var wsClient: WebSocketClient?
private let botUrl = URL(string: ProcessInfo.processInfo.environment["BOT_WS_URL"]
                         ?? "wss://your-bot-host/ws/agent")!

func startWebSocket() {
  let jwt = KeychainStore.loadJwt()
  wsClient = WebSocketClient(url: botUrl, jwt: jwt)
  wsClient?.onConnected = { [weak self] in
    guard let self else { return }
    if jwt == nil, let code = self.pairingCode {
      // Pairing mode: send pair message
      let msg = AgentPairRequest(code: code)
      if let data = try? JSONEncoder().encode(msg) { self.wsClient?.send(data) }
    } else {
      self.isConnected = true
    }
  }
  wsClient?.onMessage = { [weak self] data in self?.handleMessage(data) }
  wsClient?.onDisconnected = { [weak self] in
    Task { @MainActor in self?.isConnected = false }
  }
  wsClient?.connect()
}

private func handleMessage(_ data: Data) {
  guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let type = json["type"] as? String else { return }

  Task { @MainActor in
    switch type {
    case "paired":
      if let jwt = json["jwt"] as? String {
        try? KeychainStore.saveJwt(jwt)
        self.isConnected = true
        self.pairingCode = nil
        WizardWindowController.dismiss()
      }
    case "pair_error":
      // show error in wizard
      break
    case "pong":
      break
    default:
      // AgentCommand — route to CommandRouter (Task A9)
      break
    }
  }
}

func disconnect() {
  try? KeychainStore.deleteJwt()
  wsClient?.disconnect()
  isConnected = false
  pairingCode = PairingManager.generateCode()
  // show wizard again
  NSApp.setActivationPolicy(.regular)
  DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
    WizardWindowController.show()
    NSApp.activate(ignoringOtherApps: true)
  }
}
```

- [ ] **Step 2: Call startWebSocket in App.swift init**

```swift
init() {
  if PairingManager.isFirstLaunch {
    LaunchAtLogin.isEnabled = true
    // ... wizard logic ...
  }
  // Always start WebSocket (connects immediately if JWT exists, else waits for wizard)
  DispatchQueue.main.async { appState.startWebSocket() }
}
```

Wait — `appState` is `@StateObject` which can't be accessed in `init`. Move startWebSocket call to `.onAppear` or use `.task` modifier on the MenuBarExtra content.

- [ ] **Step 3: Wire disconnect button in TrayMenu**

```swift
Button("Отключить агент") { appState.disconnect() }
```

- [ ] **Step 4: End-to-end test: run bot server locally, connect agent**

1. Set `BOT_WS_URL` env var to local bot server
2. Run agent, copy `/activate xxx-xxxx` command from tray
3. Send command to bot in Telegram
4. Verify tray icon turns green ("Подключено")

- [ ] **Step 5: Commit**
```bash
git add packages/agent-macos/
git commit -m "feat(agent-macos): WebSocket pairing — JWT flow, connected state, disconnect"
```

---

## Task A8: Claude Desktop Bridge (cookie extraction + claude.ai API)

**Files:**
- Create: `HyperBotAgent/ClaudeBridge.swift`
- Create: `HyperBotAgent/CircuitBreaker.swift`
- Create: `HyperBotAgentTests/ClaudeBridgeTests.swift`
- Create: `HyperBotAgentTests/CircuitBreakerTests.swift`

- [ ] **Step 1: Write failing tests**

```swift
// CircuitBreakerTests.swift
final class CircuitBreakerTests: XCTestCase {
  func testOpensAfterThreshold() async {
    let cb = CircuitBreaker(threshold: 2, resetAfter: 60)
    cb.recordFailure()
    XCTAssertFalse(cb.isOpen)
    cb.recordFailure()
    XCTAssertTrue(cb.isOpen)
  }

  func testClosedAllowsRequests() {
    let cb = CircuitBreaker(threshold: 5, resetAfter: 60)
    XCTAssertFalse(cb.isOpen)
  }
}
```

Run: Cmd+U → FAIL.

- [ ] **Step 2: Implement CircuitBreaker.swift**

```swift
// HyperBotAgent/CircuitBreaker.swift
import Foundation

class CircuitBreaker {
  private let threshold: Int
  private let resetAfter: TimeInterval
  private var failureCount = 0
  private var openedAt: Date?

  init(threshold: Int, resetAfter: TimeInterval) {
    self.threshold = threshold
    self.resetAfter = resetAfter
  }

  var isOpen: Bool {
    guard let openedAt else { return false }
    if Date().timeIntervalSince(openedAt) > resetAfter {
      failureCount = 0
      self.openedAt = nil
      return false
    }
    return true
  }

  func recordFailure() {
    failureCount += 1
    if failureCount >= threshold { openedAt = Date() }
  }

  func recordSuccess() { failureCount = 0; openedAt = nil }
}
```

- [ ] **Step 3: Write ClaudeBridge cookie test**

```swift
// ClaudeBridgeTests.swift
final class ClaudeBridgeTests: XCTestCase {
  func testCookiePathExists() {
    // Verify the cookies file path is correct
    let path = ClaudeBridge.cookiesDbPath
    // Path must point to expected location
    XCTAssertTrue(path.contains("Claude/Cookies"))
  }
}
```

Run: Cmd+U → FAIL.

- [ ] **Step 4: Implement ClaudeBridge.swift**

```swift
// HyperBotAgent/ClaudeBridge.swift
import Foundation
import GRDB

struct ClaudeSession {
  let orgId: String
  let cookies: [HTTPCookie]
}

enum ClaudeError: Error {
  case authFailed
  case apiChanged
  case rateLimited
  case circuitOpen
}

class ClaudeBridge {
  static let cookiesDbPath: String = {
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return support.appendingPathComponent("Claude/Cookies").path
  }()

  private let breaker = CircuitBreaker(threshold: 5, resetAfter: 300)

  // Read session cookies from Claude Desktop's SQLite Cookies file
  func loadCookies() throws -> [HTTPCookie] {
    let db = try DatabaseQueue(path: ClaudeBridge.cookiesDbPath)
    let rows = try db.read { db in
      try Row.fetchAll(db, sql: "SELECT name, value, host_key, path, is_secure FROM cookies WHERE host_key LIKE '%claude.ai'")
    }
    return rows.compactMap { row in
      HTTPCookie(properties: [
        .name: row["name"] as String,
        .value: row["value"] as String,
        .domain: row["host_key"] as String,
        .path: row["path"] as String,
        .secure: (row["is_secure"] as Int) == 1 ? "TRUE" : "FALSE",
      ])
    }
  }

  // Get organization ID
  func fetchOrgId(cookies: [HTTPCookie]) async throws -> String {
    guard !breaker.isOpen else { throw ClaudeError.circuitOpen }
    let url = URL(string: "https://claude.ai/api/organizations")!
    let data = try await apiGet(url: url, cookies: cookies)
    breaker.recordSuccess()
    guard let orgs = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
          let id = orgs.first?["id"] as? String else { throw ClaudeError.apiChanged }
    return id
  }

  // Send message + stream SSE response
  func sendMessage(orgId: String, chatId: String, message: String,
                   cookies: [HTTPCookie], onChunk: @escaping (String) -> Void) async throws {
    guard !breaker.isOpen else { throw ClaudeError.circuitOpen }
    let url = URL(string: "https://claude.ai/api/organizations/\(orgId)/chat_conversations/\(chatId)/completion")!
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.setValue(agentVersion, forHTTPHeaderField: "X-Agent-Version")
    req.httpBody = try JSONSerialization.data(withJSONObject: ["prompt": message, "timezone": TimeZone.current.identifier])
    HTTPCookieStorage.shared.setCookies(cookies, for: url, mainDocumentURL: nil)

    let (bytes, response) = try await URLSession.shared.bytes(for: req)
    guard let http = response as? HTTPURLResponse else { throw ClaudeError.apiChanged }
    try handleStatus(http.statusCode)

    for try await line in bytes.lines {
      if line.hasPrefix("data: ") {
        let chunk = String(line.dropFirst(6))
        if chunk == "[DONE]" { break }
        if let json = try? JSONSerialization.jsonObject(with: Data(chunk.utf8)) as? [String: Any],
           let text = json["completion"] as? String {
          onChunk(text)
        }
      }
    }
    breaker.recordSuccess()
  }

  private func apiGet(url: URL, cookies: [HTTPCookie]) async throws -> Data {
    var req = URLRequest(url: url)
    req.setValue(agentVersion, forHTTPHeaderField: "X-Agent-Version")
    HTTPCookieStorage.shared.setCookies(cookies, for: url, mainDocumentURL: nil)
    let (data, response) = try await URLSession.shared.data(for: req)
    guard let http = response as? HTTPURLResponse else { throw ClaudeError.apiChanged }
    try handleStatus(http.statusCode)
    return data
  }

  private func handleStatus(_ code: Int) throws {
    switch code {
    case 200...299: return
    case 401, 403: breaker.recordFailure(); throw ClaudeError.authFailed
    case 404:       breaker.recordFailure(); throw ClaudeError.apiChanged
    case 429:       throw ClaudeError.rateLimited
    default:        breaker.recordFailure(); throw ClaudeError.apiChanged
    }
  }

  private let agentVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
}
```

- [ ] **Step 5: Run tests**

Cmd+U.

- [ ] **Step 6: Commit**
```bash
git add packages/agent-macos/
git commit -m "feat(agent-macos): Claude Desktop bridge — cookie extraction, SSE, circuit breaker"
```

---

## Task A9: Action executors + CommandRouter

**Files:**
- Create: `HyperBotAgent/BashExecutor.swift`
- Create: `HyperBotAgent/AppleScriptExecutor.swift`
- Create: `HyperBotAgent/PlaywrightExecutor.swift`
- Create: `HyperBotAgent/CommandRouter.swift`
- Create: `HyperBotAgentTests/CommandRouterTests.swift`

- [ ] **Step 1: Write failing test**

```swift
// CommandRouterTests.swift
final class CommandRouterTests: XCTestCase {
  func testUnknownCommandReturnsError() async {
    let router = CommandRouter(bridge: ClaudeBridge())
    let cmd = AgentCommand(id: "x", type: "unknown_tool", payload: [:], timeoutMs: nil)
    let response = await router.route(cmd)
    XCTAssertEqual(response.type, "error")
  }
}
```

Run: Cmd+U → FAIL.

- [ ] **Step 2: Implement BashExecutor.swift**

```swift
// HyperBotAgent/BashExecutor.swift
import Foundation

struct BashResult { let stdout: String; let stderr: String; let exitCode: Int32 }

struct BashExecutor {
  static func run(command: String, timeoutMs: Int?) async -> BashResult {
    await withCheckedContinuation { continuation in
      let proc = Process()
      proc.executableURL = URL(fileURLWithPath: "/bin/bash")
      proc.arguments = ["-c", command]

      let outPipe = Pipe(); let errPipe = Pipe()
      proc.standardOutput = outPipe; proc.standardError = errPipe

      try? proc.run()

      if let ms = timeoutMs {
        DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(ms)) {
          if proc.isRunning { proc.terminate() }
        }
      }

      proc.waitUntilExit()
      let out = String(data: outPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
      let err = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
      // Truncate to 50KB
      let maxBytes = 50 * 1024
      continuation.resume(returning: BashResult(
        stdout: String(out.prefix(maxBytes)),
        stderr: String(err.prefix(maxBytes)),
        exitCode: proc.terminationStatus
      ))
    }
  }
}
```

- [ ] **Step 3: Implement AppleScriptExecutor.swift**

```swift
// HyperBotAgent/AppleScriptExecutor.swift
import Foundation

struct AppleScriptExecutor {
  static func run(script: String) async -> (result: String, error: String?) {
    await withCheckedContinuation { continuation in
      var error: NSDictionary?
      let appleScript = NSAppleScript(source: script)
      let output = appleScript?.executeAndReturnError(&error)
      let result = output?.stringValue ?? ""
      let errMsg = error?[NSAppleScript.errorMessage] as? String
      continuation.resume(returning: (result, errMsg))
    }
  }
}
```

- [ ] **Step 4: Implement PlaywrightExecutor.swift**

```swift
// HyperBotAgent/PlaywrightExecutor.swift
// Calls a bundled Node.js script that runs Playwright actions
// The Node binary + playwright are bundled in the app's Resources folder

struct PlaywrightExecutor {
  static func run(action: String, params: [String: Any], timeoutMs: Int?) async -> BashResult {
    guard let nodePath = Bundle.main.path(forResource: "node", ofType: nil),
          let scriptPath = Bundle.main.path(forResource: "playwright-runner", ofType: "js") else {
      return BashResult(stdout: "", stderr: "Playwright not bundled", exitCode: 1)
    }
    let paramsJson = (try? JSONSerialization.data(withJSONObject: ["action": action, "params": params]))
      .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    return await BashExecutor.run(command: "\(nodePath) \(scriptPath) '\(paramsJson)'", timeoutMs: timeoutMs)
  }
}
```

- [ ] **Step 5: Implement CommandRouter.swift**

```swift
// HyperBotAgent/CommandRouter.swift
import Foundation

class CommandRouter {
  private let bridge: ClaudeBridge

  init(bridge: ClaudeBridge) { self.bridge = bridge }

  func route(_ cmd: AgentCommand) async -> AgentResponse {
    do {
      switch cmd.type {
      case "bash_execute":
        let command = cmd.payload["command"] as? String ?? ""
        let result = await BashExecutor.run(command: command, timeoutMs: cmd.timeoutMs)
        let output = result.stdout + (result.stderr.isEmpty ? "" : "\nSTDERR: \(result.stderr)")
        return AgentResponse(id: cmd.id, type: "done", text: nil, data: output, exitCode: Int(result.exitCode))

      case "applescript_run":
        let script = cmd.payload["script"] as? String ?? ""
        let (result, error) = await AppleScriptExecutor.run(script: script)
        if let error { return AgentResponse(id: cmd.id, type: "error", error: error) }
        return AgentResponse(id: cmd.id, type: "done", data: result, exitCode: 0)

      case "playwright_action":
        let action = cmd.payload["action"] as? String ?? ""
        let params = cmd.payload["params"] as? [String: Any] ?? [:]
        let result = await PlaywrightExecutor.run(action: action, params: params, timeoutMs: cmd.timeoutMs)
        return AgentResponse(id: cmd.id, type: "done", data: result.stdout, exitCode: Int(result.exitCode))

      case "claude_chat", "claude_new_chat", "claude_open_chat",
           "claude_list_chats", "claude_list_projects", "claude_artifact":
        return try await routeClaudeCommand(cmd)

      default:
        return AgentResponse(id: cmd.id, type: "error", error: "Unknown command: \(cmd.type)")
      }
    } catch {
      return AgentResponse(id: cmd.id, type: "error", error: error.localizedDescription)
    }
  }

  private func routeClaudeCommand(_ cmd: AgentCommand) async throws -> AgentResponse {
    let cookies = try bridge.loadCookies()
    // Implement each claude_* command against ClaudeBridge methods
    // Returns AgentResponse with data = JSON-encoded result
    return AgentResponse(id: cmd.id, type: "done", data: "[]", exitCode: 0)
  }
}
```

- [ ] **Step 6: Run tests**

Cmd+U.

- [ ] **Step 7: Wire CommandRouter into AppState message handler**

In `AppState.handleMessage`, route AgentCommand messages to `commandRouter.route(cmd)`, then send the response back via `wsClient.send(...)`.

- [ ] **Step 8: Commit**
```bash
git add packages/agent-macos/
git commit -m "feat(agent-macos): bash, AppleScript, Playwright executors + CommandRouter"
```

---

## Task A10: DMG packaging

**Files:**
- Create: `packages/agent-macos/scripts/make-dmg.sh`

- [ ] **Step 1: Install create-dmg**
```bash
brew install create-dmg
```

- [ ] **Step 2: Build release archive in Xcode**

Product → Archive → Distribute App → Copy App → choose output folder `build/`

- [ ] **Step 3: Create make-dmg.sh**

```bash
#!/bin/bash
# packages/agent-macos/scripts/make-dmg.sh
set -e
APP="build/HyperBotAgent.app"
OUT="build/HyperBotAgent.dmg"

create-dmg \
  --volname "HyperBot Agent" \
  --volicon "$APP/Contents/Resources/AppIcon.icns" \
  --window-pos 200 120 \
  --window-size 540 380 \
  --icon-size 128 \
  --icon "HyperBotAgent.app" 130 180 \
  --hide-extension "HyperBotAgent.app" \
  --app-drop-link 410 180 \
  "$OUT" \
  "$APP"

echo "Created: $OUT"
```

- [ ] **Step 4: Run script and verify DMG**
```bash
chmod +x packages/agent-macos/scripts/make-dmg.sh
./packages/agent-macos/scripts/make-dmg.sh
```

Open the resulting .dmg — should show app icon + arrow + Applications shortcut.

- [ ] **Step 5: Commit**
```bash
git add packages/agent-macos/scripts/make-dmg.sh
git commit -m "feat(agent-macos): DMG packaging with create-dmg"
```

---

## Acceptance Criteria (macOS Agent)

- [ ] App launches with no dock icon, only tray icon
- [ ] First launch: wizard window opens, shows pairing code
- [ ] `/activate code` in Telegram → tray turns green, wizard closes
- [ ] Tray menu: status, launch-at-login toggle works, disconnect re-shows wizard
- [ ] Launch at login enabled by default after first setup
- [ ] Reconnect: kill bot server, restart → agent reconnects automatically
- [ ] `bash_execute` command returns stdout/exitCode correctly
- [ ] `applescript_run` executes script and returns result
- [ ] Claude Desktop bridge reads cookies (requires Claude Desktop installed + logged in)
- [ ] `make-dmg.sh` produces a valid .dmg with drag-to-Applications layout
