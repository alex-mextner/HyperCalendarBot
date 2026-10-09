# Benchmark review disposition

This is a benchmark-only change. No production route, credential or calendar is changed. Independent model review was attempted, not substituted with implementer-authored approval.

Two actual OSS120B reviews returned objections. Reproducible counterchecks establish that an explicitly required missing owner fails, production schema coercion normalizes numeric IDs before evaluation, Cyrillic text plus a URL is not falsely rejected, failed required calls do not pass, and equal absolute timestamps with different offsets are correctly equal. The budget reserve uses the actual4096 limit in the runner and intentionally retains uncertainty when usage is absent. Raw results are immutable; revised grades, raw flags and censored outcomes are separately retained. These objections were not blindly converted into incorrect code or used to discard measurements.

Real weaknesses found during review were addressed:incomplete local mutation classification now delegates to the production classifier;schema-invalid rejected calls are failures rather than executable wrong-recipient writes;post-hoc interpretations for profile refresh and the unimplemented scheduled-reminder alternative are explicit;nullable/partial usage is preserved;generated tokens missing from completion but present in total are included in the cost estimate. These changes are covered by34 offline tests. The old evidence is not relabeled as a new live run.

A third independent review through Together GLM5.3 ended with finish_reason=length:all4096 output tokens were reported as reasoning and no review text was returned. That run is NOT approval. The two earlier reviews and all counterevidence remain in restricted local logs. A completed independent human/agent review before merge is still needed; this PR is draft.

API accounting:benchmark estimateUSD1.4349111;engineering reviewsUSD0.0417893 at their recorded tariffs;combined estimateUSD1.4767004. These are estimates and conservative reservations, not an invoice or proof of account balance. No further paid requests are scheduled or running.

Known limitations:manually reconstructed scenario families;no production handlers/Telegram wrapper;only8 cases for most profiles;4 small holdout scenarios;post-hoc audit;incomplete semantic/text oracle;unimplemented optional handlers;sequential provider sampling;explicit pacing. No model is certified or automatically promoted. Parent issue226's runtime catalog-routing requirements remain open.
