# AI Assistant Agent — Design Spec

**Date:** 2026-03-20
**Status:** Draft

## Overview

Превращаем HyperCalendarBot в полноценного AI ассистента с доступом к компьютеру пользователя.
Пользователь устанавливает лёгкое macOS приложение (tray agent), которое подключается к боту по
WebSocket и выполняет команды: общение с Claude Desktop, bash, браузерная автоматизация,
AppleScript. Бот становится Telegram-прокси к Claude Desktop пользователя и его окружению.

---

## Architecture

```
[Telegram] ←→ [Bot Server (Bun)] ←— WebSocket (/ws/agent) —→ [macOS Agent (Electron)]
                     ↑                                                  ↓
              New AI tools:                            ┌─── Claude Desktop Bridge
              claude_chat,                             │    (Cookies → claude.ai API + SSE)
              bash_execute,                            ├─── bash (child_process)
              playwright_action,                       ├─── Playwright (browser)
              applescript_run                          └─── AppleScript (osascript)
```

**Два новых компонента:**

- **Bot Server additions** — WebSocket endpoint в существующем `Bun.serve()`, agent registry, pairing, новые AI инструменты
- **macOS Agent** — Electron tray app без dock иконки

---

## Monorepo Structure

```
hypercalendarbot/
├── packages/
│   └── agent-macos/
│       ├── src/
│       │   ├── main.ts              — точка входа, Electron app lifecycle
│       │   ├── tray.ts              — NSStatusBar иконка + меню
│       │   ├── wizard.ts            — setup wizard (только первый запуск)
│       │   ├── ws-client.ts         — WebSocket клиент, reconnect, heartbeat
│       │   ├── pairing.ts           — генерация кода, HTTP handshake
│       │   ├── keychain.ts          — JWT в macOS Keychain
│       │   └── actions/
│       │       ├── claude-bridge.ts — Cookies → claude.ai API + SSE
│       │       ├── bash.ts          — shell execution
│       │       ├── playwright.ts    — браузер автоматизация
│       │       └── applescript.ts   — osascript wrapper
│       ├── wizard/                  — HTML/CSS/JS wizard окна
│       ├── package.json
│       └── electron-builder.yml    — .dmg + .pkg
├── src/                             — существующий бот (минимальные изменения)
│   ├── agent/                       — NEW
│   │   ├── protocol.ts              — shared WebSocket types (импортируется и агентом)
│   │   ├── ws-server.ts             — WebSocket endpoint в Bun.serve()
│   │   ├── registry.ts              — userId → ws connection
│   │   ├── pairing.ts               — коды, JWT, TTL, HTTP endpoint
│   │   └── dispatcher.ts            — отправить задачу агенту, await стрим
│   ├── bot/commands/
│   │   └── connect.command.ts       — NEW: /connect
│   └── services/ai/
│       ├── tools.ts                 — EXTENDED: UserCapabilities param
│       ├── tool-executor.ts         — EXTENDED: новые кейсы + runtime agentConnected check
│       ├── system-prompt.ts         — EXTENDED: секция ассистента
│       └── tool-handlers/
│           └── assistant.ts         — NEW: все инструменты агента
├── package.json                     — workspaces: ["packages/*"]
└── biome.jsonc                      — общий линтер
```

**Shared types:** `src/agent/protocol.ts` живёт в боте. Агент импортирует оттуда через
относительный путь или workspace alias. Таким образом Electron-зависимости агента
(`keytar`, `better-sqlite3`) не попадают в транзитивные зависимости бота.

**Workspace hoisting:** в `packages/agent-macos/package.json` — `"bundledDependencies"` +
`.npmrc` с `public-hoist-pattern=[]` чтобы native addons не поднимались в корневой
`node_modules` и не ломали Electron asar bundling.

---

## Pairing Flow

```
1. Пользователь скачивает .dmg по ссылке из /connect
2. Открывает .dmg — Finder-окно: иконка приложения + стрелка + иконка папки Applications
   Перетаскивает приложение в Applications, закрывает .dmg
3. Открывает приложение из Applications (первый запуск — macOS попросит разрешение)
4. Приложение запускается. Нет JWT в Keychain → первый запуск. Приложение:
   a. Вызывает `NSApp.setActivationPolicy(.regular)` — временно показывает dock-иконку для фокуса окна
   b. Открывает SwiftUI setup wizard:
      — автоматически определяет Claude.app путь
      — проверяет наличие Cookies (запущен ли Claude Desktop хоть раз)
      — предзаполняет всё, пользователь только подтверждает или редактирует
4. Агент генерирует pairing code: "abc-123" (UUID-derived, TTL 10 минут)
5. Агент сразу открывает WebSocket: wss://bot-host/ws/agent
   Первое сообщение после подключения: { type: 'pair', code: 'abc-123' }
   Бот держит соединение в состоянии "pending pairing" — команды не принимает
6. Wizard показывает pairing code и инструкцию
   "Отправь боту: /activate abc-123"   [Копировать]
7. Пользователь отправляет в Telegram → бот принимает /activate abc-123
8. Бот находит pending WebSocket по code, выдаёт JWT прямо в него:
   { type: 'paired', jwt: '...' }
9. Агент сохраняет JWT в Keychain под ключом "hyperbot.jwt"
10. Wizard закрывается. `NSApp.setActivationPolicy(.accessory)` — dock-иконка исчезает
11. То же соединение переходит в рабочий режим (бот регистрирует в registry по userId)
12. Tray icon → зелёный, "Подключено к HyperBot". Приложение — только трей, никаких окон.
```

**Повторные запуски:** JWT в Keychain → сразу WebSocket. Никаких окон, только трей.

**JWT expiry:** если бот отклоняет WebSocket с `4001 JWT expired` — агент показывает уведомление macOS:
> "HyperBot: токен истёк. Открой приложение для повторной привязки."
Wizard запускается заново (только шаг pairing, без автоопределения путей).

**Повторная активация:** новый `/activate` инвалидирует все предыдущие JWT того же user_id.

---

## WebSocket Protocol

Типы в `src/agent/protocol.ts`:

```typescript
// Agent → Bot: первое сообщение при первом подключении (без JWT)
interface AgentPairRequest { type: 'pair'; code: string }

// Bot → Agent: ответ на pair (то же WS соединение)
interface AgentPairResponse { type: 'paired'; jwt: string }
interface AgentPairError   { type: 'pair_error'; reason: 'expired' | 'invalid' }

// Bot → Agent
interface AgentCommand {
  id: string                    // uuid, уникальный ID задачи
  type: 'claude_chat'
      | 'claude_new_chat'
      | 'claude_list_chats'
      | 'claude_open_chat'
      | 'claude_list_projects'
      | 'claude_artifact'
      | 'bash_execute'
      | 'playwright_action'
      | 'applescript_run'
  payload: Record<string, unknown>
}

// Agent → Bot
interface AgentResponse {
  id: string                    // тот же ID что в команде
  type: 'chunk' | 'done' | 'error'
  text?: string                 // chunk: кусок SSE стрима
  data?: unknown                // done: финальный payload (список чатов и т.п.)
  exitCode?: number             // done для bash
  error?: string                // error
}

// Keepalive
interface AgentPing { type: 'ping' }
interface AgentPong { type: 'pong' }
```

**Heartbeat:** агент шлёт `ping` каждые 30с, бот отвечает `pong`.
Если бот не получил `ping` за 90с — считает агент отключённым, закрывает соединение.

**Reconnect (агент):** exponential backoff 1s → 2s → 4s → ... → 60s (max), бесконечно.

**Таймауты:** AI агент ставит `timeout_ms` в payload команды по своему усмотрению. `dispatcher.ts` пробрасывает значение агенту без изменений. Жёстких таймаутов на стороне бота нет. Агент прерывает выполнение при получении `{ type: 'cancel', id }` (kill child process / abort playwright).

**WebSocket падает в середине выполнения:** `dispatcher.ts` получает rejection через close-event listener, возвращает `ToolResult { success: false, error: "Агент отключился во время выполнения" }`. Агент при переподключении не продолжает прерванные задачи — они уже завершились ошибкой.

---

## Claude Desktop Bridge

Claude Desktop — Electron-обёртка над `claude.ai`. Сессия хранится в:

```
~/Library/Application Support/Claude/Cookies    ← SQLite, Chromium cookie format
~/Library/HTTPStorages/com.anthropic.claudefordesktop/httpstorages.sqlite
```

Агент читает cookies из SQLite (`better-sqlite3`, не `bun:sqlite` — контекст Electron).
**Cookies не покидают машину пользователя** — все HTTP вызовы делаются локально.

### claude.ai API (reverse-engineered, нестабильный)

```typescript
GET  /api/organizations
GET  /api/organizations/:orgId/projects
GET  /api/organizations/:orgId/chat_conversations?limit=50
POST /api/organizations/:orgId/chat_conversations        // новый чат
POST /api/organizations/:orgId/chat_conversations/:id/completion  // SSE stream
GET  /api/artifacts/:artifactId
```

**Стратегия деградации при поломке API:**

- Все вызовы обёрнуты в circuit-breaker (5 ошибок за 60с → open state на 5 минут)
- Версия клиента отправляется как `X-Agent-Version` header (для диагностики)
- При получении 4xx/5xx — детектируем тип: `AUTH_FAILED` (401/403), `API_CHANGED` (404 на endpoint), `RATE_LIMITED` (429)
- Ошибки транслируются пользователю:
  - `AUTH_FAILED` → "Claude Desktop: нужно заново войти в аккаунт на claude.ai"
  - `API_CHANGED` → "Claude API изменился — нужно обновить агент. Проверь обновления."
  - `RATE_LIMITED` → "Claude Desktop: слишком много запросов, подожди немного"
- Агент логирует ошибки локально (`~/Library/Logs/HyperBot Agent/`)

**SSE стрим:** claude.ai шлёт `text/event-stream`. Агент парсит события, для каждого text-чанка
шлёт `{ id, type: 'chunk', text }` через WebSocket. Когда стрим закрывается — `{ id, type: 'done' }`.
Бот пробрасывает чанки в существующий `TelegramStreamWriter`.

**Markdown post-processing:** ответ claude.ai содержит markdown с таблицами, которые Telegram
не рендерит. Перед отправкой в Telegram прогоняем через расширенную версию существующей
`markdownToHtml()` (`src/utils/telegram.ts`): добавляем обработку таблиц → моноширинный текст,
сохраняем bold/italic/code. Новая функция — `claudeMarkdownToTelegram()` в том же файле.

---

## Tool Availability: UserCapabilities

Новые инструменты показываются Claude **только** при выполнении обоих условий:

1. `user.settings.assistantEnabled === true`
2. `agentRegistry.isConnected(userId) === true`

```typescript
// tools.ts
getToolDefinitions(inputMode?: string, caps?: UserCapabilities)

interface UserCapabilities {
  assistantEnabled: boolean    // из user.settings
  agentConnected: boolean      // из agentRegistry.isConnected()
}
```

**Runtime check в `tool-executor.ts`:** каждый handler агента дополнительно проверяет
`agentRegistry.isConnected(ctx.user.telegramId)` в момент выполнения. Агент мог отключиться
после начала AI-раунда. Если disconnected — возвращает:

```
⚠️ Агент отключился. Переподключение... Попробуй повторить через минуту.
```

В `system-prompt.ts` секция про компьютерные действия добавляется только при
`caps.assistantEnabled && caps.agentConnected`.

**Если агент не установлен (`!agentConnected && !assistantEnabled`):**

```
⚠️ AI Ассистент не настроен. Скачай агент: /connect
```

---

## New AI Tools (9 штук)

| Инструмент | Описание |
|---|---|
| `claude_chat` | Отправить сообщение в чат Claude Desktop, стримить ответ |
| `claude_new_chat` | Создать новый чат (опционально в проекте) |
| `claude_list_chats` | Список последних чатов с названиями |
| `claude_open_chat` | Продолжить существующий чат по id |
| `claude_list_projects` | Список проектов пользователя |
| `claude_artifact` | Получить артефакт по id |
| `bash_execute` | Выполнить bash команду, вернуть stdout/stderr/exitCode |
| `playwright_action` | screenshot, navigate, click, fill, extract |
| `applescript_run` | Выполнить AppleScript или Automator workflow |

`agent_status` убран из AI tools — не несёт ценности для AI агента.
Healthcheck доступен через `agentRegistry.isConnected()` внутри бота.

### `bash_execute` — лимиты

- Таймаут: 60с по умолчанию, override через `payload.timeout_ms` (max 300с)
- Лимит stdout/stderr: 50 КБ (truncate с предупреждением)
- Long-running процессы (без завершения за timeout): SIGTERM → 5с → SIGKILL
- Выполняется от имени текущего macOS пользователя, без дополнительной sandbox
  (пользователь явно устанавливает агент и включает скилл)

---

## Settings: `assistant` Category

В `manage_settings` tool добавляется category `assistant`:

```typescript
// tools.ts — category enum расширяется:
category: 'general' | 'notifications' | 'calls' | 'privacy' | 'voice' | 'assistant'
```

**Схема БД:** новая колонка через миграцию (consistent с паттерном проекта — каждый флаг это явная колонка):

```sql
ALTER TABLE users ADD COLUMN assistant_enabled INTEGER NOT NULL DEFAULT 0;
```

**Handler в `handleManageSettings`** (`tool-handlers/settings.ts`):

- `get` → читает `user.assistantEnabled` (boolean), возвращает текущий статус + статус подключения агента
- `update` → пишет `userRepo.updateAssistantEnabled(userId, value)` через новый метод в `UserRepository`

Пользователь управляет через AI ("выключи ассистента") и через `/settings` команду.

---

## Bot Server: WebSocket Integration

WebSocket endpoint добавляется в существующий OAuth web server (`src/web/server.ts`,
`startWebServer()`). Это тот же `Bun.serve()` на `OAUTH_SERVER_PORT` (дефолт 3311).
Дополнительный порт или третий `Bun.serve()` не нужен.

`startWebServer()` расширяется: принимает опциональный `agentWsHandler` в deps и добавляет
`websocket` ключ в `Bun.serve()`. В `fetch` добавляется ветка на `/ws/agent`:

```typescript
// src/web/server.ts — существующий fetch расширяется:
if (url.pathname === '/ws/agent') {
  const jwt = req.headers.get('authorization')?.slice(7)
  const userId = jwt ? verifyAgentJwt(jwt) : null
  // userId может быть null — режим паринга, сервер примет { type: 'pair', code }
  server.upgrade(req, { data: { userId } })
  return new Response()
}
```

Никаких HTTP endpoints для паринга нет — всё через WebSocket.
`/activate` — Telegram команда в `src/bot/commands/connect.command.ts`.

---

## New Bot Command

`/connect` — показывает:

```
🔗 Подключить AI Ассистент

Скачай агент для macOS:
[ссылка на .pkg]

После установки приложение само покажет команду активации.
Просто запусти его и следуй инструкции на экране.
```

`AGENT_DOWNLOAD_URL` — в конфиге бота (env var). Указывает на GitHub Releases или CDN.

---

## Security Model

- JWT подписан `AGENT_JWT_SECRET` (env var), алгоритм HS256, expires: 1 год
- Pairing codes — одноразовые UUID-based, TTL 10 минут
- POST `/agent/pair/init` — rate limit 5 запросов/минуту с одного IP
- Cookies никогда не передаются через WebSocket на сервер
- `bash_execute` — от имени текущего macOS пользователя, без sandbox (explicit opt-in)
- WebSocket — WSS (TLS через существующий nginx/reverse proxy)
- Один агент на пользователя: новая активация инвалидирует старый JWT

---

## macOS Agent: Tech Stack

- **Language:** Swift + SwiftUI (macOS 13 Ventura+)
- **Build:** Xcode → `.dmg` через `create-dmg` (Finder-окно с иконкой приложения + стрелка + папка Applications)
- **Tray icon:** SwiftUI `MenuBarExtra` + `MenuBarExtraAccess` (orchetect)
- **Tray menu содержит:**
  - Статус подключения (● Подключено / ○ Не подключён)
  - "Запускать при старте системы" [✓] — тогл, управляет `LaunchAtLogin`
  - "Отключить агент" — disconnect + показать pairing code заново
  - "Выход"
- **Wizard:** SwiftUI `NavigationStack` — только первый запуск
- **Launch at login:** `LaunchAtLogin-Modern` (sindresorhus) — **включён по умолчанию** при первом запуске
- **Keychain:** `KeychainAccess` (kishikawakatsumi)
- **SQLite (cookies):** `GRDB.swift`
- **WebSocket:** нативный `URLSessionWebSocketTask` (Foundation)
- **Browser automation:** бандлированный Node-процесс с Playwright, вызов через `Process`
- **bash / AppleScript:** `Process` + `NSAppleScript`
- **HTTP/SSE (claude.ai):** `URLSession` + `AsyncStream` для SSE парсинга
- **Logging:** `OSLog` → `~/Library/Logs/HyperBot Agent/`
- **Code signing:** v1 — без подписи (пользователь: правой кнопкой → Открыть, или `sudo xattr -rd com.apple.quarantine /Applications/HyperBotAgent.app`). v2 — Apple Developer Program ($99/год) + notarization.

---

## Testing Strategy

**Bot Server (bun test):**

- Unit: pairing service (code gen, TTL, JWT issue, invalidation), registry (connect/disconnect/lookup), dispatcher (timeout, abort, reconnect during task)
- Unit: `getToolDefinitions` фильтрация по `UserCapabilities` (все 4 комбинации)
- Integration: WebSocket handshake (valid JWT, expired JWT, invalid JWT), full pairing flow

**macOS Agent:**

- Unit: cookie extraction из SQLite, WebSocket reconnect logic, protocol serialization/deserialization
- Unit: circuit-breaker логика для claude.ai API
- E2E (против test bot server): полный pairing flow, команда → стрим → done

**Coverage цель:** ~80% для всех новых модулей.

---

## Out of Scope (v1)

- Windows / Linux агент
- Несколько агентов на одного пользователя (multi-device)
- Auto-update агента (в v2)
- Code signing macOS
- Запись видео / скринкаст
- Push-уведомления от агента без запроса пользователя
