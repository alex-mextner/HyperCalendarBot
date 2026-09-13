# Context routing: measured, staged implementation

Parent work: #219 and #226. Implementation slices: #256, #257, #258, #259.

## Existing work (verified September 12, 2026)

- PR #143 is merged: duplicate prose removed; measurement and dry-run scripts exist.
- PR #157 is merged: memory/address sections are bounded.
- PR #154 is merged: scoped provider cooldown, not request-aware context selection.
- PR #201 is open: known-location preload. Integrate on demand; do not duplicate it.
- PR #205 is open: intent seeds. Issue #204 separately blocks object/array workflow arguments.
- PR #194 is open: preserve committed execution log on provider fallback.
- PR #211 is open: optional MiMo, not a vetted default for personal data.
- Recipient (#255), reflection (#231/#245), and Mac retirement (#239) work touches agent/tools.

## Goal and invariant

Reduce total time to a correct, delivered answer, not merely output-token generation time.
A 21-successful-run sample is descriptive, not a stable tail-latency SLO. Count failures,
unmatched starts, repeated rounds, planner/discovery calls and final Telegram delivery.

Identity, actor/chat scope, timezone, permission checks, privacy instructions, current request,
pending confirmations and completed-write ledger must never be removable by an LLM planner.
Empty, not loaded, inaccessible and truncated data are different states.

## Sequence

1. **#256: discovery foundation.** Compact capability-filtered index and batched canonical-schema
   retrieval. Exact names and required parameters are preserved. Explicit names take priority;
   requested schemas beyond bounds are reported, never silently dropped. This first slice is
   exercised by tests and the existing payload measurement script; production is unchanged.
2. **#258: transcript compatibility.** Reproduce Groq/HF errors with synthetic two-round histories.
   Validate paired call/result IDs, names, duplicate/orphan results and provider capabilities.
   Never infer missing names or replay completed writes to repair a transcript.
3. **#259: measurement and evaluation.** Extend the existing dry-run harness with budgeted,
   stratified cases, arguments, total timing and token usage. Add usage-only stream handling.
   Screen with at least 40 distinct scenarios and three repeats; repeat over time for tail claims.
4. **#257: three-tier always-on router.** Every ordinary user message or command is classified
   BEFORE deterministic intent dispatch, so a repeated request or complaint cannot replay a write.
   Authentication secrets, protocol callbacks and system events stay in deterministic handlers and
   never reach a model. The router sees all authorized tool/group names with short descriptions,
   recent user AND assistant turns with roles, trusted pending-work/repair state and mandatory
   identity/scope/timezone policy. No keyword heuristic and no shortened group-only first index.
   The validated plan selects `light|medium|smart`, needed schemas and bounded context. Medium is
   GPT-OSS 120B low. Misunderstanding, repetition of an unresolved request or frustration at this
   bot triggers smart with user-turn evidence; profanity/anger at third parties alone does not.
   An open repair remains smart until trusted task outcome clears it. Lost network access and
   ambiguity are not permission to repeat calendar writes. Invalid or timed-out planning uses a
   smart fallback; genuine caller cancellation must not launch more work.
5. **#256 runtime integration.** `discover_tools` is always fully revealed. Every other available
   tool stays visible to the model as a name + short description even when its parameter schema is
   not expanded. The router may reveal multiple groups and/or tools in one plan. Later executor
   turns may call `discover_tools` to reveal more full schemas without losing the compact catalog.
   Validate every invoked name against the authorized catalog and every argument against the newly
   revealed canonical schema. Preserve retry/supplement/live-call semantics and current request state.
6. **Canary.** Switch provider order/payment only after operator action and scenario acceptance.
   No production activation, merging, external side effects or billing change in this first slice.

## Proposed plan shape (not an implemented or trusted authorization contract)

```json
{
  "groups": ["calendar.read", "contacts"],
  "tools": ["send_invitation"],
  "calendar": {"window": "week", "anchor": "next"},
  "optional_blocks": ["referenced_entities"],
  "prefetch": ["calendar_window"],
  "needs_clarification": false,
  "tier": "medium"
}
```

Normalize dates using one frozen request timestamp and the user's timezone. A code validator
resolves bounded ranges and resource scope. Prefetch is allowlisted reads only, never arbitrary
SQL, business tools, renders, writes or sends. The light router is called before every ordinary user message/command can reach an intent workflow;
only auth/callback/system protocols bypass it. Use the same authorization service as normal reads;
cache by actor/chat/resource/range with TTL and mutation invalidation. Current-turn committed
writes and unresolved questions stay available even when optional context is evicted.

## Evidence boundaries

The catalog prototype is not yet wired into CalendarBotAgent and therefore does not speed up
production. Character/token estimates are not the provider's tokenizer or a restored bill.
A model's advertised tokens per second is not a request latency, and repeated calls on one
scenario are not additional independent task-quality cases.

## Provider and budget policy (updated after the three-tier owner decision)

- Light priority candidate: Groq qwen/qwen3.8-27b, reasoning none; optional Cerebras
  qwen-3.8-27b and Together Bonsai after keys/compatibility validation; fallback Groq OSS20B low.
- Medium: Groq openai/gpt-oss-120b, reasoning low. Same model at Cerebras is a provider fallback,
  not an intelligence escalation. Provider fallbacks must not silently downgrade repair work.
- Smart candidate: Gemini 3.1 Pro high on the existing authorized Google API project, pending
  matched multi-round evaluation and preservation of provider tool signatures. GLM-5.3 (NOT Flash) is last, only on an account/endpoint
  permitted for this application. The existing z.ai endpoint is a Coding Plan endpoint; official
  FAQ limits subscription benefits to supported products. A 200 response is not policy approval.
- Candidate output ceilings: router 1024, medium 4096, smart 8192. These are generation budgets,
  not context windows. Reasoning tokens share the output budget; 128 was an invalid quality test.
- Groq strict response-format JSON cannot be combined with API tools. Planning sees the complete
  discover_tools schema in the prompt and requests schema activation in its JSON plan. Executor
  requests use API tools, with discover_tools always present. No schema is hidden by this adapter.
- Global target budget $10; ceiling $20 across all providers. Provider billing controls are not
  an instantaneous application-wide cap. No new payments or credentials changed in this work.

## Implemented boundary

turn-routing.ts builds actual strict model requests, validates the plan and applies repair escalation.
It is tested in isolation but is NOT yet called by the live message pipeline. Runtime insertion,
scoped repair-state persistence, context prefetch and executor-tier dispatch remain the next slice.
Currency expressions are approved by the owner; the continuation stacked on PR #263 adds dated public
reference rates, exact decimal amounts, cache, no 1:1/hardcoded missing-rate fallback, and no
transmission of user expressions or amounts to the exchange-rate provider.
