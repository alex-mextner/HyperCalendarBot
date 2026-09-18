# Short-call provider order — September 18, 2026

A synthetic no-tool request executed inside the deployed container returned the expected marker only after 15,757 ms: z.ai timed out, Hugging Face returned depleted-credit HTTP 402, then Gemini succeeded (593 ms provider time). This was a separate process, not an incoming Telegram acceptance test and not a production p95.

Two candidate orders were then tried independently against the same deployed provider code and existing credentials. Gemini first completed in 531 ms, one attempt/no fallback. Groq first (`openai/gpt-oss-20b`) completed in 641 ms, one attempt/no fallback. These are individual live samples, not comparative benchmarks or an uptime guarantee.

The fast default now uses `groq,gemini,hf,zai`, consistent with short-call OSS20B routing and keeping the measured slow provider last. The smart chain is deliberately unchanged; the three-tier routing work remains separate. An explicit `AI_FAST_CHAIN` override still takes precedence. No provider, credential or billing account is added, removed or modified.

Existing empty-response rejection, quota eligibility, request-size preflight and fallback remain active. This matters because past Groq empty responses were the reason for its old position: promotion does not turn an empty HTTP 200 into success. Missing optional Groq configuration falls back to Gemini before z.ai, with a native regression test.

`bun scripts/probe-ai-chain.ts` repeats a fixed synthetic fast-chain check; `--smart` chooses the smart chain. It invokes no calendar tools and sends no Telegram messages. It emits only status, model/usage/timing metadata, not arbitrary provider response text or error bodies. It has a 30-second request signal and fails on a wrong marker, unsolicited tool calls or provider failure. This probe cannot mark the main service process as AI-verified and does not replace authenticated chat QA.

Evidence: `logs/closeout-20260918/live-ai-fast-chain-proof.json`, `live-ai-order-candidate.jsonl` and `live-ai-groq-first-candidate.jsonl` in the authorized workspace. Three native config/fallback tests failed before changing the default, then passed. Do not disable input-size protection or alter the smart chain to imitate this result.

A further negative test exposed that whitespace-only HTTP 200 text was treated as usable. The shared provider guard now tests trimmed emptiness (without trimming valid returned content) and falls back; responses containing real tool calls remain allowed. The exact Groq OSS20B-to-Gemini-fast fallback is tested for both empty and whitespace-only text.
