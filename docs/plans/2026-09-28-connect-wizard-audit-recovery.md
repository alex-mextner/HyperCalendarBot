# Telegram-connect wizard: safe audit records, held-message recovery, stale cancel, masked phone history

Tracking: GH-645 (safe audit, recovery, stale cancel, unreadable state), GH-643 (masked phone in
history). Related, not closed here: GH-519 (credential-copy cleanup), GH-630, GH-637, GH-623.
Spec: `docs/specs/2026-03-24-connect-telegram.md`, sections "Cancel-authorization Inline Button" and
"Wizard input stays out of logs and the AI".

Order follows the repository priorities: credential secrecy first, then lost requests, then
observability.

## Checklist

- [x] Secrecy: no phone, login code or 2FA password in chat_history, user_action_log, the AI
      request, its debug log, feature usage or pino logs on any path — typed, edited, slash,
      late, rate-limited, expired, unreadable state, failed deletion, bridge error, session save
      error. Real-middleware-chain tests with synthetic values.
- [x] Failure logging on these paths through an allowlist (`src/utils/safe-failure.ts`): fixed
      class labels, Telegram HTTP-range status, known bridge codes only.
- [x] Unreadable scene store: held for confirmation when the trace shows an open wizard (or the
      trace is unreadable in a private chat); ordinary otherwise.
- [x] Audit: every protected input leaves one marker row and one `connect_wizard_input` audit row
      (reason, step, message id, deletion, outcome — never text, length or digest); the opening
      update is `opened`; the expiry notice is logged in order; no duplicate history turns.
- [x] Recovery: the answer to an expired prompt is held in bounded memory (15 min, 3 per user,
      100 in all, timer cleanup), answered with "process it" / "Discard" buttons, owner- and
      chat-bound opaque single-use nonce, consumed before any await, replayed once through the
      whole bot; a wizard that could take it is ended first; a newer wizard or an unreadable state
      refuses the release; discard, expiry and restart never process it.
- [x] Stale cancel: cancel buttons (consent and prompts) name their run, created at entry; an
      expired run's button closes its trace, stops its login and removes its temp session file (the
      trace keeps that path); an earlier run's button cannot cancel a newer one; the next request is
      ordinary.
- [x] Masked phone (GH-643): stays visible in the UI; chat_history keeps `[masked phone]` in its
      place for the success, already-connected and /settings replies only.
- [x] Feature usage: the command-usage tracking middleware is shared by the bot and the test
      harness; held slash text is counted only after release.
- [ ] Full gates at the exact PR head: `bun test`, `tsc --noEmit`, `bun run lint`, type-bans.
- [ ] Independent correctness/security review; findings triaged.
- [ ] Hand-off to the merge-queue owner for the normal `gh ship`; no independent deployment.

## Not in scope

- History rows written before this change are not rewritten (no bulk production history rewrite);
  their cleanup stays with GH-519.
