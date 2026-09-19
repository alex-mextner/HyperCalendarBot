# Provider account handoff — verified 2026-09-19

The owner performs signup/login, email/MFA and card verification in an authorized browser on the Mac. Agent setup follows in that browser; do not request passwords, card details or API keys in chat. No account purchase or billing settings have been changed by this source patch.

## Recommended initial allocation

| Provider | Owner action | Proposed funding and role |
| --- | --- | --- |
| Existing Groq | Open console.groq.com, login, Settings > Billing, add card and select Developer | Pay-as-you-go, no mandatory upfront charge. Proposed organization cap USD8/month with alerts4/6/7.2. Main OSS120 and Light OSS20; Qwen3.8 only evaluated with working alternatives because it is preview. |
| Existing Google | Open aistudio.google.com, login, select existing API project, Set up billing > payment method | Verify existing paid status first. If required, USD5 initial Prepay, proposed project cap USD5/month; no automatic reload. Flash fallback and stronger Gemini candidate testing. |
| New Cerebras | Open cloud.cerebras.ai, register, confirm email, add verified payment method | USD5 trial credits valid30days; no purchase beyond trial now. Compare Qwen3.8/OSS120 on an independent provider. Trial is not recurring free access. |
| New Together | Open api.together.ai, register, add payment method in Billing | USD5 prepaid initial balance, auto-recharge off. Serverless Bonsai27B experiment and normal API GLM5.3 candidate (not Flash), no dedicated endpoints. |

USD8+5+5=18 leaves USD2 nominal room under the owner's20USD ceiling, not a guaranteed all-in hard limit: tax/currency effects, metering delay and other apps sharing billing still matter. No auto-recharge or further trial top-ups without an explicit budget decision. Do not buy additional chat/coding subscriptions, dedicated GPU capacity or HF credit for this step.

## Agent-owned configuration after handoff

Inspect account/project ownership and existing usage first. Create separate scoped keys/projects for calendar, finance and synthetic benchmarks where supported; keys remain in owner-only secret storage and server configuration, never Git, screenshots or printed logs. Set account caps before paid tests. Discover actual model IDs, structured-output/tool-call support, context and rate limits. Validate with synthetic read-only cases before routing private calendar/financial context to any new provider.

Groq preflight previously assumed8000TPM for OSS models. `GROQ_TPM_LIMITS` must reflect the actual organization's Limits page, not a guess based on card presence. Context window, per-minute throughput, output budget and monthly spend are different constraints. Missing overrides retain existing defaults. Main chain order and account-specific budget configuration remain separate changes.

## Official verification sources

- Groq Developer has no initial charge: https://console.groq.com/docs/billing-faqs
- Groq organization spending caps and10–15minute metering lag: https://console.groq.com/docs/spend-limits
- Groq context/Developer limits/model prices and Qwen preview status: https://console.groq.com/docs/models
- Gemini billing, USD5 minimum Prepay and experimental project caps: https://ai.google.dev/gemini-api/docs/billing
- Cerebras verified-card trial, expiry and per-model limits: https://inference-docs.cerebras.ai/support/rate-limits
- Together initial USD5 requirement and auto-recharge behavior: https://docs.together.ai/docs/billing-credits
- Bonsai0/0 and GLM5.3 normal serverless pricing: https://www.together.ai/pricing
- Z.ai Coding Plan is limited to supported products/scenarios: https://docs.z.ai/devpack/faq

## Measurement retention

Keep every measurement under a new UTC run ID, including unsuccessful/slower results. Attach exact source/config/fixture, provider and model, reasoning setting, input/output/unknown usage, true attempts and full request time. Same-provider matched runs, cross-provider probes and natural-traffic percentiles are distinct populations. Preserve the original24 archived files and the9.54s/full and16.45s/lazy controlled records; never replace them with a later faster result.
