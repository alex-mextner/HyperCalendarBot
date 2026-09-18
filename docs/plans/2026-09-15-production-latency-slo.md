# Production latency SLO and measurement plan — 2026-09-15

## Baseline
The retained September sample is descriptive, not an SLO: 21 successfully matched agent runs had median 10.1s, mean 16.5s, descriptive p95 37.2s and max 55.1s. The source is the private retained incident snapshot `logs/incident-audit-20260912/docker-raw.log`; matching used `Agent run started`/`Agent run complete` timestamps and excluded runs carrying `Agent error`. The raw log is intentionally not committed because it contains operational/user context. The sample mixes request classes and excludes final Telegram delivery, so it is only the starting signal.

## Target
Measure from message handling entering the conversational AI path through final Telegram delivery.

- deterministic/template path: p50 < 0.5s, p95 < 1.0s
- Light path: p50 < 1.5s, p95 < 3.0s
- Medium path: p50 < 3.0s, p95 < 6.0s
- Smart repair path: p50 < 8.0s, p95 < 15.0s
- all conversational requests: median < 3.0s, p95 < 10.0s
- correctness gate: zero known wrong writes or unsupported completion claims in the accepted sample

These are production acceptance targets, not claims about current performance.

## Per-request evidence
Every AI request must have an opaque request id and record only structured metrics: routing tier, provider/model, model-call count and real HTTP attempts/fallbacks, first visible non-silent text/tool delta, total model-chain duration, tool duration, delivery/finalize duration, end-to-end duration, delivery outcome and termination class. First-visible time means the first UI-visible substantive delta; it may precede a later provider switch and is not labelled as final-answer TTFT.
Token telemetry records input, output, provider-reported total, reasoning and cached tokens when a provider returns them. A missing usage block and partially missing usage details are counted separately instead of silently reconstructed as zero. Costs are calculated later from provider/model/token metrics so price changes do not corrupt historical raw measurements.

Do not publish user text, tool arguments, contact/calendar contents, Telegram IDs or secrets in latency reports. Request ids are correlation-only and must not encode identity. Raw operational Pino logs still contain pre-existing actor/chat IDs for incident debugging; `scripts/report-ai-latency.ts` emits only the allowlisted aggregate fields and strips those IDs from reports.

## Rollout measurement
1. Deploy telemetry alone before changing model routing, establishing a comparable production baseline.
2. Stratify by deterministic/Light/Medium/Smart, operation class, provider/model, cold/warm request, fallback count and payload size bucket.
3. Report sample size, failures and censoring with median/p90/p95. Do not calculate a tail percentile from a tiny mixed sample as if it were stable.
4. Roll the router to a bounded canary, compare against the telemetry baseline, then expand only if both latency and correctness gates pass.
5. Count classifier/discovery/validator calls and rate-limit waits; an extra hidden model call is still latency and cost.

## Current implementation boundary
The first telemetry slice captures terminal streaming usage before usage-only chunks are discarded, provider/model timing and actual HTTP attempt/fallback counts, history-summarizer/validator/retry model calls, retry tools, first visible output, tool time, delivery action time and full end-to-end completion/discard time. Providers that explicitly reject `stream_options.include_usage` are retried on the same provider without usage telemetry and are counted as another HTTP attempt rather than silently falling through. The Light/Medium/Smart router remains a separate integration until its current-main branch passes full tests and review.
