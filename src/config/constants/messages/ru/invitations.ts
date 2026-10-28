// src/config/constants/messages/ru/invitations.ts
// Invitations, RSVP, propose-time and invitee/inviter notifications.

import { inclineFirstname } from 'lvovich';
import { ruPlural } from '../../../../services/event/formatters.ts';

export const ruInvitations = {
  invite_error: 'Не удалось отправить приглашение.',
  invite_delivered: (title: string) => `📨 Приглашение на "<b>${title}</b>" отправлено`,
  invite_deep_link: (title: string, url: string) =>
    `Пользователь ещё не запустил бота. Перешлите ссылку для принятия:\n\n${url}\n\n(Приглашение на "<b>${title}</b>")`,
  invitation_sent: 'Приглашение отправлено',
  // SAFETY: see en.invitation_received — both args must be HTML-safe before
  // being passed; template wraps `titleHtml` in <b> and concatenates `fromHtml`.
  invitation_received: (titleHtml: string, fromHtml: string) => `📨 <b>${titleHtml}</b> — приглашение от ${fromHtml}`,
  invite_timezone_note: (inviterName: string, tz: string) =>
    `\n⏰ Время в часовом поясе ${inclineFirstname(inviterName, 'genitive')} (${tz})`,
  invite_resolve_not_found: (username: string) =>
    `@${username} не найден в Telegram. Выбери нужного человека из контактов.`,
  invite_resolve_unavailable: (username: string) =>
    `Не удалось проверить @${username}. Выбери нужного человека из контактов.`,
  invite_picker_header: '📨 Приглашения:',
  invite_picker_sending: '📨 Отправляю приглашения…',
  invite_group_sending: '📨 Отправляю приглашение…',
  invite_status_delivered: (name: string) => `✅ ${name}`,
  invite_status_deeplink: (name: string) => `🔗 ${name} — ссылку отправил тебе для пересылки`,
  invite_status_failed: (name: string) => `❌ ${name} — не доставлено`,
  invite_status_error: (name: string, error: string) => `❌ ${name}: ${error}`,
  invite_status_not_configured: (name: string) => `❌ ${name}: приглашения не настроены`,
  invitation_accepted: '✅ Приглашение принято',
  invitation_declined: '❌ Приглашение отклонено',
  invitation_maybe: '🤔 Отмечено как "возможно"',
  invitation_cancelled: 'Приглашение отменено',
  invitation_expired: 'Это приглашение истекло',
  invitation_already_answered: 'На это приглашение уже дан ответ',
  invitation_not_found: 'Приглашение не найдено',
  invitation_already_sent: 'Приглашение уже отправлено этому пользователю',
  invitations_disabled: 'Этот пользователь отключил приглашения',
  invitation_response_accepted: (name: string, title: string) =>
    `📨 ${name} принял(а) приглашение на "<b>${title}</b>" ✅`,
  invitation_response_declined: (name: string, title: string) =>
    `📨 ${name} отклонил(а) приглашение на "<b>${title}</b>" ❌`,
  invitation_response_maybe: (name: string, title: string) =>
    `📨 ${name} ответил(а) "возможно" на приглашение "<b>${title}</b>" 🤔`,
  // SAFETY: see en.invitationRoster — every name argument must already be HTML-escaped.
  invitationRoster: {
    header: '👥 Участники:',
    organizer: (nameHtml: string) => `👑 ${nameHtml} — организатор`,
    answer: {
      accepted: (nameHtml: string) => `✅ ${nameHtml} — придёт`,
      maybe: (nameHtml: string) => `🤔 ${nameHtml} — возможно`,
      pending: (nameHtml: string) => `⏳ ${nameHtml} — ждём ответа`,
      declined: (nameHtml: string) => `❌ ${nameHtml} — не придёт`,
    },
    reader: (nameHtml: string) => `${nameHtml} (ты)`,
    unnamed: 'Гость',
    more: (count: number) => `…и ещё ${count} ${ruPlural(count, 'человек', 'человека', 'человек')}`,
  },
  group_rsvp_going_btn: '✅ Иду',
  group_rsvp_notgoing_btn: '❌ Не иду',
  group_rsvp_recorded: 'Ты идёшь ✅',
  group_rsvp_removed: 'Ты не идёшь ❌',
  group_rsvp_not_authorized: 'Здесь нельзя ответить на это приглашение',
  group_rsvp_start_hint: 'Напиши мне в личку и нажми /start, чтобы ответить',
  invite_accept_btn: '✅ Принять',
  invite_decline_btn: '❌ Отклонить',
  invite_maybe_btn: 'Возможно 🤔',
  invite_propose_btn: 'Другое время 🕐',
  invite_propose_ask: 'Какое время предлагаешь?\nИли напиши: "завтра в 15:00"',
  invite_propose_plus30: '+30 мин',
  invite_propose_plus60: '+1 час',
  invite_propose_sent: (time: string) => `⏰ Вы предложили: ${time}`,
  invite_propose_notify: (name: string, event: string, time: string) =>
    `📅 ${name} предлагает перенести <b>${event}</b> на ${time}`,
  invite_reschedule_btn: 'Перенести 📅',
  invite_keep_btn: 'Оставить как есть',
  invite_rescheduled_inviter: (time: string) => `✅ Событие перенесено на ${time}`,
  invite_rescheduled_invitee: (event: string, time: string) =>
    `✅ <b>${event}</b> перенесено на ${time}. Вы автоматически приняты.`,
  invite_kept_inviter: '❌ Предложение отклонено',
  invite_kept_invitee: (event: string, time: string) =>
    `❌ Ваше предложение для <b>${event}</b> отклонено. Событие остаётся в ${time}.`,
  invite_proposal_closed: '⏰ Это предложение уже неактуально',
  invitations_from: (name: string) => `от ${name}`,
  invitations_to: (name: string) => `для ${name}`,
} as const;
