> Part 2 of 3 of [AI Assistant — Bot Server Implementation Plan](../2026-03-20-ai-assistant-bot-server.md) — previous: [01-overview-tasks-1-6.md](01-overview-tasks-1-6.md) · next: [03-tasks-a4-a10.md](03-tasks-a4-a10.md)

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

