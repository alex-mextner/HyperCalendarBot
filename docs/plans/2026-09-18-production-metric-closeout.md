# Production metrics closeout — 2026-09-18

## Verified starting point
Production receipt and running image both identify 02bdb6e6de3954e9f5f42b9ce409e3655c858793 (started 18:39:24 UTC). This contains #293 telemetry, #322 responsive fast-provider order, recipient fixes and typed intent workflows. The current-container snapshot at 19:32 UTC contains zero agent starts/model metric events. This is zero traffic, not zero latency and not evidence of a passing SLO. Previous containers are outside this retention window.

## Immediate correction (#259)
The actual model-call logger emits null when usage/metadata is unavailable, but the JSONL reader accepted only absent or numeric/string values. Consequently partial real provider rows were counted as malformed. CLI regressions reproduce the loss before the fix. Nullable fields remain null; negative metrics and numeric strings remain invalid. Unknown content and actor IDs never enter the aggregate output.
A winning fallback now retains structured identities of failed providers. Preflight skips are separate from failures after an attempted API request. Winner latency remains winner-only; chain time stays request-scoped. Missing failed-request token usage is still unknown, not reconstructed.

## Delivery order
1. Review/fix/merge this ingestion correction using ordinary gh ship/local CI.
2. Finish post-merge gh-ship deployment orchestration on the current tested prebuilt-image scripts, preserving nonblocking release ownership and exact SHA/digest receipts. Do not restore obsolete September 15 deployment code.
3. Deploy combined main, collect a timestamped real-traffic sample and inspect censoring before claiming acceleration. Synthetic provider probes remain labelled separately.
4. Resume current-main Light/Medium/Smart wiring only after metrics and release ownership are trustworthy; retain every short tool entry, strict schemas and no heuristic routing. Preserve the already shipped fast-chain and typed-intent work.

Open separately: #245 group privacy, #274 durable operation identity, ExpenseSyncBot #116/#117/#120. Closed-PR cleanup requires unique-change preservation and no active workspace deletion.
