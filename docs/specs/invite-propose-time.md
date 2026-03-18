# Invite: Propose Alternative Time

## Overview

When a user receives a calendar invitation, they can propose an alternative time instead of accepting or declining. The inviter receives a notification with a button to reschedule the event automatically.

## UX Flow

### Invitee side

1. Receives invitation with 4 buttons:
   ```
   [Accept ✅] [Decline ❌]
   [Maybe 🤔]  [Другое время 🕐]
   ```

2. Clicks "Другое время 🕐" → `inv:propose:{invitation_id}`

3. Bot sends a new message in the same chat:
   ```
   Какое время предлагаешь?
   [+30 мин] [+1 час]
   Или напиши: "завтра в 15:00"
   ```
   Quick buttons: `inv:propose:{id}:+30` and `inv:propose:{id}:+60`
   Bot sets session state `{ type: 'awaiting_propose_time', invitation_id }`.

4. Invitee writes time (parsed via existing parser) or clicks quick button.

5. On valid time input:
   - `invitations.proposed_time` is set to the ISO 8601 UTC value
   - Original invite message is edited: buttons removed, shows `⏰ Вы предложили: 20 марта, 15:00`
   - The "Введи время" message is deleted
   - Inviter receives notification (see below)

### Inviter side

Notification message:
```
📅 Иван предлагает перенести «Standup» на 20 марта, 15:00
[Перенести 📅]  [Оставить как есть]
```

- `inv:reschedule:{invitation_id}` — updates `events.start_time` and `events.end_time`
  (duration preserved), sets invitation status to `accepted`, notifies invitee of reschedule.
- `inv:keep:{invitation_id}` — dismisses the proposal, invitation reverts to `pending` state
  (buttons restored), notifies invitee that proposal was declined.

### After reschedule

- Inviter sees: `✅ Событие перенесено на 20 марта, 15:00`
- Invitee receives: `✅ «Standup» перенесён на 20 марта, 15:00. Вы автоматически приняты.`

### After "Оставить как есть"

- Inviter sees: `❌ Предложение отклонено`
- Invitee receives: `❌ Иван отклонил предложение. Событие остаётся [original time].`
- Invite message is restored with the 4 action buttons.

## Database

### Migration

```sql
ALTER TABLE invitations ADD COLUMN proposed_time TEXT;
```

`proposed_time` — ISO 8601 UTC string, nullable. Non-null means proposal pending.

## Session State

Existing in-memory session Map. New session type:

```typescript
{ type: 'awaiting_propose_time'; invitation_id: number; event_start: string }
```

`event_start` stored so quick buttons can compute +30/+60 offsets without a DB lookup.

## Callback Actions

| Callback data | Actor | Description |
|---|---|---|
| `inv:propose:{id}` | invitee | Opens time input flow |
| `inv:propose:{id}:+30` | invitee | Proposes event_start + 30 min |
| `inv:propose:{id}:+60` | invitee | Proposes event_start + 60 min |
| `inv:reschedule:{id}` | inviter | Reschedules event to proposed_time |
| `inv:keep:{id}` | inviter | Dismisses proposal, restores invite buttons |

## State Machine Changes

`proposed_time` column is orthogonal to `status`. Invitation stays `pending`/`maybe` while proposal
is outstanding. After reschedule → status becomes `accepted`.

No new `status` value needed.

## i18n Strings (EN/RU)

- `invite_propose_btn` — "Другое время 🕐" / "Other time 🕐"
- `invite_propose_ask` — "Какое время предлагаешь? Или напиши: «завтра в 15:00»"
- `invite_propose_sent(time)` — "⏰ Вы предложили: {time}"
- `invite_propose_notify(name, event, time)` — "📅 {name} предлагает перенести «{event}» на {time}"
- `invite_reschedule_btn` — "Перенести 📅"
- `invite_keep_btn` — "Оставить как есть"
- `invite_rescheduled_inviter(time)` — "✅ Событие перенесено на {time}"
- `invite_rescheduled_invitee(event, time)` — "✅ «{event}» перенесён на {time}. Вы автоматически приняты."
- `invite_kept_inviter` — "❌ Предложение отклонено"
- `invite_kept_invitee(event, original_time)` — "❌ Ваше предложение отклонено. Событие остаётся {original_time}."

## Files to change

- `src/database/migrations.ts` — add migration with `proposed_time` column
- `src/database/types.ts` — add `proposed_time` field to `Invitation` type
- `src/database/repositories/invitation.repository.ts` — add `setProposedTime()`, `clearProposedTime()`
- `src/services/sharing/invitation-service.ts` — add `proposeTime()`, `rescheduleFromProposal()`, `keepOriginalTime()`
- `src/bot/commands/invite.ts` — add 4th button to invite message
- `src/bot/handlers/callback.handler.ts` — handle `propose`, `reschedule`, `keep` sub-actions
- `src/bot/handlers/message.handler.ts` — handle `awaiting_propose_time` session state
- `test/services/sharing/invitation-service.test.ts` — new tests for propose/reschedule/keep
- `test/bot/handlers/callback-invitation.test.ts` — new callback tests
