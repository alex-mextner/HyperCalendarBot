# Claude Desktop OAuth Token Integration — Implementation Plan

Based on: issue #44 (`feat: Claude Desktop OAuth token integration`). The issue references
`docs/specs/2026-03-30-desktop-oauth-design.md` as the "full design spec" — **that file does
not exist anywhere in this repository** (checked `main`, `worktree-agent-a5737bdeefa15dfb5`,
and full git history on all branches). The architecture below is reverse-engineered from the
issue body alone, which is detailed but was never promoted to a committed spec, and predates
a since-merged architecture change that breaks its central assumption (see Blocker 1).

## STOP — open decisions before any implementation starts

This plan exists so a human reviewer can scope the work, not as a ready-to-execute checklist.
Do not start Task 1 until these are resolved.

### Blocker 1 — the issue's core assumption no longer holds

Issue #44 was filed 2026-04-01. Ten days later, PR #62 (commit `39c5b76`, 2026-04-11) migrated
the entire AI agent off the Anthropic SDK onto OpenAI-SDK-compatible providers exclusively
(`z.ai`, Groq, Gemini, Hugging Face Router — see `src/services/ai/provider-ids.ts`). Today:

- `createAnthropicClient` / `src/services/ai/anthropic-client.ts` — **does not exist**. The only
  Anthropic client factory in the repo is `packages/agent-macos` (Electron, unrelated).
- `src/services/ai/agent.ts` builds requests through `OpenAI` (`import OpenAI from 'openai'`)
  and `src/services/ai/streaming.ts`'s multi-provider chain, not a single Anthropic client.
- There is no code path today that ever calls `api.anthropic.com` for chat completions, and no
  `web_search_20250305`-style Anthropic-native tool exists in `src/services/ai/tools.ts`.

So "when `bearerToken` is present, use it instead of the API key" has no client to attach to
any more — the feature as specified would require **re-introducing a parallel Anthropic-SDK
call path** used only for OAuth-paired users, sitting alongside the current multi-provider
OpenAI-compatible chain (with its own eligibility/fallback/model-registry machinery that the
Anthropic path would not participate in). That is a materially bigger and different piece of
work than the issue describes, and changes the shape of every task below. **A human needs to
decide whether this feature is still wanted post-migration, and if so, how an Anthropic-only
code path coexists with the current provider chain** (own eligibility state? excluded from
`AI_SMART_CHAIN`/`AI_FAST_CHAIN` entirely? only used when explicitly paired?).

### Blocker 2 — token storage has no encryption story

The issue's schema stores `access_token` / `refresh_token` as plain `TEXT` columns. These are
bearer credentials for a user's personal Claude Pro subscription — higher-value secrets than
the Google OAuth refresh tokens already in this repo, which **are** encrypted at rest
(`encrypt()`/`decrypt()` via `ENCRYPTION_KEY`, see `src/web/oauth-callback.ts`), and higher-value
than the Telegram MTProto sessions, which use dedicated AES-256-GCM envelope encryption
(`src/services/crypto/session-crypto.ts`, from the `connect-telegram` feature). Storing Claude
OAuth tokens in plaintext would be a regression against this repo's own established pattern.
Needs a decision: reuse `encrypt()`/`decrypt()` with `ENCRYPTION_KEY`, or a dedicated envelope
like `session-crypto.ts`.

### Blocker 3 — third-party use of Claude Desktop's OAuth client_id

The design authenticates the bot server as Claude Desktop itself (hardcoded first-party
`CLIENT_ID = '89355bc3-cbfd-4382-905b-976645cad410'`) to obtain and refresh tokens server-side,
independent of whether the paired Mac is online. Using a first-party app's registered OAuth
client outside that app, from a server the user does not control, to call the API on the user's
personal subscription is a product/ToS question with real account-suspension risk for the user
if Anthropic's backend fingerprints non-Desktop callers. This needs explicit sign-off from
@alex-mextner before writing any code that performs the refresh-token exchange server-side
(`doRefreshFlow` equivalent) — it is not an engineering judgment call.

### Blocker 4 — no design spec to hold acceptance criteria

The issue's own task checklist is the only acceptance criteria available. Before implementation,
someone should write `docs/specs/2026-04-XX-desktop-oauth-design.md` capturing the answers to
Blockers 1–3, so the plan below has a stable source of truth instead of an issue body that will
keep drifting as the codebase changes underneath it (as it already has once).

---

## If greenlit: architecture (updated for the current codebase)

Assuming Blocker 1 is resolved as "yes, add a parallel Anthropic-SDK path gated on pairing":

### New files

| File | Responsibility |
|------|-----------------|
| `src/services/ai/anthropic-client.ts` | New — thin wrapper around `@anthropic-ai/sdk`, `createAnthropicClient({ bearerToken? })`. Bearer mode: custom `fetch` strips `x-api-key`, adds `Authorization: Bearer`, `X-Anthropic-Surface: operon-desktop`, `anthropic-beta: oauth-2025-04-20,files-api-2025-04-14`. No-arg mode unused today (no `ANTHROPIC_API_KEY` fallback exists post-migration — needs its own decision: is there still a shared-key fallback, or does "no OAuth" mean "stay on the current OpenAI-compatible chain" per Blocker 1?) |
| `src/services/ai/oauth-token-store.ts` | New — singleton keyed by Telegram `userId`: `updateTokens`, `getAccessToken` (auto-refresh), `hasTokens`, `loadFromDb()`. Encrypts/decrypts via the mechanism chosen in Blocker 2. |
| `src/database/repositories/agent-oauth-token.repository.ts` | New — CRUD for the `agent_oauth_tokens` table, following the existing repository pattern (see `telegram-session.repository.ts`). |
| `test/services/ai/oauth-token-store.test.ts` | Store logic: expiry detection, auto-refresh, encrypted round-trip. |
| `test/services/ai/anthropic-client.test.ts` | Bearer-mode fetch wrapper: header rewriting, fallback to API-key mode. |
| `test/database/repositories/agent-oauth-token.repository.test.ts` | Repository CRUD. |

### Modified files

| File | Change |
|------|--------|
| `src/database/migrations.ts` | Append migration: `agent_oauth_tokens (user_id INTEGER PRIMARY KEY REFERENCES users(telegram_id), access_token_enc TEXT NOT NULL, refresh_token_enc TEXT NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)` — column names reflect Blocker 2's encrypted-at-rest decision. |
| `src/database/types.ts` | Add `AgentOauthToken` interface. |
| `src/agent/protocol.ts` | Add `oauth_token` to `AgentInboundSchema` (accessToken, refreshToken, expiresAt: number). Note: this file already has an unrelated `token_refreshed` / `AgentTokenRefreshed` message (JWT re-issuance for the pairing WS itself) — name the new variant to avoid confusion, e.g. `anthropic_oauth_token`. |
| `src/agent/ws-server.ts` | Handle the new inbound message; guard on `ws.data.userId` being set (authenticated), call `oauthTokenStore.updateTokens(userId, ...)`. |
| `src/services/ai/agent.ts` | At agent-run start: `oauthTokenStore.getAccessToken(userId)`. If present, route this turn through the new Anthropic bearer client instead of `aiStreamRound`'s OpenAI-compatible chain — this is the crux of Blocker 1's "how do the two paths coexist" question and needs the chosen answer encoded here, not improvised mid-implementation. |
| `src/services/ai/tools.ts` | Add an Anthropic-native web-search tool definition, included only when the turn is running in bearer mode. |
| `src/index.ts` | Call `oauthTokenStore.loadFromDb()` at startup, alongside the other repository/service wiring. |
| `package.json` | Add `@anthropic-ai/sdk` as a dependency (removed or never added post-migration — confirm it isn't still present as a transitive/unused dep before adding). |

### Mac agent (`packages/agent-macos/`) — already has OAuth plumbing, needs the push side

`oauth-manager.ts`, `ws-client.ts`, `protocol.ts`, `main.ts` already exist and already implement
the PKCE flow, refresh, and keytar storage entirely client-side. What's missing per the issue:

| File | Change |
|------|--------|
| `packages/agent-macos/src/oauth-manager.ts` | Add `onTokensRefreshed?: (accessToken, refreshToken, expiresAt) => void`, invoked from both `initOAuth()`'s stored-token path and `doRefreshFlow()`'s success path. |
| `packages/agent-macos/src/ws-client.ts` | Add `sendOAuthToken(accessToken, refreshToken, expiresAt)` — same envelope shape as existing outbound messages (see `pair()` for the pattern). |
| `packages/agent-macos/src/protocol.ts` | Add an `AgentOAuthToken` outbound-only interface (agent sends, server never sends it back — mirror how `AgentPairRequest` is documented as one-directional). |
| `packages/agent-macos/src/main.ts` | After `initOAuth()`, send current tokens once; wire `onTokensRefreshed` to `wsClient.sendOAuthToken`; re-send on the ws client's `connected` event for reconnects. |

### Task breakdown (sequenced, once Blockers 1–4 are resolved)

1. Write `docs/specs/2026-04-XX-desktop-oauth-design.md` capturing the resolved blockers.
2. DB migration + `AgentOauthToken` type + repository + tests (pure, no side effects).
3. `anthropic-client.ts` bearer-mode wrapper + tests (pure fetch-wrapping logic).
4. `oauth-token-store.ts` (store/refresh/encrypt) + tests, using the repository from step 2.
5. Server protocol: `protocol.ts` schema addition, `ws-server.ts` handler, integration test
   through the real WS handler (send `anthropic_oauth_token`, assert the store was updated).
6. Agent integration: `agent.ts` branch on `oauthTokenStore.getAccessToken`, `tools.ts` web-search
   gating — this is the step that answers "how does bearer mode coexist with the provider chain"
   in code; needs its own design review before merge given the blast radius (every AI turn passes
   through `agent.ts`).
7. Mac agent: `oauth-manager.ts` callback, `ws-client.ts` method, `protocol.ts` interface,
   `main.ts` wiring — independent of steps 2–6, can happen in parallel.
8. End-to-end manual verification against a real paired Mac before merging step 6 to main,
   since automated tests cannot exercise the real Anthropic OAuth token exchange.

## Out of scope (per issue #44)

- UI to show which auth mode is active.
- Token revocation UI.
- Multiple Mac agents per user (last-write-wins).
