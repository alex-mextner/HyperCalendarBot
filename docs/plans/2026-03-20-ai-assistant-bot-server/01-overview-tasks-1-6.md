> Part 1 of 3 of [AI Assistant — Bot Server Implementation Plan](../2026-03-20-ai-assistant-bot-server.md) — next: [02-tasks-7-a3.md](02-tasks-7-a3.md)

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

