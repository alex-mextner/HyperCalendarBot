# Claude Desktop OAuth Token Integration — Design Spec

Status: **Partial implementation shipped.** This spec covers the OAuth token
*pairing/storage pipeline* only. Routing live AI turns through a Claude Desktop bearer token
is explicitly deferred — see "Deferred work" below.

Source issue: #44 ("Claude Desktop OAuth token integration"). Prior investigation:
`docs/plans/2026-09-08-desktop-oauth-integration.md` (read that first — this doc resolves the
four blockers it raised and is the durable record of those decisions).

## Problem

Issue #44 asked for the bot to use a user's own Claude Pro subscription (via Claude Desktop's
OAuth pairing) for AI responses, instead of (or alongside) the bot's own provider keys. The
issue referenced a design spec at a path that never actually existed in this repository; the
plan doc above reverse-engineered the intended design from the issue body and found it
predates a since-merged architecture change (PR #62) that invalidates its central assumption.

## Blockers and how each is resolved

### Blocker 1 — the issue's core assumption no longer holds

PR #62 (2026-04-11) migrated the entire AI agent off the Anthropic SDK onto OpenAI-SDK-compatible
providers exclusively (`z.ai`, Groq, Gemini, Hugging Face Router — see
`src/services/ai/provider-ids.ts`). `src/services/ai/agent.ts` now builds every AI turn through
`src/services/ai/streaming.ts`'s multi-provider chain, not a single Anthropic client. Whether and
how a parallel Anthropic-only bearer-mode call path should coexist with that chain is a real
product/architecture decision, not something to improvise mid-implementation.

**Resolution for this PR: deferred.** This PR does not touch `src/services/ai/agent.ts`,
`src/services/ai/streaming.ts`, or `src/services/ai/tools.ts` at all. It only builds the
token-pairing/storage plumbing (below). Actually routing AI turns through a bearer-mode
Anthropic client is filed as a tracked follow-up (see "Deferred work").

### Blocker 2 — token storage encryption

**Resolved:** reuse `encrypt()`/`decrypt()` from `src/utils/crypto.ts`, keyed by
`config.ENCRYPTION_KEY` — the same AES-256-GCM pattern already used for Google OAuth refresh
tokens (`src/web/oauth-callback.ts`, `src/services/google/oauth.ts`). No new encryption
mechanism was introduced. If `ENCRYPTION_KEY` is not configured, `OauthTokenStore.updateTokens`
logs a warning and drops the write rather than storing plaintext or throwing (a missing
encryption key must never crash the agent WebSocket connection or silently store tokens
unencrypted).

### Blocker 3 — third-party use of Claude Desktop's OAuth client_id

The original design has the bot **server** independently authenticate as Claude Desktop itself
(hardcoded first-party `CLIENT_ID`) to exchange/refresh OAuth tokens, and to make live
`/v1/messages` inference calls with a spoofed `X-Anthropic-Surface: operon-desktop` header, from
infrastructure the user does not control, on the user's personal Pro subscription. That carries
a real product/ToS risk (account suspension if Anthropic's backend fingerprints non-Desktop
callers) and was flagged in the plan doc as needing explicit named human sign-off — not an
engineering judgment call.

**Resolution for this PR: scoped entirely out.** Nothing in this PR ever calls the Anthropic
API. The Mac agent (`packages/agent-macos/`) already legitimately authenticates as Claude
Desktop **client-side** — that flow (`oauth-manager.ts`'s PKCE authorize/refresh) is pre-existing
and completely unaffected by this change. All this PR adds is a one-directional push: once the
Mac agent has valid tokens (via its own existing, legitimate flow), it forwards them to the bot
server over the *existing authenticated* `/ws/agent` WebSocket connection, and the server stores
them encrypted. The server never exchanges, refreshes, or uses these tokens to call
`api.anthropic.com` — it is a passive, encrypted-at-rest storage sink. The ToS risk described
above only applies once something calls the live Anthropic API from server-side infrastructure,
which this PR does not do anywhere. The sign-off-gated remainder (actually consuming these
tokens) is filed as a tracked follow-up issue (see below) and is explicitly blocked on that
sign-off before any code for it is written.

### Blocker 4 — no design spec to hold acceptance criteria

This document.

## What this PR ships

A one-directional OAuth token pairing/storage pipeline:

1. The Mac agent (already OAuth-paired with Claude Desktop client-side) pushes its current
   access/refresh token pair to the bot server whenever it acquires or refreshes them.
2. The bot server receives the push over the existing authenticated `/ws/agent` WebSocket
   connection, encrypts both tokens, and stores them keyed by the pairing's Telegram user id.
3. Nothing consumes these stored tokens yet — that is the deferred remainder.

### WebSocket message contract

Sent one-directionally from the Mac agent to the server, over the same authenticated connection
already used for pairing/commands:

```ts
{ type: 'anthropic_oauth_token', accessToken: string, refreshToken: string, expiresAt: number }
```

`expiresAt` is epoch milliseconds, matching `oauth-manager.ts`'s existing internal token shape.
The name avoids collision with the existing, unrelated `token_refreshed` /
`AgentTokenRefreshed` message (which re-issues the *pairing JWT* itself, not Anthropic tokens).

Server-side: a new variant in `AgentInboundSchema` (`src/agent/protocol.ts`), handled in
`src/agent/ws-server.ts`'s `message()` handler, guarded on `ws.data.userId` already being set
(the connection must be authenticated — an unauthenticated push is silently dropped, not
queued or errored).

### Database schema

Migration `062_create_agent_oauth_tokens`:

```sql
CREATE TABLE agent_oauth_tokens (
  user_id           INTEGER PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
  access_token_enc  TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  expires_at        INTEGER NOT NULL,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
```

One row per user (last-write-wins for multiple paired Macs — same as the existing
`user_telegram_sessions` pairing table, and explicitly out of scope per the original issue to
support multiple concurrent agents per user).

### New/modified files

| File | Change |
|------|--------|
| `src/database/migrations.ts` | Migration `062_create_agent_oauth_tokens`. |
| `src/database/types.ts` | `AgentOauthToken` row type. |
| `src/database/repositories/agent-oauth-token.repository.ts` | CRUD (`findByUserId`, `upsert`, `deleteByUserId`), follows `telegram-session.repository.ts`'s pattern. |
| `src/database/index.ts` | Wires `AgentOauthTokenRepository` into `DatabaseService`. |
| `src/services/ai/oauth-token-store.ts` | `OauthTokenStore.updateTokens` — encrypts and persists. Repository-backed; no in-memory cache, no read path — there is no consumer yet, so no `getAccessToken`/`loadFromDb` surface was built (would be unused exports; that surface belongs to the deferred follow-up once there's a real caller). |
| `src/agent/protocol.ts` | `anthropic_oauth_token` added to `AgentInboundSchema`. |
| `src/agent/ws-server.ts` | `createAgentWsHandler` takes an optional `OauthTokenStore`; `message()` handles the new type. |
| `packages/agent-macos/src/oauth-manager.ts` | `onTokensRefreshed` callback hook, fired whenever cached tokens change. |
| `packages/agent-macos/src/ws-client.ts` | `sendOAuthToken()`, mirrors `pair()`. |
| `packages/agent-macos/src/protocol.ts` | `AgentOAuthToken` outbound-only interface. |
| `packages/agent-macos/src/main.ts` | Sends tokens after `initOAuth()`, on every refresh, and on WS reconnect. |

## Explicitly out of scope for this PR

- `src/services/ai/anthropic-client.ts` (bearer-mode Anthropic fetch wrapper) — not built.
- Any change to `src/services/ai/agent.ts`, `src/services/ai/streaming.ts`, or
  `src/services/ai/tools.ts`.
- `@anthropic-ai/sdk` as a dependency — not added; nothing in this PR needs it.
- Any code path that calls `api.anthropic.com`, for token refresh or for inference.
- UI to show which auth mode is active (per original issue).
- Token revocation UI (per original issue).
- Multiple Mac agents per user beyond last-write-wins (per original issue).

## Deferred work

Routing live AI turns through the paired bearer token — the `anthropic-client.ts` wrapper,
branching `agent.ts` on `OauthTokenStore` presence, and gating an Anthropic-native web-search
tool in `tools.ts` — is filed as a separate tracked follow-up, explicitly blocked on:

1. **Blocker 1's product decision**: does bearer-mode routing still make sense given the
   post-migration multi-provider architecture, and if so, how does it coexist with the current
   chain (own eligibility state? excluded from `AI_SMART_CHAIN`/`AI_FAST_CHAIN` entirely? only
   used when explicitly paired?).
2. **Blocker 3's sign-off**: explicit named human/product sign-off before any code performs a
   live inference call using a Claude-Desktop-impersonating bearer token from server
   infrastructure — real account-suspension risk for users if it goes wrong.

No code for that remainder exists in this repository yet, by design.
