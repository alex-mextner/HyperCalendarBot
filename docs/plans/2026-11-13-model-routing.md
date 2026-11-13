# Claude Primary and Reserve Routing

Task: UB-178. Base revision: `128846b7e4c31667ee41b2fc1dae274e0bef3fcd`.

## Changes

Claude is first among selected providers in smart, fast and role chains. Other priority providers keep their relative order; Hugging Face stays last, including the combined role and legacy fallback chain. Provider selection, credential availability, preset qualification, circuits, deadlines and output validation stay active.

Remove obsolete provider references from active source, scripts, fixtures and current configuration guidance. Historical usage rows remain readable through the existing generic provider handling; no database content is changed.

Keep Claude Sonnet 5.5 and Haiku 5.5. Update the optional DeepSeek preset to `deepseek/deepseek-v4.1-flash-1017` and the Hugging Face examples to `meta-llama/Llama-4-Scout-17B-16E-Instruct:deepinfra`. A provider-pinned Hugging Face route cannot silently change upstream through model discovery. No preset receives a new qualification.

## Verification

Run focused Bun tests against the source overlay with network disabled. Cover configured priority, actual provider fallback order, failure visibility, role fallback, existing output validation, preset pricing and pinned model behavior. Full suite and whole-repository typecheck are omitted under the owner's requested hatch. Live Claude account checks are recorded separately; synthetic tests do not prove production delivery.

## Production Plan

Publish to a source branch first. After separate rollout approval, deploy the approved revision and set both smart and fast chains to `claude,zai,hf` (include configured OpenRouter before HF when desired). Keep both current Claude credentials and 5.5 model IDs. Update the two HF model values above and remove obsolete bot-local provider environment entries without revoking shared keys. HF billing repair is outside this change and does not block Claude activation. Verify a bounded Claude text/tool request and fallback evidence after activation; retain the preceding image and environment snapshot for rollback.

## Incident Timeline

Claude 5.5 integration was committed on 2026-10-10 (`c7daca394994e40b65165f5842bded3daa5b4f16`), with 5.5-only model discovery and thinking-budget compatibility on 2026-10-11 (`481b6356d8d0bf2f668ce9a168cb5cc091fd1c84`). Both precede the November 8 requests reported by Anthropic. Current source and retained logs do not identify this bot as that caller.
