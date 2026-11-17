# Resolve explicit usernames with the connected account

Task: [UB-212](https://tasks.glide.vc/tasks/UB-212/restore-hypercalendar-username-invitations-and-telegram-reconnection).

Production baseline: `90ee425826f9bd0e194e4f43e0962d6be997d6ee`.

## Evidence and scope

On 2026-11-16, the service lookup account was disabled (`service_user_id_unset`) while the requesting user's own Telegram session remained active. A recipient who had not started the bot could not be resolved by username. After the picker supplied their identity, the own-account send succeeded, but the notification audit referenced a missing bot-user row and incorrectly caused a delivery fallback. The invitation was subsequently accepted. No invitation replay or calendar data repair is required.

Related history: GH-82 (username resolution and contact auto-add), GH-233 (credential-bound session expiry), GH-991 (post-send audit failure), GH-992 (picker evidence missing from the response validator).

The sender audit correction is integrated from the original repair's commit `4d9d6eaea12e4cb3868a80b0fc663afdde6860f9` (PR #994), preserving its ownership. The original GH-992 patch is integrated from an isolated read-only snapshot; its generic bot-authored provenance is replaced with typed picker transport receipts so a forged message or stored event title cannot create delivery evidence.

## Picker continuation boundary

The picker saves verified Telegram profile contacts before the agent continuation and preserves existing preferred names. The pending picker data contains no trusted requested-alias value. Its continuation is therefore read-only from the first tool round, including provider fallback and all automatic rewrites. It must not infer or save an alias from chat history or claim that a requested alias change was applied. A subsequent explicit user command can update a contact's preferred name through the normal handler. This deliberately removes the earlier model-driven alias exception while retaining contact auto-add.

## Plan

- [x] Preserve successful delivery separately from notification bookkeeping through the existing GH-991 repair, including cleanup failures after a confirmed send.
- [x] Preserve complete picker evidence and pass only actual transport receipts as delivery facts; ordinary messages and other bot continuations carry no such proof.
- [x] Use one run clock for the agent prompt, relative-day parsing, validation prefilters, supplement grounding, main/retry weekday guards, clarification questions and tool-detail filtering, including initialization across midnight. Elapsed-time budgets remain live.
- [x] Add a regression reproducing service lookup disabled with an active own session and an unknown bot recipient.
- [x] Resolve only an explicitly requested username through the requester's own encrypted session; validate session ownership and positive recipient identity. Potentially cached service results preserve completed or pending direct-ID inspection evidence, including a valid inspection whose profile hint was evicted; a fresh personal lookup can supersede older evidence, and retained deleted-account evidence blocks both username and numeric invitation inputs. Both input forms use the selected profile's metadata, preserving an absent username instead of restoring a stale service hint.
- [x] Serialize personal-session lookup, send, keepalive, timezone and logout operations, preserving credential-bound expiry/logout so a late response cannot invalidate a replacement login. Propagate cancellation into active read-only lookup and await its child exit and pipes before releasing the owner queue; acknowledged sends keep their existing semantics. Capture the credential selected by a disconnect tap and acknowledge the callback before waiting in the queue; an acknowledgement failure does not cancel the requested logout. Render the result without a second acknowledgement.
- [x] Recheck request cancellation after progress-message flush and before each tool dispatch. Once an invitation row exists, retain confirmed creation and any acknowledged delivery before ending the round; stop optional contact/UI work. Persist real completed results together with history-only not-applied results for the proven unstarted suffix, so later conversation history retains the evidence.
- [x] Offer a working reconnect button only for missing or confirmed unusable authentication; report transient errors as temporary lookup failures.
- [x] Prove in production-handler regressions that invitation contact auto-add works after owner-session resolution and that reconnect does not replay an accepted invitation.
- [ ] Obtain native independent correctness, consistency and quality reviews, run the full gates in RunPod and actual PR CI, and run normal stage QA. The stage environment intentionally has no personal MTProto key, so missing-session prompt rendering is covered by actual callback/keyboard tests without weakening the stage credential boundary.
- [ ] Merge through `gh ship`, verify the deployed revision and perform a read-only username lookup through the deployed path.

## Verification boundaries

Local checks are limited to a bounded single test file and changed-file lint. Full suites, typecheck, coverage, adversarial testing and mutation testing run only in established CI or RunPod. Production evidence remains anonymized; session blobs, user IDs and calendar content are excluded. No test invitation is sent to a real recipient.
