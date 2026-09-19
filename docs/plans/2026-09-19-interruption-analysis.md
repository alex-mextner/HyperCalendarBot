# Interrupted work: evidence and recovery — 2026-09-19

## Evidence boundaries
The chat displayed `Thinking failed`; no ChatGPT backend diagnostic or incident identifier is available here. Its internal cause is unknown. CLI timeouts, account limits and workflow bugs below explain observed work stalls, not the platform message itself.

## Confirmed causes in the retained work

| Observation | Evidence | Correction |
| --- | --- | --- |
| Implementation backend had exhausted usage | `/tmp/hcb-ship-orchestration-20260918.log`: explicit usage-limit error with a reset time | Do not retry an unavailable backend in a tight loop; preserve state and use another authorized implementation/review path. |
| Reviewer jobs did not all complete | `/tmp/hcb325-api-review-20260918.md`: two read timeouts, one completed performance review | A partial pool is not approval. Read bounded progress and use a bounded alternative review, retaining all existing findings. |
| Recorded task keys disagreed | PR324 ship logs rejected quorum for `GH-259` while earlier reviews were under `259` | Use the canonical task key consistently before launching expensive review. PR324 subsequently received actual GH-259 reviews and merged normally. |
| Tool/script invocations were retried without a durable stage record | Conversation history contains repeated empty polls and attempts to review an empty committed index | Save exact tree, command, stage and output paths; inspect help once; never treat an empty diff as a completed review. |
| A merge removed the worktree from which ship was running | PR324 ship log explicitly removed `metric-report-259-20260918` and warned that the current directory no longer exists | Resolve canonical Git location before ship; load post-merge code from the merged SHA and continue outside the deleted worktree. |
| Multiple release launchers could queue the same target | Existing parent #276 records the 02bdb6e duplicate-owner race | Nonblocking release ownership; check live receipt/image again after acquiring ownership; same verified target is a no-op. |

No quota or command failure authorizes bypassing review, local tests, deployment verification, or changing billing. Remote Desktop Commander usage warnings explicitly stated that calls were not paused; they are not evidence the tool was blocked.
