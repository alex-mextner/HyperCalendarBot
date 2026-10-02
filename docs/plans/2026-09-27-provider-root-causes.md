# Calendar inference reliability — 27 September 2026

Owner: finish the existing reliability, provider and routing work; investigate Gemini with production-shaped requests, not merely tiny successful probes. Keep paid Groq primary, allow existing free Gemini, preserve tool outcomes and all prior measurements; no new payment, quota bypass or private-payload provider experiments.

## Recovered baseline
Main/runtime 6426a50f (PR380), exact image c368ab98…; no fresh agent request in the retained process log since restart. The existing local edit to .serena/project.yml remains outside this worktree. Persistent chat logs survived: a 25 September dialog took twelve model rounds, including rejected standalone ISO timestamps that the model worked around with +0hours. Those logs do not identify the inference provider and are not evidence that Gemini caused those business-tool errors.

## Proven Gemini causes and boundaries
Synthetic experiment uses the actual full tool catalogue, a harmless Russian agenda request, no tool execution, max_tokens4096, temperature0, Gemini2.5Flash. Three paired repeats: default thinking produced HTTP200/stop with zero output every time; thinking:none produced the correct get_events call every time. Single-tool default works. Native GenerateContent and OpenAI-compatible streaming AND nonstreaming reproduce the empty full-catalog default response, while native thinkingBudget0 works. Thus this is not only SSE parsing, not an exhausted output cap and not general endpoint failure. The exact backend internal reason is not exposed; scope the mitigation to the supported2.5Flash tool path instead of asserting all historical empties had this cause.

A second independent root cause: Google compatibility errors can be [{error:{code,message,status}}]. The installed OpenAI SDK only reads response.error and turns the nonempty array into '400 status code (no body)'. Existing retry logic then mistakes deterministic invalid requests for transient bodiless failures. Preserve the real validated envelope before SDK classification, including quota/reset details and headers. Do not change other providers' error semantics or replay completed writes.

First experiment harness used x-goog-api-key on the compatibility endpoint and proto parameters for JSON-schema type arrays; these were harness errors, not production findings. Original failed controls and correction remain append-only in canonical logs/gemini-rootcause-20260927T0949Z. Corrected matrix uses production Bearer auth and native parametersJsonSchema.

## Ordered implementation
- [ ] Red-first tests for full-catalog main2.5Flash thinking policy, structured array errors, genuine empty bodies, quota headers and unchanged non-Gemini paths.
- [ ] Correct the Gemini client boundary and supported tool-calling policy; repeat real full-catalog two-turn probes on exact candidate code. Never turn off reasoning on Pro/3.x.
- [ ] Preserve opaque thought signatures through stream and stored tool calls; validate transcript blocks without invented names/IDs or lost completed observations, reusing the unfinished #258 source where sound.
- [ ] Close the observed standalone timestamp/calculator contract with strict actual-date/offset validation and dispatcher tests, not a '+0hours' prompt workaround.
- [ ] Integrate independently implemented optional Cerebras/Together adapters (#379), with provider-local immutable transcript normalization and no-key behavior, test before canary.
- [ ] Inspect and finish existing Light/Medium/Smart ingress (#257), retaining authorization/scene boundaries, all-name tool index and verified action ledger; no keyword heuristics.
- [ ] Exact-head full tests/typecheck/lint/type-ban/secret scan, genuine independent review, atomic commits, normal gh ship, exact image/receipt, safe read-only live checks. Retain honest remaining limits if any external authorization is unavailable.

## Sources
Official Gemini OpenAI compatibility: https://ai.google.dev/gemini-api/docs/openai
Official native FunctionDeclaration: https://googleapis.github.io/js-genai/release_docs/interfaces/types.FunctionDeclaration.html
Official thought signatures (2.5 optional,3.x mandatory for function calls): https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures
Official project quotas: https://ai.google.dev/gemini-api/docs/rate-limits
Local raw matrix/repeat manifests and pre-change logs: canonical logs/gemini-rootcause-20260927T0949Z/; no private raw content is committed.

## Evidence-led implementation results
- Gemini production-shape mitigation: supported2.5Flash/FlashLite requests with tools set reasoning_effort:none, including main requests; plain main reasoning and Pro/3.x are not changed. Three candidate two-round real-inference runs returned a validget_events call and text without any fallback. Merely returning text was NOT accepted as semantic proof: two exact-title checks failed in the handcrafted-result probe, so the full agent/real-tool test below was added.
- Google singleton array errors are normalized in the Gemini SDK subclass before APIError creation. True empty bodies stay separate. Actual SDK tests reproduce lost400/429details before the fix; the chain test verifies a structured400 is not retried as a bodyless transient.
- Original opaque Google tool signatures survive stream terminal frames, assistant message construction and stored history; other providers receive a cloned transcript without Google metadata. No reasoning text is extracted.
- History pairing preserves original complete valid signed batches, rejects invalidnames/duplicateIDs, deduplicates identical results and turns incomplete/conflicting/orphan observations into explicitly uncertain non-executable historical data. Completed result evidence is not silently erased; no inventedtool binding or replay.
- Standalone explicit-offset ISO datetime normalization is added with real-date validation. The actual25September expression no longer needs a fake+0hours roundtrip.
- Actual CalendarBotAgent with memory-only syntheticDB, actualread/calculator tools and realGemini exposed a separate validator defect. It received onlytoolnames, notreadresults or prior evidence, so it rejected an already-known description, re-read the calendar, rejected again, and returnedunverified after7modelcalls/5.50s. Validators now receive boundedcurrent outcomes and pairedprior schedule-read evidence with explicitprovenance,success/truncation labels and an instruction that prior data is not proof ofcurrentcompleteness ornewmutations. A repeated actual-agent probe delivered the correctdescription in1.62s,2modelcalls,0businesscalls. This is not Telegramingress oraproductionpercentile. Originalbadprobe remains.
- Evidence serialization bounds the escapedJSON size and cannot close the tool_evidence delimiter. Validator verdictlogs no longerrepeat model-generatedprivate quotations.

## Known external boundaries
The existing gcloud account name is visible, but minting its access token failed; noGoogleprojectlookup,billingmetadata oractualquota was read. The local application quota mechanism is not evidence of providerentitlement and is not configured from guessedstaticfree limits. Privatehistoricaldialogues were never sent to a new provider; allinferenceexperiments use syntheticdata.

Two initial delegatedCLI sessions were wronglyprovisioned without nativeAgent capability and hit Rig's orchestrator gate. They produced onlysmallpartialtest/configchanges, notfeatures. That provisioningwas corrected by making nativeAgent available and requiring properworker delegation, without disablinghooks orgranting hatchoverrides. Theirlogs andpartialworkremain; do notcount thosefailedinvocations as implementation.
