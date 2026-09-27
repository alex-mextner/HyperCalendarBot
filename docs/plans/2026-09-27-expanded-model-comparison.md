# Expanded comparison and role separation

Purpose: choose a usable fast executor and an escalation model, not declare a winner from eight questions. Continue PR429 without changing production or other worktrees.

Run current explicit large-model profiles: GLM5.3Flash/GLM5.3 low,DeepSeekV4.1Flash/V4Pro,Qwen3.8-2.4T-A95B,Qwen3.8Flash,MiniMaxM3,KimiK3,Gemini3.8Flash/3.1Pro,plus paired Gemini2.5 none/default controls. Match32cases for inexpensive finalists and16fixed cases for high-cost candidates. Preserve old data. Record exact profile,mode,failures,usage and sample size; successful-HTTP timings are not Telegram latency.

Use the existing64-tool benchmark and real schema validators; preserve provider-owned reasoning/signature metadata in memory across tool rounds. Full and actual lazy mode share the same full name/title index; no gold tool subset. Frozen existing fixture expectations and known simulator limitations remain visible. Broad-model source code is still the pinned PR429 base, not current production.

Separate Light-role benchmark:no write tools,independent families for catalog selection,typed literal extraction,ambiguous-reference escalation and execution-outcome interpretation. Use synthetic data, deterministic labels, paraphrases and repeated calls. Do not claim stability on arbitrary inputs or use self-reported confidence as authorization.

Cost control:the orchestrated large-model campaign stops at USD5 estimated/reserved usage; individual runners remain limited to at mostUSD1.50. Failed calls retain unreturned reservations. Light-role experiment uses a separate maximumUSD0.30. No purchase,subscription or auto-recharge change. Production model configuration remains unchanged pending actual role qualification and reviewed integration.

Deliver a ranked decision,role-specific counterexamples,comparable timing/cost,raw immutable results and exact implementation/deployment boundaries. No loops of repeated paid reviewers merely to obtain approval.

Additional paired-control allocation, recorded before execution:maximumUSD0.65 for current-runner Groq120low and Gemini2.5Flash none/low on the same16cases. This is separate from theUSD5 large-model andUSD0.30 Light-role caps; combined maximum reservationUSD5.95. It tests whether earlier rankings depended on harness/effort/pacing. No account billing setting is changed. Keep actual failures/censoring and recompute repriced Gemini3.8/.35Lite estimates from raw usage; initial manifests used conservative draft prices, not verified account charges.

Catalog A/B follow-through:run the actual lazy discovery mode on the common16cases for DeepSeekV4.1Flash and GLM5.3Flash, with combined reservation capUSD0.60. Preserve full names/titles and real schema discovery; do not give an oracle-specific tool subset. This is another bounded measurement, not automatic proof that lazy mode is better. All runs are foreground-owned and collected before delivery; no perpetual monitor or paid loop is created.

Final predeclared completion slice:USD1.15 maximum combined reservation for GLM5.3-low on the common16cases (USD0.90 allocation) and Qwen3.8Flash streaming compatibility follow-through (USD0.25 allocation). The first campaign reached its USD5 reservation bound before testing GLM adequately; do not call its two completed cases a comparable score. Qwen's nonstream400s are transport incompatibility, not inference quality. All initial failed rows remain retained. No additional paid engineering review loops are included.
