# Claude credential failover implementation plan

**Goal:** use the owner's second Claude API token automatically when the first is exhausted or temporarily unavailable, retaining exact model/request parameters and all existing provider fallbacks.

**Architecture:** a shared in-memory credential pool wraps only SDK stream creation (before any response/tool execution) and live-model discovery. Each distinct token is attempted once per request; retryable auth/billing/quota/transient failures cool down only that token. Retry-After sets the minimum cooldown. A provider's existing total budget is divided among eligible keys for header acquisition; caller cancellation stops immediately. Returned streams retain caller cancellation and cannot be replayed by this helper.

**Scope:** `CLAUDE_API_TOKEN` + `CLAUDE_API_TOKEN2`; no new provider/model defaults, business execution, outbound messages or persisted private payloads.

- [ ] Add meaningful regression tests for primary success, exact result/params, retryable errors, narrow spend-limit 400, fatal requests, duplicate keys, cooldown/Retry-After recovery, transport errors, cancellation, bounded late producer and returned-stream failure.
- [ ] Run red against a non-failover scaffold and preserve result.
- [ ] Implement `src/services/ai/claude-credential-pool.ts` and registered SDK client pool; bind config and smart/fast/role eligibility to either token, fingerprint both for durable circuit invalidation.
- [ ] Integrate only `streaming/slot.ts` stream creation and `model-registry.ts` discovery, preserving one HTTP-attempt callback per actual SDK call.
- [ ] Run focused green, exact-head server full `bun test`, typecheck and lint. Review changes independently and fix findings.
- [ ] Normal PR/gh ship gates; production operations and synthetic before/after evidence coordinated by release owner. No duplicate live calls or deployment from this worker.

Review focus: ordinary 400/404 must not consume backup quota; exhausted pools must not hammer providers; caller abort must not penalize keys; a late first result must be canceled; accepted partial streams/tool side effects must never be replayed by credential rotation.

## Reviewed integration corrections

The independent review and installed code/security reviews requested absolute remaining deadlines through recovery, caller-independent shared catalog probes, per-HTTP usage/timing, local cooldown skips, earliest pool recovery for shared circuits, request-specific moderation handling, and matching circuit inspection fingerprints. Production-path regressions observed 9 failures and 4 passes before this correction wave; both inspection regressions also failed before the script fix.

The mandatory Knip check has identical pre-existing findings on unchanged main `bb7a9d4765e406b3c2c258fc4ad55445643857ac` and the feature: 2 files, 1 dependency, 1 development dependency, 28 exports and 4 configuration hints. Follow-up: https://github.com/alex-mextner/HyperCalendarBot/issues/564. These are deferred from credential reliability; validate the final diff for new unused symbols.
