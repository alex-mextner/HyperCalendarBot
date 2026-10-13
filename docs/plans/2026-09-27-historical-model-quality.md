# Historical model quality benchmark — implementation and run plan

Task: GH-226. Base: de31c71a053098a1e2b8cf41d330cdbf61837ef4.
Goal: reject unsafe calendar executors using reproducible, history-derived cases, not tiny OK probes.

## Frozen design
Use the real production system prompt (only the clock is normalized), full tool definitions and real schema validators. Run each model independently without fallback. Business tools are simulated against explicit synthetic state; the real calculator handles arithmetic/timezones. No production DB, Telegram sender or real invitation is accessible to the runner. This is model/tool-contract evaluation, not Telegram end-to-end QA.

The retained private corpus has402 distinct historical utterances from26 snapshots plus March/April data. It contains auth/PII and is NEVER passed to providers. Manually transformed fixtures preserve representative semantics; names, event contents, addresses, IDs and dates are synthetic. Historical context missing from the archive is explicitly reconstructed, not claimed as the original state. Record selected provenance separately; no old model answer serves as gold.

## Steps and files
- [ ] Test the evaluator first: scripts/model-quality/core.ts and test/scripts/model-quality/core.test.ts. Wrong dates/IDs, extra writes, duplicate writes, unsupported tools and false success must fail. Equivalent UTC instants must pass. Errors/timeouts remain in the denominator; missing usage stays null.
- [ ] Freeze stratified cases in scripts/model-quality/fixtures.ts before API calls: reading, date/time creation, correction, reminders, settings, group scope, missing references, confirmation, ambiguous recipients and partial outcomes. Mark source-derived vs additional adversarial variants.
- [ ] Implement scripts/model-quality/run.ts with max6 rounds, per-request deadline30s, real schema validation, immutable raw result rows and source/fixture hashes. Cap aggregate estimated spend before each HTTP request; unknown usage remains an explicit uncertainty. Auth/quota outages stop repeatedly probing that provider, not count as a model reasoning failure.
- [ ] Run supported current account/model candidates on the same cases. Core screen then repeat selected finalists on the frozen holdout. Report exact sample count and all errors, latency and reported tokens; a finite suite cannot guarantee unseen-request correctness.
- [ ] Isolate Gemini configuration/transport effects with paired synthetic tests: output/thinking budget, native vs compatibility and full tool transcript. No provider switching around safety refusals.
- [ ] Review actual failures and evaluator assumptions; append adjudication rather than overwrite raw scores. No production promotion for a model with verified critical errors. Publish a reproducible report and admission recommendation; runtime policy changes require their own tests/review/normal ship.

## Admission policy fixed before results
Zero verified wrong writes, wrong recipients/scope, duplicate mutation or false-success on completed-tool evidence. At least95% complete task correctness for a provisional executor recommendation; all challenge failures reviewed individually. Read-only/planner eligibility is a separate decision, not an excuse to expose unsafe writes. Availability failure is not evidence of bad reasoning. Experimental preview IDs are not silently promoted as stable services.

## Boundaries and budget
Initial live run reservation cap USD1.50 total using conservative per-token envelopes, not a claim of the actual invoice. No purchases or billing changes. Credentials are read only from existing environment and never logged. Raw model answers contain synthetic fixtures only; no reasoning text is retained. Existing benchmarks stay append-only. Current hosted deployment has another owner and is not restarted for these tests.

## Execution checkpoint — 2026-09-27
Completed:32 reconstructed fixtures;108 scenario invocations;264 benchmark API requests;9 tested model/provider/effort profiles;full32-case Groq120low run;repeated Qwen recipient failure;paired Gemini output-budget and64-vs5-tool diagnostics. Raw results remain private and immutable; public report and case verdicts are checked in under docs/reference/model-quality.

Corrections are explicit:unverified drafting provenance labels removed;self owner123 false-positive censored, not counted as a success;schema-invalid Gemini recipient call is a contract failure, not a fabricated numeric ID;native empty parts are optional;numeric IDs use actual schema normalization;profile refresh is not invitation replay;scheduled reminder alternative is inconclusive because the original sandbox did not implement it. Output-language/control-token audits are post-hoc, not preregistered. Production is unchanged and no new executor profile is qualified. HF/z.ai,real Light-role tests and actual production wrappers are still untested by this slice.

Budget accounting correction adds USD0.002 for generated tokens visible only in Gemini total usage. Benchmark estimate USD1.4349111,not a provider invoice. Independent engineering review is separately metered. Remaining parent-issue acceptance (minimal catalog routing before/after accuracy and request-fit production integration) is not closed by this benchmark PR.
