<div align="center">
  <img src="assets/icon.png" alt="HyperCalendarBot" width="160" />
  <h1>HyperCalendarBot</h1>
  <p>AI-powered Telegram calendar assistant with voice calls, image rendering, and smart intent learning</p>
</div>

---

## What it does

A Telegram bot that manages your personal and group calendars through natural language. Type "Remind me about standup tomorrow at 10am" — the bot parses it, stores it, and calls you when the time comes. Everything runs through a 3-layer pipeline: pre-approved intent matching (no AI cost, instant response) → Anthropic (Claude) SDK agent → intent learning from successful interactions.

**Languages**: English and Russian.

## Features

### Calendar & Events
- Full event CRUD — create, edit, delete, list
- Recurring events (rrule: daily, weekly, monthly, custom)
- Multi-day events, all-day events
- Smart natural language parsing (EN/RU)
- Free slot search across your calendar
- Import/export (iCal format)
- Public holidays for ~150 countries

### AI Agent
- Anthropic SDK streaming agent with 40+ tools (model configurable via `AI_MODEL`)
- Up to 15 tool-use rounds per message
- Intent learning: after each AI interaction a fast model extracts a reusable pattern; admin approves it → future identical requests skip AI entirely (instant response, zero API cost)
- System prompt adapts to user context (timezone, language, secretary access, group mode)

### Notifications & Reminders
- Telegram message reminders
- **Voice call reminders** via MTProto P2P calls (Pyrogram + patched ntgcalls)
- TTS: Kokoro-82M (HuggingFace) or Silero (local) → Google TTS fallback
- STT: Deepgram Nova/Flux streaming (live calls) + Whisper via HuggingFace (messages)
- BullMQ job queues (Redis) — reminders survive bot restarts

### Calendar Views
- Calendar images rendered by Playwright: daily agenda, weekly overview, monthly calendar, event cards, conflict schedules
- Background rendering via BullMQ worker (Redis)

### Sharing & Collaboration
- Event sharing with invite links
- Secretary access — delegate calendar management
- Group calendar mode for teams and families
- Event proposals with voting

### Integrations
- Google Calendar bidirectional sync (OAuth 2.0)
- Birthday tracking with automatic reminders
- Timezone detection via geolocation (city name or GPS)

## Architecture

```
Telegram message
      │
      ▼
┌─────────────────────┐
│  FeedbackRouterLayer│  ─── admin feedback thread replies
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  IntentMatcherLayer │  ─── regex/keyword match → direct execution (no AI)
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│   AiAgentLayer      │  ─── CalendarBotAgent (Anthropic SDK, streaming)
└─────────┬───────────┘
          │
          ▼
     IntentLearner    ─── extracts intent candidate (AI_MODEL) → admin approval
```

**Stack:**
- Runtime: [Bun](https://bun.sh) (no Node.js)
- Bot framework: [GramIO](https://gramio.dev) + `@gramio/scenes`
- AI: Anthropic Claude (model configurable via `AI_MODEL` / `AI_FAST_MODEL`)
- Database: `bun:sqlite` WAL mode
- Queue: BullMQ on Redis
- Calendar rendering: Playwright
- Sync: Google Calendar API
- Voice: Pyrogram + ntgcalls (patched), Kokoro/Silero/Google TTS, Deepgram STT
- Linting: Biome

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) >= 1.3
- Redis
- Python 3.12 + uv (for voice calls)

### Install

```bash
bun install
```

### Configure

Copy `.env.example` to `.env` and fill in the values. The example file contains descriptions for all options.

### Run

```bash
bun run src/index.ts
```

### Voice Call Setup (optional)

Voice calls use Pyrogram + patched ntgcalls. The patch fixes a silent audio bug in ntgcalls v2.1.0.

```bash
# Create Python venv
uv venv --python 3.12 venv
uv pip install -r pyproject.toml --python venv/bin/python

# Build patched ntgcalls (~5 min, needs ~5 GB RAM)
./scripts/build-patched-ntgcalls.sh python3.12 venv

# Authenticate MTProto session (one-time interactive)
venv/bin/python scripts/pyrogram-auth.py
```

## Development

```bash
bun run src/index.ts     # start the bot
bun test                 # run all tests (~1700 tests, ~93% coverage)
bun test --coverage      # coverage report
bun run lint             # Biome lint check
bun run lint:fix         # auto-fix lint issues
bun run format           # format with Biome
```

### Database

Migrations run automatically on startup (`src/database/migrations.ts`). All database access goes through repositories in `src/database/repositories/`. Never write raw SQL outside of repositories.

### Adding an AI Tool

1. Add tool schema to `src/services/ai/tools.ts`
2. Add handler to the appropriate file in `src/services/ai/tool-handlers/`
3. Register dispatch in `src/services/ai/tool-executor.ts`
4. Write tests in `test/services/ai/tool-handlers/`

### Workers

For periodic tasks, always use BullMQ repeating jobs — never `setInterval` or `setTimeout`. Repeating jobs survive restarts and are observable in the queue.

Three queues: `image-render`, `call-reminders`, `bot-tasks`.

### Patching Library Types

When a dependency ships incorrect TypeScript types, the response is **not** `as unknown as ConcreteType` or `as any`. The correct workflow:

1. **Identify the exact type deficiency** — wrong property names, missing union members, incorrect parameter types.
2. **Fix at the source** — create a minimal reproduction, then open an issue + PR upstream.
3. **Patch locally until the fix merges**:
   - Use `patch-package` to commit the diff alongside your source:
     ```bash
     bunx patch-package <package-name>   # generates patches/<package-name>+<version>.patch
     bun add --dev patch-package
     # add "postinstall": "patch-package" to scripts in package.json
     ```
   - Or pin a fork/branch in `package.json` + `overrides`:
     ```json
     "overrides": {
       "<package-name>": "github:your-org/fork#fix-branch"
     }
     ```
4. **Do not leave `as unknown as` in the codebase** — it bypasses all type checks and hides the real problem.

Once the upstream PR is merged, remove the patch/override and bump the version.

## Testing

```bash
bun test                                                    # all tests
bun test test/services/intent/intent-learner.test.ts       # single file
bun test --coverage                                         # with coverage
```

TDD is required: write a failing test first, confirm it fails for the right reason, then implement.

## Project Structure

```
src/
├── bot/
│   ├── commands/       # command handlers (/add, /week, /settings, ...)
│   ├── pipeline/       # message routing layers
│   └── scenes/         # multi-step wizards (add-event, timezone, ...)
├── config/             # constants, i18n strings, environment
├── database/
│   ├── migrations.ts   # sequential schema migrations
│   └── repositories/   # data access layer
├── services/
│   ├── ai/             # agent, tools, tool-executor, tool-handlers
│   ├── event/          # CRUD, recurrence, formatters
│   ├── google/         # Calendar sync, OAuth
│   ├── holiday/        # date-holidays, SQLite cache
│   ├── intent/         # IntentMatcher, IntentLearner
│   ├── sharing/        # invitations, proposals, secretary
│   └── voice/          # TTS, STT, call scheduling
├── utils/              # telegram helpers, date utils, crypto
└── worker/             # BullMQ job definitions and processors
scripts/
├── *.ts                # development utilities
├── *.py                # Python MTProto scripts
└── *.sh                # build and deploy scripts
docs/
├── specs/              # feature specifications (00-08 + recent)
└── plans/              # implementation plans
```

## Specs

Feature specifications live in `docs/specs/`:

| File | Covers |
|------|--------|
| `00-common-architecture.md` | Stack, conventions, sub-project registry |
| `01-core-bot-event-model.md` | Event CRUD, commands, timezone |
| `02-ai-agent.md` | Claude agent, tool execution |
| `03-google-calendar-sync.md` | Google Calendar OAuth + sync |
| `04-notifications.md` | Reminders, push, scheduling |
| `05-image-generation.md` | Calendar image rendering |
| `06-sharing-social.md` | Invitations, group calendars |
| `07-voice-calls.md` | Voice call reminders, MTProto |
| `08-holidays.md` | Holiday subscriptions |

## License

Private repository.

## Intent seed catalogue

[Предустановленные сценарии и методика сравнения с БД](docs/intent-catalogue.md). Read-only catalogue generation never applies the seed; examples and diagnostics are derived from the same pure source data.

## Intent catalogue (generated source documentation)

[Browse the full intent catalogue and current-seed status in GitHub](docs/intents/README.md).
Run `bun run docs:intents` to regenerate Markdown/HTML/JSON; `bun run docs:intents:check` and the normal test suite detect stale output. Private DB/history snapshots are never required for a public build.
