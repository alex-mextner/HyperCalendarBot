# Three inference tiers and foreign-exchange calculation

## Confirmed owner choices
Every ordinary conversational turn and command reaches a light classifier BEFORE a deterministic intent can execute. Authentication codes/passwords, protocol callbacks and system events never go to a model. No keyword/heuristic router. All authorized tool names and short descriptions stay visible at every tier; discover_tools is always fully defined. The classifier selects light, medium or smart and initial context, not a fixed irreversible workflow. A stronger executor can discover missing context.

Light: Groq Qwen 3.8 27B with reasoning none, then GPT-OSS20B low. Cerebras Qwen and Together Bonsai are experimental opt-in candidates pending credentials, provider-specific validation and data-policy approval, not silently active fallbacks.
Medium: Groq GPT-OSS120B low.
Smart: Gemini 3.1 Pro high is the current tested candidate, with GLM-5.3 (NOT Flash) last through a normal licensed API route. Do not silently downgrade an unresolved repair to medium/light. Coding Plan quota is not general-purpose bot API credit.

Misunderstanding, repeated/rephrased unresolved requests and frustration directed at the bot trigger smart, with visible user-turn IDs as evidence. Profanity, a quoted event title or anger at a third party alone are not evidence. A trusted open-repair state keeps a terse followup on smart. Only verified resolution/new-task boundaries clear it; a model cannot discard actor/chat scope, pending requests or completed actions. Completed writes must never be repeated merely to regenerate an answer.

## Implemented in isolated continuation branches
- Currency executor is wired through the existing calculate dispatch: explicit target_currency, dimensional decimal arithmetic, 500-character cap, 40-place division, bounded daily public FX feed with timestamps/source and no guessed rates. Ordinary/date arithmetic retained. Fetch sends no personal amounts or identities. No paid FX account needed.
- Three-tier classifier packet, strict allowed-name schema, evidence checks, real deadline/cancellation, protocol exclusions and conservative smart fallback.
- Runnable orchestration: classify first, skip deterministic handlers during smart/repair, bounded per-turn schema discovery, undeclared-tool invocation guard and no implicit smart downgrade.
- These orchestration APIs are NOT yet connected to Telegram ingress/production. Caller must persist scoped repair state and pass authorization-enforcing business handlers. No claim of production speedup.

## Remaining delivery order
1. Independently review and land base catalog/transcript/calculator PRs, then continuation changes. Keep PR264 ancestry/conflicts with PR260 visible; do not force-push concurrent work.
2. Wire classifier before intent matching, preserving existing authentication/scene protocols and group-admission policy; preserve all completed-action facts and request identity across retries.
3. Add provider-specific streaming usage and Gemini thought-signature round-tripping before multi-round Smart rollout. Existing generic streaming reconstruction can drop provider metadata.
4. Connect actual context reads using current authorization services. Plans choose ranges; not-loaded/inaccessible/truncated/empty are distinct. No side-effecting prefetch.
5. Run full multi-round tests with deterministic tool outcomes, argument assertions and total cost/latency, including retry waits and final Telegram delivery. Compare smart to medium on matched repair scenarios; do not infer superior quality from parameter count or marketing.
6. Use normal gh ship local fallback, never skip checks. September 13 dry-run of #261 from canonical checkout ran main plus an ignored logs/*.test.ts incident fixture: 9 contact failures. This is not a clean PR-head validation. Preserve the fixture, investigate execution root; do not erase failing tests or forge CI success.

## Accounts / provisional budgets
Groq: upgrade existing organization to Developer, no mandatory upfront payment; suggested org monthly cap $10 with $5/$7.50/$9 alerts. Review other tools sharing that organization first.
Google: current key already served Gemini3.1Pro calls. Inspect existing AI Studio billing before buying anything. If needed, prepaid minimum $5; initial project cap $5; avoid migrating a shared billing account without checking effects.
Cerebras: verified payment method unlocks $5 trial credits for 30 days; buy no extra credits before the comparison.
Together: requires a minimum $5 credit purchase even when Bonsai's model token price is zero. Optional experiment, not a monthly subscription.
GLM5.3: normal API returned insufficient balance/resource package; keep inactive until regular API access is configured. Do not buy/repurpose Coding Plan for bot calls.
These caps do not form an exact global limiter; provider accounting is delayed. A cross-provider in-app monthly ceiling still needs implementation.

## Latest verification and boundaries

Currency extension: all 4,672 tests passed (8 skipped), typecheck/lint pass; three role-specific independent CLI review runs completed without remaining findings after rational precision/body cleanup fixes.
Router review follow-up: immutable allowlisted execution context is now passed to both callbacks; snapshots touch at most the last 64 history items and retain six relevant turns. Omitted pending/action counts are explicit and force Smart. The mandatory discover_tools name is reserved, and catalogs over 128 tools fail before classification or deterministic execution. No keyword intent-selection heuristic was added.
Gemini first-action screen: 12 scenarios, 12 HTTP successes, 10 literal rubric passes; OSS120 low 12 successes, 11 literal passes. The rubric is not a semantic oracle: a no-tool refusal for an unknown currency may be valid, and date-window end conventions must match the actual repository before grading. Neither score proves Smart is better. Gemini-specific tool metadata must survive round trips: a synthetic second call succeeded with metadata retained and failed with HTTP400 when dropped.
GLM5.3 normal API returned insufficient balance/resource package. Coding endpoint availability does not imply that normal API is funded.
