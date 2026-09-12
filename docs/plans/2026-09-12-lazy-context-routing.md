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
4. **#257: Always-on light router.** Every request that reaches the AI path first calls the light
   router. Deterministic no-AI workflows still bypass the AI subsystem entirely. The router receives
   only group/tool names with short descriptions plus mandatory safety/request state, and returns a
   strict ContextPlan selecting context, full schemas to reveal, optional read-only prefetch, and
   `next_model: light|smart`. The same light model may continue as executor; a second stronger call
   is only made when the router selects `smart` or the light executor escalates through discovery.
   There is no heuristic router layer in the target architecture.
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
  "next_model": "light"
}
```

Normalize dates using one frozen request timestamp and the user's timezone. A code validator
resolves bounded ranges and resource scope. Prefetch is allowlisted reads only, never arbitrary
SQL, business tools, renders, writes or sends. The light router is called on every AI-path request;
only a deterministic workflow that fully handles the request may bypass it. Use the same authorization service as normal reads;
cache by actor/chat/resource/range with TTL and mutation invalidation. Current-turn committed
writes and unresolved questions stay available even when optional context is evicted.

## Evidence boundaries

The catalog prototype is not yet wired into CalendarBotAgent and therefore does not speed up
production. Character/token estimates are not the provider's tokenizer or a restored bill.
A model's advertised tokens per second is not a request latency, and repeated calls on one
scenario are not additional independent task-quality cases.
