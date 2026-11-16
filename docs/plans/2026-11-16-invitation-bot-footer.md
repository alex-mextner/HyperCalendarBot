# Invitation bot footer

Task: UB-213. Scope: a short footer on invitations sent from the inviter's own connected Telegram account.

## Constraints

- Preserve the delivery chain: Bot API, then the inviter's connected session, then a forwarding link to the inviter. The shared service account remains unable to send messages.
- Use the configured bot username and the invitation's existing language in both normal and resumed delivery.
- Keep meeting fields and RSVP links literal. Ordinary MTProto messages support italic entities but no custom font size or text color.
- Add one final sentence after a blank line. When it would exceed 4096 UTF-16 units, preserve the original invitation body and omit the optional footer. Keep reminders, technical replies, and bot-delivered invitations unchanged.
- Validate with synthetic content only; do not send invitations to people for testing.

## Work

- [x] Inspect the active templates, both delivery call sites, and plain-text Python transport.
- [x] Reproduce the missing footer in focused formatter tests (8 existing pass, 3 new fail).
- [x] Add translated copy and a UTF-16 italic span; preserve disabled parsing in Pyrogram.
- [x] Cover normal delivery, resumed delivery, metadata serialization, and Python's final send payload.
- [ ] Complete independent review, full native PR CI, and normal release gates.
- [ ] Verify the deployed revision, health/readiness, and synthetic installed-code payload without sending a message.

## Copy

RU: «Открой @<bot>, чтобы приглашать на свои встречи без email.»

EN: “Open @<bot> to invite people to your own meetings without email.”

The username is supplied by the existing bot configuration; the test handle is CalendarStageBot.

## Evidence and boundaries

The focused formatter file passes 12 tests with coverage disabled for the local check. The length-boundary regression first failed on a 4097-unit output, then passed with the footer omitted and the body retained. Full tests and coverage run only in native CI. Transport and resumed-delivery test outcomes remain pending CI.

Concurrent invitation-delivery work in GH-991 is separate; its notification bookkeeping changes must be preserved during integration. Stage infrastructure admission is coordinated separately because GH-989 records production contention from a prior stage run. The initial pull request remains draft while source checks run.

Telegram formatting references: https://core.telegram.org/api/entities and https://core.telegram.org/method/messages.sendMessage.
