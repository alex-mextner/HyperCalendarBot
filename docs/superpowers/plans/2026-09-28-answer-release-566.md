# Evidence-gated reply and cosmetic correction Implementation Plan

Task GH-566. Parent spec: PR568 `docs/specs/2026-09-28-ai-quality-context-policy.md`, approved by Alex on2026-09-28 with the amendments below. Baseline48966c71. This implements a bounded reusable slice,not the whole corpus/model-routing architecture.

**Goal:** a reply may be shown before cosmetic polishing ONLY if task,facts,scope and action safety are already verified. Changes after delivery target the same message,are rechecked against the same turn/evidence,and cannot execute business tools. Actual runtime activation requires calibrated trusted assessments; do not treat this component as a hallucination oracle.
**Architecture:** pure positive quality/admission contracts + an asynchronous single-shot send/edit coordinator on the existing TelegramSender capabilities. A bounded,tool-free polishing callback receives a snapshot and returns text only. A separate trusted assessor binds every verdict to text hash,actor/chat,turn version and evidence version. All external model output is untrusted,including suggestions labelled cosmetic. Initial and corrected content both pass the same gate. The transport contract is plain text initially;no format change can sneak a new link/keyboard or different recipient. No existing /add/Laya/parser/corpus code is changed.
**Tech stack:** existing TypeScript,Bun tests,Zod validation,provider-deadline.waitForAbort,TelegramSender's existing sendMessage/editMessageText.

## Approved amendments
- Ordinary complete requests take intents/heuristics;LLM qualification uses the complex residual or its explicitly simple role,not all traffic mixed together. Presets require observed>=95% on a held-out role set AND100% end-to-end on all inventoried/labelled historical episodes with coverage. Report n and uncertainty;these thresholds are not statistical guarantees.
- Positive axes:taskFulfilled,factsSupported,scopeRespected,noUnsafeActions,noCosmeticDefects. Exact/equivalent paths are annotations,not inverted booleans.
- Cosmetic tolerance never includes times,dates,identity,consent,scope,delivery state,negation,secret disclosure,missing steps or unsupported factual claims.
- Artificial odd-title/quoted-complaint examples remain separate robustness cases,not representative route-accuracy evidence. User's genuine complaint remains a repair class.
- Handoff posted to #565/#566 and PR562. The other agent owns offline history inventory and candidate labels. Do not duplicate those artifacts;use their future corpus IDs. Shared coordinator note:logs/coordination/2026-09-28-quality-566-to-add.md.

## Task1 — quality policy and qualification
Create src/services/ai/quality/answer-quality.ts and model-qualification.ts;test under test/services/ai/quality.
- [x] Red tests for unknown/failed facts,cosmetic-only admission,contradictory verdict,unknown rule codes,exact subject binding and absent evidence.
- [x] Implement strict typed positive verdicts;only fixed allowed presentation rule IDs qualify for post-send correction. No raw model severity permits bypass.
- [x] Red tests for95% boundary,wrong population,easy-case inflation,missing/duplicate/incomplete samples,small samples and incomplete historical coverage. Qualification evaluates counts,never sends requests/changes a model route.
- [x] Green targeted tests;preserve denominator and explicit blocked/failed/unknown outcomes. Min100unique held-out role cases is an initial conservative policy choice,not a claim of95%confidence.

## Task2 — bounded send then edit
Create src/services/ai/quality/verified-reply.ts;test with actual createTelegramSender and fake Bot API plus deferred callbacks.
- [x] Verify no send before trusted approval;send once before starting cosmetic work;edit exactly that message once after a new trusted check.
- [x] Verify mismatched text hash/evidence/turn/scope,disallowed factual edits,producer-forged assessments,unknown checks,new turns and evidence invalidation cannot edit.
- [x] Abort/timeout before dispatch starts no side effects. Unknown send/edit outcome is reported as unknown and never retried;late completed UI requests are not treated as failed business writes. A hung producer is stopped waiting for without later edit.
- [x] Error handling keeps an already-delivered verified response;no second send,tool execution or unsafe fallback. Output includes observed final text/correction outcome and unproven delivery state separately. Caller must persist receipts and reconcile unknown states;not cross-crash exactly-once.
- [x] Deep snapshot/freeze inputs,one shared bounded deadline,serial admission checks,callbacks invoked only through allowlisted interfaces. No hidden default LLM or auth/billing change.

## Task3 — integration contract,review and gates
- [x] Publish adapter/use example for the dialogue owner;clarify that the current streaming agent must NOT treat its old tool-name-only validator as a trusted assessor. No global enablement in this slice.
- [x] Update #219/#257/#565/#566 and existing spec withpositive labels,conditional model role admission and cosmetic-only permission. Preserve earlier evidence.
- [ ] Publish final commit/PR after staged secret-scan and exact-commit type-ban;runtime activation and full historical qualification remain separate integration gates. Full6027-test gate,typecheck,lint and two independent source-review iterations already passed;completed publication recorded below.

## Review focus
Stale message edit after another turn;ambiguous API success and retries;classifier calling a semantic change cosmetic;unknown quality counted as pass;always-abstain system inflating a score. All are explicit tests or declared integration gaps.

## Verified implementation boundary — 2026-09-28
Implemented the three reusable components and72 focused tests. Full native run:6027pass,0fail,380files;TypeScript and repository lint exit0. Existing knip findings are identical to baseline48966c71,not green. Two actual independent GLM5.3Flash source reviews returnedPASS;the follow-up verified the red-first caller-cancellation telemetry correction. These are source reviews,not a fabricated review-cli multi-reviewer quorum or a proof of production model quality.

No existing agent,/add,corpus,provider configuration or live Telegram session is switched to this component. The integration guide explicitly requires real trusted evidence assessment,current turn/evidence ownership and persistent receipt reconciliation. Unknown outcome remains unknown. Model qualification functions validate audited records;they do not generate a95% or100% result by passing unit tests. The /add/model-log owner has received two coordination comments and the canonical handoff;reading/acceptance by that agent is not claimed.
