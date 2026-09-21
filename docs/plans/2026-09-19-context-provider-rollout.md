# Context reduction, provider accounts and benchmark retention — 2026-09-19

## Current production baseline, not a percentile claim
The deployed revision c97a0ed answered one controlled Telegram marker request in 8768.33 ms, with first visible output at 8322.52 ms. The main z.ai GLM5.1 call used 15053 prompt tokens and took 7962.12 ms after an HF failure. Groq OSS20 validation took 393.01 ms. This is one controlled real request, not natural traffic or an accepted p95. Preserve the exact source metrics and failed-attempt identities; do not compare it as equivalent to the earlier miniature router tests.

## GH-344 incident: blind tool call never recovered (2026-09-21)
Production incident: a model called a real mutating tool (add_contact) directly, twice, without ever calling discover_tools first — both attempts rejected as TOOL_SCHEMA_NOT_EXPOSED and the run gave up, nothing saved. Root cause confirmed from the chat-history tool-call/tool-result trace: the model had only ever seen the tool's one-line index description, never its actual schema, so it never knew a required field was missing either. `tool-exposure.ts`'s `intercept()` now auto-activates the real schema for a blindly called tool on rejection, so the very next round's contract includes it; same-batch execution and unknown/budget-exhausted names remain blocked exactly as before. Regressions: `test/services/ai/tool-exposure.test.ts` (blind-call recovery, same-batch block preserved, budget-boundary pinned) and `test/services/ai/agent-run.test.ts` (anonymized end-to-end incident replay). Fixed by https://github.com/alex-mextner/HyperCalendarBot/pull/345, tracked in https://github.com/alex-mextner/HyperCalendarBot/issues/344. Deferred finding: the auto-expose fix is best-effort under the active-schema budget (MAX_ACTIVE_TOOLS=65 / MAX_ACTIVE_SCHEMA_CHARS=48000) — several distinct blind misses can starve that budget and push a later legitimate discover_tools call into 'deferred'. Bounded and pinned by a regression in PR #345, but not yet evaluated under representative multi-round traffic. Next action: tracked as a new acceptance criterion on https://github.com/alex-mextner/HyperCalendarBot/issues/256 ("Evaluate active-schema budget starvation..."), to resolve before broader lazy-mode rollout.

## Implemented source slice under #256
Reuse the previous tool catalog and connect per-run exposure to both real agent loops. All 64 current mode-allowed names and brief descriptions stay visible; discover_tools always has its full schema. Batched groups/names reveal canonical schemas only for the next model round. Existing dispatch validation/authorization remains mandatory. Discovery is neither a business action nor evidence of calendar facts, and full schemas are not copied into durable chat history.
The explicit AI_TOOL_SCHEMA_MODE setting defaults to full and rejects misspellings. Optional AI_TOOL_SCHEMA_USER_IDS accepts at most100 comma-separated positive safe integer Telegram user-ID entries (duplicates count toward the input bound and are then deduplicated); with lazy mode selected, only the configured actors use the shortened payload, and all other users retain full mode. Switching the main text agent to lazy is a separate canary step after review; voice is explicitly excluded from this initial text canary; its existing contract stays full. This does not by itself implement the every-turn Light classifier or three executor tiers.

## Same-fixture payload measurements
Run `bun scripts/measure-ai-payload.ts --json`; archive its PAYLOAD_JSON record with source SHA/tree and UTC timestamp. The unchanged system instructions remain included.

| DM variant | Estimated input tokens before history/data |
| --- | ---: |
| Full 64 schemas | 14730 |
| All brief names plus full discover_tools | 6996 |
| Same index plus discovery, calendar-read and calculator schemas | 8144 |

These are approximate tokens (estimator ±20%), not billed token counts. Extra discovery calls can offset savings; compare complete task latency and total tokens, including classifier, retries, validators and delivery. Free-tier minute throughput is not the model's context window, and should never be hardcoded as an eternal account property.

## Next reductions, in order
1. Carry the existing Light router's bounded selection into the exposure session so selected schemas are present on the first executor call. No keyword heuristic and no smaller groups-only catalogue. Preserve current request, identity, permissions, timezone, pending confirmations and completed writes.
2. Split invariant safety rules from domain instructions; load domain instructions alongside selected schemas, with negative tests for omitted permissions and confirmation rules. Do not silently remove shared-event, group-privacy or date interpretation constraints.
3. Let the model select none/hour/day/week/custom calendar reads, then fetch independent authorized reads concurrently. Not-loaded, forbidden, truncated and genuinely empty are different states. Fetch event details by stable IDs only when needed.
4. Compact older bulky read results into bounded structured records with recoverable references. Keep write receipts, unresolved requests and provider-required tool metadata intact. Never summarize away proof of already committed actions.

## Account recommendation, verified against official docs on 2026-09-19
Use four providers, not several consumer subscriptions. User performs registration, email/MFA and card/bank verification in the authorized Mac browser; automated configuration must never capture credentials, card details or keys into chat/logs.

| Provider | Initial action / funding | Role |
| --- | --- | --- |
| Existing Groq organization | Developer pay-as-you-go, card; no mandatory upfront charge. Proposed organization limit $10/month. | Qwen3.8 none / OSS20 low Light comparison; OSS120 low Medium. |
| Existing Google AI Studio project | Verify current billing before changing it. If Prepay needs funding, minimum $5; proposed project cap $5/month, auto reload off initially. | Independently hosted Smart candidate and Flash fallback tests. |
| Cerebras | New account and verified payment method unlock $5 credits for 30 days; buy no extra credits before benchmark. | Independent low-latency Qwen3.8/OSS120 comparison. |
| Together | New account/card, minimum $5 prepaid platform balance; auto recharge off initially. | Bonsai27B zero-token-price experiment plus Qwen/GLM candidates. |

The proposed initial allocation is at most $10 Groq usage + $5 Google + $5 Together, with Cerebras trial credit. This is not a precise global hard ceiling: provider metering is delayed and existing shared-account consumption must be inspected. Preserve room under the user's $20 monthly ceiling; no automatic cross-provider top-ups without a separately authorized policy.
Groq's Qwen is preview and must have a working alternative. Several models on one provider are not independent outage protection. Normal GLM5.3 remains a last-resort candidate after comparison; a Coding Plan quota is not general-purpose API funding. Do not buy another Coding Plan or HF subscription for this rollout.
Official references: https://console.groq.com/docs/billing-faqs ; https://console.groq.com/docs/spend-limits ; https://ai.google.dev/gemini-api/docs/billing ; https://inference-docs.cerebras.ai/support/rate-limits ; https://docs.together.ai/docs/billing-credits ; https://www.together.ai/pricing .

## Benchmark retention
An immutable private snapshot of 24 previous measurement/evaluation files was saved at logs/benchmark-history/20260919T093039652766Z with source paths, byte counts and SHA256 verification. Originals remain unchanged. Never publish raw conversation, calendar/contact data or secrets.
Each new run needs its own UTC ID, source SHA/tree, input fixture/prompt/catalog version, model/provider/reasoning settings, true attempts/retries, known/missing token usage, request/first-visible/delivery timings, quality checks and sample type. Corrected scoring is a new derived record with a reference to its original, not an overwritten baseline. Keep small synthetic probes, controlled live requests and natural-traffic distributions separate.

## Other active work retained
Current provider-circuit and canonical-intent workspaces have active owners; do not duplicate or overwrite them. The old speed-integrated workspace remains recoverable and contains the next classifier/repair-store wiring. ExpenseSync currency safety, FX and dependency fixes remain tracked separately. No claim that these other tasks are complete from this source slice.

## Additional verified continuation
The canonical main base is7e2fcf1, which already includes persistent generic provider circuits. Do not replace those with HF-specific suppression. The deployment chain is already working; this slice does not rewrite it.
Latest same-fixture run20260919T131816487438Z again measured14730/full,6996/lazy-initial,8144/lazy-read estimated input tokens. All24 original archived benchmark copies were verified by SHA256 and remain unchanged. This run is separate and includes hashes of the actual prompt/catalog/exposure sources.
Canary tests include both included/excluded actors and invalid configured IDs. A specifically requested dedup regression confirms an unexposed rejected update can be performed exactly once after discovery; the old dispatcher already excludes failed dispositions from successful-call dedup. No fictitious dedup fix is claimed. New code follows current type policy instead of inheriting the old Record<string,unknown> boundary cast.

## Browser handoff and spending limits
The owner only registers/signs in, confirms email/MFA and adds a payment method in the authorized browser. Subsequent project/key/model settings and canary validation use that browser session; bank confirmations remain owner-only. No keys or card data in chat, screenshots, repository or logs.
Groq10USD and Google5USD are proposed monthly caps, not subscription fees. Together5USD is an initial prepaid experiment balance; Cerebras5USD is a30-day trial grant after card verification. No automatic recharge; do not purchase additional Cerebras or z.ai credit without an explicit amount. A delayed provider cap is not a mathematically strict cross-provider20USD ceiling.
Further input reductions preserve all short tool names, actor/scope/auth/timezone/pending-confirmation invariants and completed-write receipts: model-chosen read windows, narrow event/contact projections with stable detail IDs, deduplicated tool results, domain prompts loaded with requested schemas, and stable cached prefix before volatile per-turn facts. Do not use keyword-based prefetch or erase failed/pending actions merely to save tokens.

Review follow-up: invalid discovery attempts intentionally consume the six-attempt run budget. A direct real-agent regression now verifies that a reused lazy-configured agent still sends full schemas for live calls; explicit isolation avoids relying solely on factory wiring. Per-run schema cloning is retained to prevent mutable/capability state crossing users; its bounded cost is not confused with multi-second provider latency.

