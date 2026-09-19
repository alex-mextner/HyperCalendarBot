# Provider availability: one incident, silent fallback, verified recovery

All configured AI providers use the same account-scoped circuit, keyed by provider, endpoint and a credential fingerprint. There is no Hugging Face-only exception and no assumed monthly reset. Credentials and raw provider response bodies are not stored in the state file or included in the new administrator notice.

HTTP401/402/403 and rate-limit429 open an incident immediately, except clearly request-specific content-policy/oversized-context rejections. Repeated connection/5xx failures open after three consecutive failures. Malformed400 requests, model-not-found discovery, oversized payloads and caller cancellation do not mark an otherwise healthy account exhausted. A real success clears its incident across fast and smart chains.

An open circuit is skipped, including when every candidate is open. The old “try every benched provider anyway” fallback cannot resurrect it. Explicit Retry-After or an unambiguous provider reset timestamp sets the next check; otherwise bounded exponential backoff schedules a probe. Reaching that time does not close the circuit. A leased half-open attempt must actually succeed. A failed probe increases the delay without creating another administrator incident.

Partial model text is discarded before a fallback response starts. Provider retries operate inside one model round and do not execute calendar tools; completed or uncertain tool writes must not be replayed merely to improve an explanation. Existing skipped/attempt/token telemetry remains visible without logging the request contents.

State persists at `<DATABASE_PATH>.provider-state.sqlite` with owner-only permissions. Healthy checks are read-only. Circuit and notification leases are independently scoped. A missing notification transport leaves the notice pending. Telegram failure retries with a delay; a crashed sender lease expires. Notification acknowledgement is conditional on its owner token, so an old response cannot acknowledge a new incident. A crash after Telegram accepted a message but before local acknowledgement can still duplicate delivery: this is one logical incident notification, not a distributed exactly-once guarantee.

`bun scripts/provider-circuit-state.ts` prints sanitized state, without calling providers or forcibly clearing flags. `bun scripts/probe-ai-chain.ts` uses the same persisted circuit with no administrator sender configured; it cannot consume a notice it cannot deliver. Only an actual provider answer closes a flag. A diagnostic request can change circuit state by observing real success/failure, but sends no calendar or Telegram action.

A damaged sidecar is logged and degrades to process-local state rather than taking the entire AI service down. Availability and notification-delivery failures remain observable; ordinary users are not repeatedly told that one fallback provider lacks credits when another provider can answer.
