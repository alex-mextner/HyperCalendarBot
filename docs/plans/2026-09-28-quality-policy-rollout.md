# Quality-policy integration workplan

Parent #219. Normative proposed design: ../specs/2026-09-28-ai-quality-context-policy.md.
Status: source audit and local diagnostics completed; runtime implementation is not completed. No production writes, model promotion or billing changes in this worktree.

## Done in this source slice

- Reconciled current main7399876e, benchmark PR429/ec1044a8, old routing PR267 and dirty routing/contextual-intent worktrees without changing them.
- Found real installed task-cli Laya with fixed English checkpoint; AISIS has separate multilingual routing/effort spec; main HCB still uses a different NLI filter.
- Ran48 initial local classifier questions and72 narrow decisions in36 calls on synthetic Russian cases. Question definitions, all predictions, source hashes and environment are retained. These are diagnostics,not calibrated success gates.
- Measured current synthetic prompt/schema cost and inventoried retained production history read-only. Credentials and real messages were not sent to an external model.
- Defined shared presets,context/verification contracts,score dimensions,corpus architecture and bounded repair; created #565/#566 and linked existing work.

## Execution order and ownership

| Workstream | Owner task | Deliverable / gate | Dependency |
|---|---|---|---|
| Secret-safe ingress/history | #519 | auth scene excluded before history/LLM/debug; controlled historical remediation | No raw external replay before this |
| Full model-log corpus | #565 | source manifests,causal episodes,independent gold,nested full/medium/short packs,coverage report | privacy barrier; #554/#559 state |
| Presets + Laya qualification | #257 | versioned supported model/effort profiles,calibrated narrow question packs,fail-safe abstention,held-out confusion/false-accept report | real labelled episodes; reuse PR267/429 |
| Adaptive context engine | #226 | reasoned field/block manifest,immutable core,source freshness,batched preloads and full discoverable index | #160/#474/#390 and profile contract |
| Evidence/policy/repair | #566 | phase/rule registry,hard checks,focused semantic questions,non-replay repair trace | #492/#498/#515/#274; corpus |
| Dialogue/intent compatibility | #554 / #559 / #334 | same context/state/confirmation evidence for /add,intents and AI; no duplicate parser | shared policy contract |
| Provider/plan eligibility | #379 | separate API/Coding Plan entitlement,usage,circuit,role-qualified fallback; no hidden OSS reentry | preset manifest |
| Release proof | #219 | first-pass/post-repair exact+equivalent metrics,all-history coverage,zero unsafe delivered outcomes,latency totals;shadow then canary | all above,real ingress replay |

## Next executable slice

Before new broad paid benchmarking, turn known incidents into replayable episodes with genuine handler responses and final-state assertions. Start with day-range coverage,confirmed event shift preserving duration,verified invitee,queued delivery,callback confirmation and missing context. Fix the evaluator's alternative-action and response-format rules before selecting a winning preset. Label the remaining history,not only the easy cases.

Then integrate the recovered router incrementally behind a feature flag: local classification/heuristics in shadow, deterministic mandatory checks enforced, context-manifest logging without private content. A classifier cannot lower authorization or repair floors. A separate read-only explanation-repair path has no write tools. Keep one deadline and bounded repair count.

Presets to retire from the recommended target paths: GPT-OSS executor/verifier/repair and small Qwen executor. Keep their archived benchmark definitions for comparison. Do not delete a working production fallback until a tested eligible replacement exists. A new profile must not be promoted solely because a small synthetic score is high.

## Review and verification boundary

This worktree changes specifications and diagnostic evidence only. Documents and JSON fixtures are validated for references,source hashes,counts and secret patterns. No full runtime quality claim comes from those checks. Written-spec review precedes a production architecture change. Existing parallel source PRs retain their own tests/review/release gates.

Full target success is assessed on independently adjudicated historical episodes with coverage accounting. A known-failed run,unreconstructable episode,missing provider response or expired deadline is not rewritten as a pass. Repeated calibrations and model fine-tuning must not leak the final holdout.

## Review attempt
One bounded `review just-ask --task GH-257 --pool1 -m oc:zai/glm-5.3 --effort low` invoked the supported read-only coding reviewer. It returned no verdict before its30-second idle deadline. The failed attempt is preserved in canonical evidence; no external approval or ship quorum is claimed. Local document/evidence checks passed; the architecture PR remains a draft for review. The spec was subsequently clarified so required-confirmation rules apply only to relevant operations and incomplete corpus coverage cannot be advertised as100% whole-history success.
