// src/config/constants/messages/en/invitations.ts
// Invitations, RSVP, propose-time and invitee/inviter notifications.

export const enInvitations = {
  invite_error: 'Failed to send invitation.',
  invite_delivered: (title: string) => `📨 Invitation to "<b>${title}</b>" sent`,
  invite_deep_link: (title: string, url: string) =>
    `The user hasn't started the bot yet. Forward this link so they can accept:\n\n${url}\n\n(Invitation to "<b>${title}</b>")`,
  invitation_sent: 'Invitation sent',
  // SAFETY: both arguments must be HTML-safe when passed — either escaped
  // plain text via `escapeHtml(...)` or a pre-built HTML fragment like
  // `<a href="tg://user?id=...">name</a>`. The template wraps `titleHtml`
  // in `<b>...</b>` and concatenates `fromHtml` verbatim.
  invitation_received: (titleHtml: string, fromHtml: string) => `📨 <b>${titleHtml}</b> — invitation from ${fromHtml}`,
  invite_timezone_note: (inviterName: string, tz: string) => `\n⏰ Time shown in ${inviterName}'s timezone (${tz})`,
  invite_resolve_not_found: (username: string) =>
    `@${username} not found on Telegram. Select the person from your contacts.`,
  invite_resolve_unavailable: (username: string) =>
    `I couldn't look up @${username}. Select the person from your contacts.`,
  invite_picker_header: '📨 Invitations:',
  invite_picker_sending: '📨 Sending invitations…',
  invite_group_sending: '📨 Sending invitation…',
  invite_status_delivered: (name: string) => `✅ ${name}`,
  invite_status_deeplink: (name: string) => `🔗 ${name} — link sent to you to forward`,
  invite_status_failed: (name: string) => `❌ ${name} — not delivered`,
  invite_status_error: (name: string, error: string) => `❌ ${name}: ${error}`,
  invite_status_not_configured: (name: string) => `❌ ${name}: invitations not configured`,
  invitation_accepted: '✅ Invitation accepted',
  invitation_declined: '❌ Invitation declined',
  invitation_maybe: '🤔 Marked as maybe',
  invitation_cancelled: 'Invitation cancelled',
  invitation_expired: 'This invitation has expired',
  invitation_already_answered: 'This invitation has already been answered',
  invitation_not_found: 'Invitation not found',
  invitation_already_sent: 'Invitation already sent to this user',
  invitations_disabled: 'This user has disabled invitations',
  invitation_response_accepted: (name: string, title: string) =>
    `📨 ${name} accepted your invitation to "<b>${title}</b>" ✅`,
  invitation_response_declined: (name: string, title: string) =>
    `📨 ${name} declined your invitation to "<b>${title}</b>" ❌`,
  invitation_response_maybe: (name: string, title: string) =>
    `📨 ${name} responded "maybe" to your invitation to "<b>${title}</b>" 🤔`,
  // SAFETY: every name argument must already be HTML-escaped.
  invitationRoster: {
    header: '👥 Participants:',
    organizer: (nameHtml: string) => `👑 ${nameHtml} — organizer`,
    answer: {
      accepted: (nameHtml: string) => `✅ ${nameHtml} — going`,
      maybe: (nameHtml: string) => `🤔 ${nameHtml} — maybe`,
      pending: (nameHtml: string) => `⏳ ${nameHtml} — no answer yet`,
      declined: (nameHtml: string) => `❌ ${nameHtml} — not going`,
    },
    reader: (nameHtml: string) => `${nameHtml} (you)`,
    unnamed: 'Guest',
    more: (count: number) => `…and ${count} more`,
  },
  group_rsvp_going_btn: '✅ Going',
  group_rsvp_notgoing_btn: "❌ Can't make it",
  group_rsvp_recorded: "You're going ✅",
  group_rsvp_removed: "You're not going ❌",
  group_rsvp_not_authorized: 'This RSVP is not available here',
  group_rsvp_start_hint: 'Open me in a private chat and press /start to RSVP',
  invite_accept_btn: '✅ Accept',
  invite_decline_btn: '❌ Decline',
  invite_maybe_btn: 'Maybe 🤔',
  invite_propose_btn: 'Other time 🕐',
  invite_propose_ask: 'What time do you suggest?\nOr type: "tomorrow at 3pm"',
  invite_propose_plus30: '+30 min',
  invite_propose_plus60: '+1 hour',
  invite_propose_sent: (time: string) => `⏰ You suggested: ${time}`,
  invite_propose_notify: (name: string, event: string, time: string) =>
    `📅 ${name} suggests rescheduling <b>${event}</b> to ${time}`,
  invite_reschedule_btn: 'Reschedule 📅',
  invite_keep_btn: 'Keep original',
  invite_rescheduled_inviter: (time: string) => `✅ Event rescheduled to ${time}`,
  invite_rescheduled_invitee: (event: string, time: string) =>
    `✅ <b>${event}</b> rescheduled to ${time}. You are automatically accepted.`,
  invite_kept_inviter: '❌ Suggestion declined',
  invite_kept_invitee: (event: string, time: string) =>
    `❌ Your suggestion for <b>${event}</b> was declined. It stays at ${time}.`,
  invite_proposal_closed: '⏰ This suggestion is no longer open',
  invitations_from: (name: string) => `from ${name}`,
  invitations_to: (name: string) => `to ${name}`,
} as const;
