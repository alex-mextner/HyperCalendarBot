# GH-379: optional Cerebras and Together providers

Add two optional AI provider slots (Cerebras, Together) on top of the existing
OpenAI-compatible transport, circuits, deadlines and telemetry. Both stay out of
the default chain order — they are only tried when named explicitly in
`AI_SMART_CHAIN` / `AI_FAST_CHAIN`, and only when their key is configured. Absent
keys must not change any existing route.

## Scope

- [ ] `src/services/ai/provider-ids.ts` — add `'cerebras'`, `'together'` to `PROVIDER_IDS`.
- [ ] `src/config/env.ts` — `CEREBRAS_KEY?`, `CEREBRAS_BASE_URL` (default
      `https://api.cerebras.ai/v1`), `CEREBRAS_MODEL?`/`CEREBRAS_FAST_MODEL?`
      (default `gpt-oss-120b` only when `CEREBRAS_KEY` is set — no fast-specific
      default, only the one proven model); `TOGETHER_KEY?`, `TOGETHER_BASE_URL`
      (default `https://api.together.ai/v1`), `TOGETHER_MODEL?`/`TOGETHER_FAST_MODEL?`
      (defaults `openai/gpt-oss-120b` / `openai/gpt-oss-20b` when `TOGETHER_KEY` is set).
      `DEFAULT_SMART_CHAIN`/`DEFAULT_FAST_CHAIN` unchanged — new ids reachable only
      via an explicit chain order.
- [ ] `src/services/ai/clients.ts` — `cerebrasClient()`, `togetherClient()`
      mirroring `groqClient()` (optional key with `!`, `DEFAULT_TIMEOUT_MS`,
      `maxRetries: 0`), both reset in `resetClients()`.
- [ ] `src/services/ai/streaming.ts` — `providerClients`, `PROVIDER_LABELS`
      ('Cerebras', 'Together'), `buildSmartChain`/`buildFastChain` availability
      entries with `baseUrl` (circuit fingerprint), and a Together-only
      normalization of tool-only assistant messages whose `content` is
      `null`/`undefined` to `''` on a cloned request — never mutating the caller's
      `messages` array/objects, never touching non-Together providers.
- [ ] `src/services/ai/model-registry.ts` — `ModelPreferenceTable` gets
      `cerebras`/`together` entries (empty for cerebras, the two named ids for
      together); a `togetherModelListing()` adapter that reads Together's
      top-level-array `/models` response into the `{ data: [] }` shape the rest
      of the module expects, used only for the together slot.
- [ ] `src/utils/ai-provider-alert.ts` — `envNames()` gets `cerebras`/`together`
      branches so an outage alert names the right `.env` variables.
- [ ] `.env.example` — document the two optional keys (commented out, consistent
      with Groq's absence being the existing minimal-deployment default).

## Non-goals

- No change to `DEFAULT_SMART_CHAIN` / `DEFAULT_FAST_CHAIN` — Groq keeps its
  configured priority; Cerebras/Together require an explicit chain order.
- No change to Gemini thinking/error decoding (separate lane).
- No model substitution beyond the four ids named in the ticket.
- No live network calls — all evidence is from the ticket's own account testing.

## Verification

- `bun test test/services/ai test/config` — new + existing tests green.
- `tsc --noEmit` — zero errors.
- `bun run lint` — zero warnings.
- Red/green logs under `logs/provider379/`.
