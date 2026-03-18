// src/bot/handlers/callback.handler.ts

import { TZDate } from '@date-fns/tz';
import type { AnyScene } from '@gramio/scenes';
import { InlineKeyboard } from 'gramio';
import type { Lang } from '../../config/constants.ts';
import { CB, t } from '../../config/constants.ts';
import type { CalendarProposalRepository } from '../../database/repositories/calendar-proposal.repository.ts';
import type { CallSettingsRepository } from '../../database/repositories/call-settings.repository.ts';
import type { ChatHistoryRepository } from '../../database/repositories/chat-history.repository.ts';
import type { ContactRepository } from '../../database/repositories/contact.repository.ts';
import type { EditProposalRepository } from '../../database/repositories/edit-proposal.repository.ts';
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { EventReminderRepository } from '../../database/repositories/event-reminder.repository.ts';
import type { FeedbackRepository } from '../../database/repositories/feedback.repository.ts';
import type { GoogleCalendarRepository } from '../../database/repositories/google-calendar.repository.ts';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { IntentRepository } from '../../database/repositories/intent.repository.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import type { SecretaryRepository } from '../../database/repositories/secretary.repository.ts';
import type { SharingSettingsRepository } from '../../database/repositories/sharing-settings.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { CreateEventData, Invitation, UpdateEventData, User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatDayAgenda, formatEventDetail } from '../../services/event/formatters.ts';
import type { GoogleOAuthService } from '../../services/google/oauth.ts';
import type { HolidayService } from '../../services/holiday/holiday-service.ts';
import { mapDailyAgendaData, mapWeeklyOverviewData } from '../../services/image/data-mapper.ts';
import type { RenderService } from '../../services/image/render-service.ts';
import type { AdminEditSession } from '../../services/intent/admin-edit-session.ts';
import type { NotificationPreferencesService } from '../../services/notification/preferences.ts';
import type { InvitationService } from '../../services/sharing/invitation-service.ts';
import {
  fixDateOrdinals,
  fixLineBreaks,
  markStress,
  numbersToWords,
  stripMarkdown,
  transliterateEnglish,
} from '../../services/voice/stress-marker.ts';
import { getWeekRangeUtc } from '../../utils/date.ts';
import { formatProposedTime } from '../../utils/invite-time-format.ts';
import { cmdLogger, imageLogger } from '../../utils/logger.ts';
import { getTheme } from '../../worker/templates/themes.ts';
import { handleGroupAgendaCallback } from '../commands/agenda.ts';
import { handleCalendarPickerCallback } from '../commands/calendars.ts';
import { handleDeleteCallback, handleDeleteConfirmCallback } from '../commands/delete.ts';
import { type DisconnectDeps, executeDisconnect } from '../commands/disconnect-google.ts';
import { handleEditCallback, handleEditFieldCallback } from '../commands/edit.ts';
import { handleFeatureTourCallback } from '../commands/feature-tour.ts';
import { handleHolidayCallback } from '../commands/holidays.ts';
import { handleMonth } from '../commands/month.ts';
import { handleSettingsCallback } from '../commands/settings.ts';
import { editFieldKeyboard, eventActionsKeyboard, inviteContactPickerKeyboard } from '../keyboards.ts';
import type { BotCallbackContext } from '../types.ts';
import { handleNotifyCallback } from './notify-callback.ts';
import { handleSnoozeCallback } from './snooze-callback.ts';

/**
 * Route all inline keyboard callbacks.
 * Callback data format: "prefix:payload" or "prefix:p1:p2"
 */
export function createCallbackHandler(
  eventService: EventService,
  editValueScene: AnyScene,
  holidayService: HolidayService,
  prefsService: NotificationPreferencesService,
  calendarRepo?: GoogleCalendarRepository,
  disconnectDeps?: DisconnectDeps,
  onCalendarsDone?: (userId: number) => Promise<void>,
  renderService?: RenderService,
  invitationService?: InvitationService,
  groupChatRepo?: GroupChatRepository,
  eventRepo?: EventRepository,
  chatHistoryRepo?: ChatHistoryRepository,
  onAiButtonClick?: (userId: number, chatId: number, text: string) => Promise<void>,
  oauthDeps?: {
    oauthService: GoogleOAuthService;
    stateStore: { set(key: string, value: string, ttl: number): Promise<void> };
  },
  invitationNotifyDeps?: {
    userRepo: UserRepository;
    sendMessage: (
      chatId: number,
      text: string,
      options: { parse_mode: string; reply_markup?: unknown },
    ) => Promise<void>;
    editMessage?: (chatId: number, messageId: number, text: string, markup?: unknown) => Promise<void>;
  },
  onboardingScene?: AnyScene,
  editProposalDeps?: {
    editProposalRepo: EditProposalRepository;
    sendMessage: (chatId: number, text: string, options: { parse_mode: string }) => Promise<void>;
  },
  callSettingsRepo?: CallSettingsRepository,
  sharingSettingsRepo?: SharingSettingsRepository,
  feedbackDeps?: {
    feedbackRepo: FeedbackRepository;
    adminReplySession: Map<number, { threadId: number; userId: number }>;
    sendMessage: (chatId: number, text: string) => Promise<unknown>;
    adminId?: number;
  },
  userRepo?: UserRepository,
  intentDeps?: {
    intentRepo: IntentRepository;
    intentMatcher?: { reload: () => void };
    adminEditSessions?: Map<number, AdminEditSession>;
  },
  secretaryDeps?: SecretaryDeps,
  proposalDeps?: ProposalDeps,
  snoozeDeps?: SnoozeDeps,
  forceInviteDeps?: ForceInviteDeps,
  proposeTimeSessions?: Map<number, { invitationId: number }>,
  invitationRepo?: InvitationRepository,
  voiceDeps?: {
    sileroTts?: { synthesize: (text: string) => Promise<Buffer> };
    kokoroTts?: { synthesize: (text: string) => Promise<Buffer> };
    sendVoice: (chatId: number, audio: Buffer) => Promise<void>;
    stressDictionary?: { lookup: (word: string) => string | null };
  },
  contactRepo?: ContactRepository,
) {
  return async (ctx: BotCallbackContext) => {
    const data = ctx.data as string;
    if (!data) return;

    const user = ctx.dbUser as User;
    const parts = data.split(':');
    const action = parts[0]!;
    const payload = parts.slice(1).join(':');

    // Log button press to chat history.
    // ai_btn is excluded: its answerText is saved as a button event just before onAiButtonClick,
    // and saveUserMessage() inside agent.run() must NOT see a duplicate entry.
    if (chatHistoryRepo && user && action !== 'ai_btn') {
      chatHistoryRepo.save(
        user.telegram_id,
        'user',
        JSON.stringify({ kind: 'button', label: action, detail: payload }),
      );
    }

    try {
      // Event view
      if (action === CB.EVENT_VIEW) {
        if (payload === 'cancel') {
          await ctx.answer();
          return ctx.editText('OK');
        }
        const eventId = Number(payload);
        const event = eventService.getEvent(eventId, user.telegram_id);
        if (!event) return ctx.answer({ text: 'Not found' });
        const detail = formatEventDetail(event, user.timezone, user.language);
        await ctx.answer();
        return ctx.editText(detail, {
          parse_mode: 'HTML',
          reply_markup: eventActionsKeyboard(eventId, user.language as 'en' | 'ru'),
        });
      }

      // Event edit — payload: "42" (one-off) or "42:2026-03-15T10:00:00Z" (recurring)
      if (action === CB.EVENT_EDIT) {
        if (payload === 'cancel') {
          await ctx.answer();
          return ctx.editText('OK');
        }
        const colonIdx = payload.indexOf(':');
        if (colonIdx === -1) {
          return handleEditCallback(ctx, eventService, user, Number(payload));
        }
        const eventId = Number(payload.slice(0, colonIdx));
        const occurrenceDate = payload.slice(colonIdx + 1);
        return handleEditCallback(ctx, eventService, user, eventId, occurrenceDate);
      }

      // Edit field
      if (action === CB.EDIT_FIELD) {
        const [eidStr, field] = payload.split(':');
        if (field === 'cancel' || eidStr === 'cancel') {
          await ctx.answer();
          return ctx.editText('OK');
        }
        return handleEditFieldCallback(ctx, user, Number(eidStr), field!, editValueScene);
      }

      // Event delete — payload: "42" or "42:2026-03-15T10:00:00Z"
      if (action === CB.EVENT_DELETE) {
        if (payload === 'cancel') {
          await ctx.answer();
          return ctx.editText('OK');
        }
        const colonIdx = payload.indexOf(':');
        if (colonIdx === -1) {
          return handleDeleteCallback(ctx, eventService, user, Number(payload));
        }
        const eventId = Number(payload.slice(0, colonIdx));
        const occurrenceDate = payload.slice(colonIdx + 1);
        return handleDeleteCallback(ctx, eventService, user, eventId, occurrenceDate);
      }

      // Delete confirm
      if (action === CB.EVENT_DELETE_CONFIRM) {
        return handleDeleteConfirmCallback(ctx, eventService, user, Number(payload));
      }

      // Recurring event edit scope — er:{eventId}:{occurrenceDate}:{scope}
      if (action === CB.EVENT_RECURRENCE) {
        const [eidStr, ...rest] = payload.split(':');
        const eventId = Number(eidStr);
        const scope = rest.pop(); // 'this' or 'future'
        const occurrenceDate = rest.join(':'); // ISO date contains ':'
        const lang = (user.language ?? 'en') as Lang;

        if (scope === 'this') {
          const exception = eventService.editOccurrence(eventId, occurrenceDate, user.telegram_id);
          if (!exception) return ctx.answer({ text: 'Error' });
          await ctx.answer();
          return ctx.editText(formatEventDetail(exception, user.timezone, lang), {
            parse_mode: 'HTML',
            reply_markup: editFieldKeyboard(exception.id, lang),
          });
        }

        if (scope === 'future') {
          const newTemplate = eventService.splitRecurrence(eventId, occurrenceDate, user.telegram_id);
          if (!newTemplate) return ctx.answer({ text: 'Error' });
          await ctx.answer();
          return ctx.editText(formatEventDetail(newTemplate, user.timezone, lang), {
            parse_mode: 'HTML',
            reply_markup: editFieldKeyboard(newTemplate.id, lang),
          });
        }

        await ctx.answer();
        return;
      }

      // Recurring event delete scope — erd:{eventId}:{occurrenceDate}:{scope}
      if (action === CB.RECURRENCE_DELETE) {
        const [eidStr, ...rest] = payload.split(':');
        const eventId = Number(eidStr);
        const scope = rest.pop();
        const occurrenceDate = rest.join(':');
        const lang = (user.language ?? 'en') as Lang;

        if (scope === 'this') {
          const event = eventService.getEvent(eventId, user.telegram_id);
          eventService.cancelOccurrence(eventId, user.telegram_id, occurrenceDate);
          await ctx.answer();
          return ctx.editText(t(lang).event_deleted(event?.title ?? '?'));
        }

        if (scope === 'future') {
          const event = eventService.getEvent(eventId, user.telegram_id);
          eventService.deleteFuture(eventId, occurrenceDate, user.telegram_id);
          await ctx.answer();
          return ctx.editText(t(lang).event_deleted(event?.title ?? '?'));
        }

        await ctx.answer();
        return;
      }

      // Month navigation
      if (action === CB.MONTH_NAV) {
        await ctx.answer();
        return handleMonth(ctx, eventService, payload);
      }

      // Notifications
      if (action === CB.NOTIFY) {
        return handleNotifyCallback(ctx, prefsService, user, payload);
      }

      // Holidays
      if (action === CB.HOLIDAYS) {
        return handleHolidayCallback(ctx, holidayService, user, payload);
      }

      // Google Calendar callbacks
      if (action === CB.GCAL) {
        const lang = (user.language ?? 'en') as Lang;
        const subParts = payload.split(':');
        const subAction = subParts[0];
        const subPayload = subParts.slice(1).join(':');

        if (subAction === 'cal' && calendarRepo) {
          return handleCalendarPickerCallback(ctx, calendarRepo, user.telegram_id, subPayload, lang, onCalendarsDone);
        }
        if (subAction === 'disconnect') {
          if (subPayload === 'yes' && disconnectDeps) {
            await executeDisconnect(user.telegram_id, disconnectDeps);
            await ctx.answer();
            return ctx.editText(t(lang).gcal_disconnected);
          }
          await ctx.answer();
          return ctx.editText('OK');
        }
        if (subAction === 'onboard') {
          if (subPayload === 'later') {
            await ctx.answer();
            await ctx.message?.delete();
            return;
          }
          if (subPayload === 'connect') {
            if (oauthDeps) {
              const stateId = crypto.randomUUID();
              await oauthDeps.stateStore.set(
                `oauth:state:${stateId}`,
                JSON.stringify({ telegram_user_id: user.telegram_id, created_at: Date.now() }),
                300,
              );
              const authUrl = oauthDeps.oauthService.generateAuthUrl(stateId);
              const kb = new InlineKeyboard().url(t(lang).gcal_connect_button, authUrl);
              await ctx.answer();
              await ctx.editText(t(lang).gcal_connect_prompt, { reply_markup: kb });
            } else {
              await ctx.answer({ text: t(lang).gcal_connect_prompt });
            }
            return;
          }
        }
        return;
      }

      // Image: daily agenda
      if (action === CB.IMG_DAILY && renderService) {
        const dateIso = payload;
        await ctx.answer();

        const now = new Date();
        const occurrences = eventService.getEventsForDay(
          user.telegram_id,
          new Date(`${dateIso}T12:00:00Z`),
          user.timezone,
        );

        const userNow = new TZDate(now, user.timezone);
        const todayIso = userNow.toISOString().slice(0, 10);
        const isToday = dateIso === todayIso;
        const currentTimeMinutes = isToday ? userNow.getHours() * 60 + userNow.getMinutes() : undefined;

        const holidays = holidayService.getHolidaysForDate(user.telegram_id, dateIso);

        const data = mapDailyAgendaData({
          occurrences,
          dateIso,
          timezone: user.timezone,
          locale: user.language as 'ru' | 'en',
          theme: getTheme(),
          currentTimeMinutes,
          isHoliday: holidays.length > 0,
          holidayName: holidays[0]?.name,
        });

        try {
          const buffer = await renderService.renderDirect({
            type: 'daily-agenda',
            data,
            userId: user.telegram_id,
          });
          const file = new File([buffer], 'agenda.png', { type: 'image/png' });
          if (ctx.message) {
            await ctx.message.sendPhoto(file);
          } else {
            await ctx.answer({ text: '⚠️ Could not send image' });
          }
        } catch (err) {
          imageLogger.error({ error: (err as Error).message }, 'Render failed');
          if (ctx.message) {
            await ctx.message.send('⚠️ Image generation failed. Use text version above.');
          } else {
            await ctx.answer({ text: '⚠️ Render failed' });
          }
        }
        return;
      }

      // Image: weekly overview
      if (action === CB.IMG_WEEKLY && renderService) {
        const weekStartIso = payload;
        await ctx.answer();

        const now = new Date();
        const weekStartDate = new Date(`${weekStartIso}T12:00:00Z`);
        const { start, end } = getWeekRangeUtc(weekStartDate, user.timezone);
        const occurrences = eventService.getEventsInRange(user.telegram_id, start, end);

        const occurrencesByDay = new Map<string, typeof occurrences>();
        const startD = new Date(start);
        for (let i = 0; i < 7; i++) {
          const d = new Date(startD.getTime() + i * 86400000);
          const dayKey = d.toISOString().slice(0, 10);
          occurrencesByDay.set(dayKey, []);
        }
        for (const occ of occurrences) {
          const occDate = new TZDate(new Date(occ.occurrence_start), user.timezone).toISOString().slice(0, 10);
          const dayList = occurrencesByDay.get(occDate);
          if (dayList) {
            dayList.push(occ);
          }
        }

        const userNow = new TZDate(now, user.timezone);
        const todayIso = userNow.toISOString().slice(0, 10);

        const data = mapWeeklyOverviewData({
          occurrencesByDay,
          weekStartIso,
          timezone: user.timezone,
          locale: user.language as 'ru' | 'en',
          theme: getTheme(),
          todayIso,
        });

        try {
          const buffer = await renderService.renderDirect({
            type: 'weekly-overview',
            data,
            userId: user.telegram_id,
          });
          const file = new File([buffer], 'week.png', { type: 'image/png' });
          if (ctx.message) {
            await ctx.message.sendPhoto(file);
          } else {
            await ctx.answer({ text: '⚠️ Could not send image' });
          }
        } catch (err) {
          imageLogger.error({ error: (err as Error).message }, 'Render failed');
          if (ctx.message) {
            await ctx.message.send('⚠️ Image generation failed. Use text version above.');
          } else {
            await ctx.answer({ text: '⚠️ Render failed' });
          }
        }
        return;
      }

      // Invitation actions
      if (action === CB.INVITATION_ACTION && invitationService) {
        const subAction = parts[1];
        const invId = Number(parts[2]);
        const lang = (user.language ?? 'en') as Lang;

        if (subAction === 'keep') {
          await ctx.answer(t(lang).invitation_accepted);
          return;
        }

        if (subAction === 'propose') {
          const offsetStr = parts[3];
          const inv = invitationRepo?.findById(invId);
          if (!inv) {
            await ctx.answer({ text: t(lang).invitation_not_found });
            return;
          }
          const event = eventRepo?.findById(inv.event_id, inv.inviter_id);

          if (offsetStr === '+30' || offsetStr === '+60') {
            const offsetMs = offsetStr === '+30' ? 30 * 60_000 : 60 * 60_000;
            const baseTime = event?.start_at ? new Date(event.start_at).getTime() : Date.now();
            const proposedTime = new Date(baseTime + offsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
            const propResult = invitationService.proposeTime(invId, user.telegram_id, proposedTime);
            if (!propResult.success) {
              await ctx.answer({ text: propResult.error ?? 'Error' });
              return;
            }
            const formatted = formatProposedTime(proposedTime, user.timezone, lang);
            await ctx.answer();
            await ctx.editText(t(lang).invite_propose_sent(formatted), { parse_mode: 'HTML' }).catch(() => {});
            if (invitationNotifyDeps && event) {
              notifyInviterProposal(
                inv,
                user,
                formatted,
                event.title ?? `Event #${inv.event_id}`,
                invitationNotifyDeps,
              ).catch(() => {});
            }
          } else {
            if (proposeTimeSessions) {
              proposeTimeSessions.set(user.telegram_id, { invitationId: invId });
            }
            await ctx.answer();
            const msgs = t(lang);
            const quickKeyboard = new InlineKeyboard()
              .text(msgs.invite_propose_plus30, `${CB.INVITATION_ACTION}:propose:${invId}:+30`)
              .text(msgs.invite_propose_plus60, `${CB.INVITATION_ACTION}:propose:${invId}:+60`);
            await ctx.message?.send(msgs.invite_propose_ask, { reply_markup: quickKeyboard });
          }
          return;
        }

        if (subAction === 'reschedule') {
          const reschedResult = invitationService.rescheduleFromProposal(invId, user.telegram_id);
          if (!reschedResult.success) {
            await ctx.answer({ text: reschedResult.error ?? 'Error' });
            return;
          }
          const invitation = reschedResult.invitation!;
          const proposedTime = reschedResult.proposedTime!;
          const event = eventRepo?.findById(invitation.event_id, user.telegram_id);
          if (event && eventService) {
            const durationMs = event.end_at ? new Date(event.end_at).getTime() - new Date(event.start_at).getTime() : 0;
            const newEnd =
              durationMs > 0 ? new Date(new Date(proposedTime).getTime() + durationMs).toISOString() : undefined;
            eventService.updateEvent(event.id, user.telegram_id, {
              start_at: proposedTime,
              ...(newEnd ? { end_at: newEnd } : {}),
            });
          }
          const formattedTimeInviter = formatProposedTime(proposedTime, user.timezone, lang);
          await ctx.answer();
          await ctx
            .editText(t(lang).invite_rescheduled_inviter(formattedTimeInviter), { parse_mode: 'HTML' })
            .catch(() => {});
          if (invitationNotifyDeps) {
            const eventTitle = event?.title ?? `Event #${invitation.event_id}`;
            const inviteeUser = invitationNotifyDeps.userRepo.findByTelegramId(invitation.invitee_id);
            const inviteeLang = (inviteeUser?.language ?? 'en') as Lang;
            const inviteeTz = inviteeUser?.timezone ?? 'UTC';
            const formattedTimeInvitee = formatProposedTime(proposedTime, inviteeTz, inviteeLang);
            invitationNotifyDeps
              .sendMessage(
                invitation.invitee_id,
                t(inviteeLang).invite_rescheduled_invitee(eventTitle, formattedTimeInvitee),
                { parse_mode: 'HTML' },
              )
              .catch(() => {});
          }
          return;
        }

        if (subAction === 'dismiss') {
          const keepResult = invitationService.keepOriginalTime(invId, user.telegram_id);
          if (!keepResult.success) {
            await ctx.answer({ text: keepResult.error ?? 'Error' });
            return;
          }
          const invitation = keepResult.invitation!;
          const event = eventRepo?.findById(invitation.event_id, user.telegram_id);
          const inviteeUser = invitationNotifyDeps?.userRepo.findByTelegramId(invitation.invitee_id);
          const inviteeLang = (inviteeUser?.language ?? 'en') as Lang;
          const inviteeTz = inviteeUser?.timezone ?? 'UTC';
          const formattedOriginal = event?.start_at ? formatProposedTime(event.start_at, inviteeTz, inviteeLang) : '';
          await ctx.answer();
          await ctx.editText(t(lang).invite_kept_inviter, { parse_mode: 'HTML' }).catch(() => {});
          if (invitationNotifyDeps) {
            const eventTitle = event?.title ?? `Event #${invitation.event_id}`;
            invitationNotifyDeps
              .sendMessage(invitation.invitee_id, t(inviteeLang).invite_kept_invitee(eventTitle, formattedOriginal), {
                parse_mode: 'HTML',
              })
              .catch(() => {});
            if (invitationNotifyDeps.editMessage && invitation.message_id && invitation.chat_id) {
              const inviterUser = invitationNotifyDeps.userRepo.findByTelegramId(invitation.inviter_id);
              const inviterName = inviterUser?.first_name ?? inviterUser?.username ?? `#${invitation.inviter_id}`;
              const originalText = t(inviteeLang).invitation_received(eventTitle, inviterName);
              const keyboard = new InlineKeyboard()
                .text('Accept ✅', `${CB.INVITATION_ACTION}:accept:${invitation.id}`)
                .text('Decline ❌', `${CB.INVITATION_ACTION}:decline:${invitation.id}`)
                .row()
                .text('Maybe 🤔', `${CB.INVITATION_ACTION}:maybe:${invitation.id}`)
                .text(t(inviteeLang).invite_propose_btn, `${CB.INVITATION_ACTION}:propose:${invitation.id}`);
              invitationNotifyDeps
                .editMessage(invitation.chat_id, invitation.message_id, originalText, keyboard)
                .catch(() => {});
            }
          }
          return;
        }

        let result: { success: boolean; error?: string } | undefined;
        if (subAction === 'accept') {
          result = invitationService.acceptInvitation(invId, user.telegram_id);
        } else if (subAction === 'decline') {
          result = invitationService.declineInvitation(invId, user.telegram_id);
        } else if (subAction === 'maybe') {
          result = invitationService.maybeInvitation(invId, user.telegram_id);
        }

        if (!result) {
          await ctx.answer();
          return;
        }

        if (result.success) {
          const statusEmoji = subAction === 'accept' ? '✅' : subAction === 'decline' ? '❌' : '🤔';
          const statusLabel =
            subAction === 'accept'
              ? t(lang).invitation_accepted
              : subAction === 'decline'
                ? t(lang).invitation_declined
                : t(lang).invitation_maybe;
          await ctx.answer(statusLabel);

          const event = eventRepo?.findById(result.invitation?.event_id ?? 0, result.invitation?.inviter_id ?? 0);
          const eventCard = event ? formatEventDetail(event, event.timezone, lang) : '';
          const editText = eventCard ? `${statusEmoji} ${statusLabel}\n\n${eventCard}` : statusLabel;
          await ctx.editText(editText, { parse_mode: 'HTML' }).catch(() => {});

          // Notify inviter about the response
          if (invitationNotifyDeps && result.invitation) {
            notifyInviter(
              result.invitation,
              subAction as 'accept' | 'decline' | 'maybe',
              user,
              invitationNotifyDeps,
              eventRepo,
            ).catch(() => {});
          }

          // Start onboarding if not completed
          if (!user.onboarding_completed && onboardingScene) {
            await ctx.scene.enter(onboardingScene);
          }
        } else {
          await ctx.answer(result.error ?? 'Error');
        }
        return;
      }

      // Edit proposal accept/reject
      if (action === CB.EDIT_PROPOSAL && editProposalDeps) {
        const subAction = parts[1];
        const proposalId = Number(parts[2]);
        const proposal = editProposalDeps.editProposalRepo.findById(proposalId);

        if (!proposal) {
          await ctx.answer({ text: 'Proposal not found' });
          return;
        }

        if (proposal.status !== 'pending') {
          await ctx.answer({ text: `Already ${proposal.status}` });
          return;
        }

        const ownerId = eventService.getEventOwnerId(proposal.event_id);
        if (!ownerId) {
          await ctx.answer({ text: 'Not found' });
          return;
        }
        if (ownerId !== user.telegram_id) {
          await ctx.answer({ text: 'Not authorized' });
          return;
        }

        if (subAction === 'accept') {
          const changes = JSON.parse(proposal.changes) as UpdateEventData;
          const updated = eventService.updateEvent(proposal.event_id, user.telegram_id, changes);
          editProposalDeps.editProposalRepo.updateStatus(proposalId, 'accepted');
          await ctx.answer();
          await ctx.editText(
            updated ? `✅ Proposal accepted. Event "${updated.title}" updated.` : '✅ Proposal accepted.',
          );

          editProposalDeps
            .sendMessage(proposal.proposer_id, `✅ Your edit proposal was accepted.`, { parse_mode: 'HTML' })
            .catch(() => {});
        } else if (subAction === 'reject') {
          editProposalDeps.editProposalRepo.updateStatus(proposalId, 'rejected');
          await ctx.answer();
          await ctx.editText('❌ Proposal rejected.');

          editProposalDeps
            .sendMessage(proposal.proposer_id, `❌ Your edit proposal was rejected.`, { parse_mode: 'HTML' })
            .catch(() => {});
        }
        return;
      }

      // Group agenda pagination
      if (action === CB.GROUP_AGENDA && groupChatRepo && eventRepo) {
        return handleGroupAgendaCallback(ctx, groupChatRepo, eventRepo, Number(payload));
      }

      // AI ask_user button responses — save answer and trigger AI continuation
      if (action === 'ai_btn') {
        // Callback data format: "ai_btn:{text}" or "ai_btn:{userId}:{text}" (groups)
        // Check if the second segment is a numeric userId (group restriction)
        const firstColon = data.indexOf(':');
        const rest = data.slice(firstColon + 1);
        const secondColon = rest.indexOf(':');
        let answerText: string;
        let restrictedToUserId: number | undefined;

        if (secondColon !== -1 && /^\d+$/.test(rest.slice(0, secondColon))) {
          restrictedToUserId = Number(rest.slice(0, secondColon));
          answerText = rest.slice(secondColon + 1);
        } else {
          answerText = rest;
        }

        // In groups, only the user who triggered the question can answer
        const clickerId = (ctx as unknown as { from?: { id: number } }).from?.id ?? user.telegram_id;
        if (restrictedToUserId !== undefined && clickerId !== restrictedToUserId) {
          await ctx.answer({ text: 'Не твой вопрос', show_alert: false });
          return;
        }

        await ctx.answer();
        await ctx.editText(`✅ ${answerText}`);
        // answerText is saved by agent.run() → saveUserMessage() — do not save here to avoid duplicates
        const cbChatId =
          (ctx as unknown as { chat?: { id: number } }).chat?.id ??
          (ctx as unknown as { message?: { chat?: { id: number } } }).message?.chat?.id;
        if (onAiButtonClick && cbChatId) {
          onAiButtonClick(user.telegram_id, cbChatId, answerText).catch((e) => {
            cmdLogger.error({ error: String(e) }, 'AI button continuation failed');
          });
        }
        return;
      }

      // Share navigator callbacks
      if (action === CB.SHARE_EVENT) {
        const lang = (user.language ?? 'en') as Lang;
        const subParts = payload.split(':');
        const subAction = subParts[0]!;

        if (subAction === 'today' || subAction === 'tomorrow' || subAction === 'week') {
          const date = new Date();
          if (subAction === 'tomorrow') date.setDate(date.getDate() + 1);

          const occurrences =
            subAction === 'week'
              ? eventService.getEventsForWeek(user.telegram_id, date, user.timezone)
              : eventService.getEventsForDay(user.telegram_id, date, user.timezone);

          if (occurrences.length === 0) {
            await ctx.answer();
            return ctx.editText(t(lang).no_events_to_share);
          }

          const agenda = formatDayAgenda(occurrences, date.toISOString(), user.timezone, lang);
          const hint = lang === 'ru' ? '↗️ Перешлите это сообщение' : '↗️ Forward this message';
          await ctx.answer();
          await ctx.editText(lang === 'ru' ? '✅ Отправлено ниже' : '✅ Sent below');
          if (ctx.message) {
            await ctx.message.send(`${agenda}\n\n${hint}`, { parse_mode: 'HTML' });
          }
          return;
        }

        if (subAction === 'evt') {
          const eventId = Number(subParts[1]);
          const event = eventService.getEvent(eventId, user.telegram_id);
          if (!event) return ctx.answer({ text: 'Not found' });
          const detail = formatEventDetail(event, user.timezone, lang);
          const hint = lang === 'ru' ? '↗️ Перешлите это сообщение' : '↗️ Forward this message';
          await ctx.answer();
          await ctx.editText(lang === 'ru' ? '✅ Отправлено ниже' : '✅ Sent below');
          if (ctx.message) {
            await ctx.message.send(`${detail}\n\n${hint}`, { parse_mode: 'HTML' });
          }
          return;
        }

        await ctx.answer();
        return;
      }

      // Invite: user picked an event → show contact picker
      if (action === CB.INVITE_PICK) {
        if (payload === 'cancel') {
          await ctx.answer();
          await ctx.editText(lang === 'ru' ? '❌ Отменено' : '❌ Cancelled');
          return;
        }
        const eventId = Number(payload);
        const event = eventService.getEvent(eventId, user.telegram_id);
        if (!event) return ctx.answer({ text: 'Not found' });
        await ctx.answer();
        const contacts = contactRepo ? contactRepo.list(user.telegram_id) : [];
        await ctx.editText(
          lang === 'ru'
            ? `📨 Приглашение на: <b>${event.title}</b>\nВыберите кого пригласить:`
            : `📨 Inviting to: <b>${event.title}</b>\nChoose who to invite:`,
          { parse_mode: 'HTML', reply_markup: inviteContactPickerKeyboard(contacts, eventId, lang) },
        );
        return;
      }

      // Invite contact — invc:{eventId}:{telegramId|picker|chat|cancel}
      if (action === CB.INVITE_CONTACT) {
        const invLang = (user.language ?? 'en') as Lang;
        if (payload === 'cancel') {
          await ctx.answer();
          await ctx.editText(invLang === 'ru' ? '❌ Отменено' : '❌ Cancelled');
          return;
        }
        const colonIdx = payload.indexOf(':');
        const eventId = Number(payload.slice(0, colonIdx));
        const sub = payload.slice(colonIdx + 1);

        if (sub === 'picker' || sub === 'chat') {
          const event = eventService.getEvent(eventId, user.telegram_id);
          if (!event) {
            await ctx.answer({ text: 'Not found' });
            return;
          }
          await ctx.answer();
          await ctx.editText(
            invLang === 'ru' ? `📨 ${event.title}\nВыберите контакт:` : `📨 ${event.title}\nPick a contact:`,
            { parse_mode: 'HTML' },
          );
          const { Keyboard } = await import('gramio');
          if (sub === 'picker') {
            const kb = new Keyboard()
              .requestUsers(invLang === 'ru' ? '👤 Выбрать пользователя' : '👤 Select user', eventId, {
                user_is_bot: false,
                max_quantity: 10,
                request_name: true,
                request_username: true,
              })
              .resized()
              .oneTime();
            await ctx.send(invLang === 'ru' ? 'Нажмите кнопку ниже:' : 'Tap button below:', { reply_markup: kb });
          } else {
            const kb = new Keyboard()
              .requestChat(invLang === 'ru' ? '👥 Выбрать группу' : '👥 Select group', eventId, {
                chat_is_channel: false,
              })
              .resized()
              .oneTime();
            await ctx.send(invLang === 'ru' ? 'Нажмите кнопку ниже:' : 'Tap button below:', { reply_markup: kb });
          }
          return;
        }

        // sub = telegramId — send invitation to known contact
        if (forceInviteDeps) {
          const inviteeId = Number(sub);
          const ownerId = eventService.getEventOwnerId(eventId);
          if (!ownerId) {
            await ctx.answer({ text: 'Not found' });
            return;
          }
          if (ownerId !== user.telegram_id) {
            await ctx.answer({ text: 'Not authorized' });
            return;
          }
          const event = eventService.getEvent(eventId, user.telegram_id);
          const eventTitle = event?.title ?? `Event #${eventId}`;
          const inviterName = user.first_name ?? user.username ?? `User ${user.telegram_id}`;
          const result = forceInviteDeps.invitationService.sendInvitation(eventId, user.telegram_id, inviteeId);
          if (!result.success || !result.invitation) {
            await ctx.answer({ text: result.error ?? 'Error' });
            return;
          }
          const invitation = result.invitation;
          const inviteeText = t(invLang).invitation_received(eventTitle, inviterName);
          const kb = new InlineKeyboard()
            .text('Accept ✅', `${CB.INVITATION_ACTION}:accept:${invitation.id}`)
            .text('Decline ❌', `${CB.INVITATION_ACTION}:decline:${invitation.id}`)
            .row()
            .text('Maybe 🤔', `${CB.INVITATION_ACTION}:maybe:${invitation.id}`);
          await ctx.answer();
          await ctx.editText(t(invLang).invite_delivered(eventTitle), { parse_mode: 'HTML' });
          forceInviteDeps
            .sendMessage(inviteeId, inviteeText, { parse_mode: 'HTML', reply_markup: kb })
            .then((sent) => {
              forceInviteDeps.invRepo.setMessageInfo(invitation.id, sent.message_id, inviteeId);
            })
            .catch((err: unknown) => {
              cmdLogger.error({ error: String(err), inviteeId }, 'Invite contact send failed');
            });
        } else {
          await ctx.answer({ text: 'Not configured' });
        }
        return;
      }

      // Unshare: user picked an event to remove from group — unsp:{eventId|cancel}
      if (action === CB.UNSHARE_PICK && groupChatRepo) {
        if (payload === 'cancel') {
          await ctx.answer();
          await ctx.editText(lang === 'ru' ? '❌ Отменено' : '❌ Cancelled');
          return;
        }
        const eventId = Number(payload);
        const chat = (ctx as unknown as { chat?: { id: number } }).chat;
        if (!chat) {
          await ctx.answer();
          return;
        }
        const removed = groupChatRepo.unshareEvent(chat.id, eventId, user.telegram_id);
        await ctx.answer();
        await ctx.editText(
          removed
            ? lang === 'ru'
              ? '✅ Событие убрано из группы'
              : '✅ Event removed from group'
            : lang === 'ru'
              ? '❌ Событие не найдено'
              : '❌ Event not found',
        );
        return;
      }

      // Invite force — callback: "inv_force:{eventId}:{inviteeIds}"
      if (action === CB.INV_FORCE && forceInviteDeps) {
        const invLang = (user.language ?? 'en') as Lang;
        const colonIdx = payload.indexOf(':');
        const eventId = Number(payload.slice(0, colonIdx));
        const inviteeIdsStr = payload.slice(colonIdx + 1);

        // Security: verify user is event owner
        const ownerId = eventService.getEventOwnerId(eventId);
        if (!ownerId) {
          await ctx.answer({ text: 'Not found' });
          return;
        }
        if (ownerId !== user.telegram_id) {
          await ctx.answer({ text: 'Not authorized' });
          return;
        }

        const inviteeIds = inviteeIdsStr.split(',').map(Number).filter(Boolean);
        const eventForInv = eventService.getEvent(eventId, user.telegram_id);
        const eventTitle = eventForInv?.title ?? `Event #${eventId}`;
        const inviterName = user.first_name ?? user.username ?? `User ${user.telegram_id}`;

        await ctx.answer();
        await ctx.editText(invLang === 'ru' ? '⏳ Отправляем приглашения...' : '⏳ Sending invitations...');

        for (const inviteeId of inviteeIds) {
          const result = forceInviteDeps.invitationService.sendInvitation(eventId, user.telegram_id, inviteeId);
          if (!result.success || !result.invitation) continue;

          const invitation = result.invitation;
          const inviteeText = t(invLang).invitation_received(eventTitle, inviterName);
          const kb = new InlineKeyboard()
            .text('Accept ✅', `${CB.INVITATION_ACTION}:accept:${invitation.id}`)
            .text('Decline ❌', `${CB.INVITATION_ACTION}:decline:${invitation.id}`)
            .row()
            .text('Maybe 🤔', `${CB.INVITATION_ACTION}:maybe:${invitation.id}`);

          forceInviteDeps
            .sendMessage(inviteeId, inviteeText, { parse_mode: 'HTML', reply_markup: kb })
            .then((sent) => {
              forceInviteDeps.invRepo.setMessageInfo(invitation.id, sent.message_id, inviteeId);
            })
            .catch((err: unknown) => {
              cmdLogger.error({ error: String(err), inviteeId }, 'Force invite send failed');
            });
        }

        await ctx.editText(t(invLang).invite_delivered(eventTitle), { parse_mode: 'HTML' });
        return;
      }

      // Invite retime — prompt to change event time
      if (action === CB.INV_RETIME) {
        const invLang = (user.language ?? 'en') as Lang;
        const eventId = Number(payload);
        const ownerId = eventService.getEventOwnerId(eventId);
        if (!ownerId) {
          await ctx.answer({ text: 'Not found' });
          return;
        }
        if (ownerId !== user.telegram_id) {
          await ctx.answer({ text: 'Not authorized' });
          return;
        }
        await ctx.answer();
        await ctx.editText(
          invLang === 'ru'
            ? '🕐 Используйте /edit чтобы изменить время события, затем повторите приглашение.'
            : '🕐 Use /edit to change the event time, then resend the invitation.',
        );
        return;
      }

      // Invite cancel
      if (action === CB.INV_CANCEL) {
        const invLang = (user.language ?? 'en') as Lang;
        await ctx.answer();
        await ctx.editText(invLang === 'ru' ? 'Приглашение отменено ❌' : 'Invitation cancelled ❌');
        return;
      }

      // Feature tour
      if (action === CB.FEATURE_TOUR) {
        return handleFeatureTourCallback(ctx, payload);
      }

      // Settings category picker
      if (action === 'stg') {
        return handleSettingsCallback(
          ctx,
          user,
          payload,
          prefsService,
          callSettingsRepo,
          sharingSettingsRepo,
          userRepo,
        );
      }

      // Feedback: admin closes a thread
      if (action === 'fb_close' && feedbackDeps) {
        if (feedbackDeps.adminId && user.telegram_id !== feedbackDeps.adminId) {
          await ctx.answer({ text: 'Not authorized' });
          return;
        }
        const threadId = Number(payload);
        const thread = feedbackDeps.feedbackRepo.getThread(threadId);
        if (!thread) {
          await ctx.answer({ text: 'Thread not found' });
          return;
        }
        feedbackDeps.feedbackRepo.closeThread(threadId);
        await ctx.answer({ text: 'Thread closed' });
        await ctx.editText(`✅ Thread #${threadId} closed`).catch(() => {});
        feedbackDeps.sendMessage(thread.user_id, 'Your feedback thread has been resolved.').catch((e: unknown) => {
          cmdLogger.error({ error: String(e) }, 'Failed to notify user of thread close');
        });
        return;
      }

      // Feedback: admin initiates a reply
      if (action === 'fb_reply' && feedbackDeps) {
        if (feedbackDeps.adminId && user.telegram_id !== feedbackDeps.adminId) {
          await ctx.answer({ text: 'Not authorized' });
          return;
        }
        const threadId = Number(payload);
        const thread = feedbackDeps.feedbackRepo.getThread(threadId);
        if (!thread) {
          await ctx.answer({ text: 'Thread not found' });
          return;
        }
        feedbackDeps.adminReplySession.set(user.telegram_id, { threadId, userId: thread.user_id });
        await ctx.answer({ text: 'Send your reply message' });
        return;
      }

      // Voice response opt-in prompt response
      if (action === 'voice_prompt' && userRepo) {
        const enabled = payload === 'yes' ? 1 : 0;
        userRepo.update(user.telegram_id, { voice_response_enabled: enabled });
        await ctx.answer();

        const lang = (user.language ?? 'en') as Lang;
        const msgs = t(lang);

        if (!enabled) {
          await ctx.editText(msgs.voice_response_disabled);
          return;
        }

        // On opt-in: resend the last AI response as voice so user hears it immediately
        const isRu = user.language === 'ru';
        const chatIdNum = ctx.chatId ? Number(ctx.chatId) : null;
        const ruReady = isRu && voiceDeps?.sileroTts && voiceDeps?.stressDictionary;
        const enReady = !isRu && voiceDeps?.kokoroTts;

        if (!voiceDeps || !chatHistoryRepo || !chatIdNum || (!ruReady && !enReady)) {
          await ctx.editText(msgs.voice_response_enabled);
          return;
        }

        await ctx.editText('⌛');

        try {
          const recent = chatHistoryRepo.getRecent(user.telegram_id, 10);
          const lastAssistant = [...recent].reverse().find((m) => m.role === 'assistant');
          let responseText = '';
          if (lastAssistant) {
            try {
              const blocks = JSON.parse(lastAssistant.content) as { type: string; text?: string }[];
              responseText = Array.isArray(blocks)
                ? blocks
                    .filter((b) => b.type === 'text')
                    .map((b) => b.text ?? '')
                    .join('')
                : lastAssistant.content;
            } catch {
              responseText = lastAssistant.content;
            }
          }

          if (responseText.trim()) {
            const plainText = stripMarkdown(responseText);
            const noLineBreaks = fixLineBreaks(plainText);
            let audio: Buffer | undefined;
            if (isRu && voiceDeps.sileroTts) {
              const withOrdinals = fixDateOrdinals(noLineBreaks);
              const withNumbers = numbersToWords(withOrdinals);
              const withStress = markStress(withNumbers, voiceDeps.stressDictionary!);
              audio = await voiceDeps.sileroTts.synthesize(transliterateEnglish(withStress));
            } else if (!isRu && voiceDeps.kokoroTts) {
              audio = await voiceDeps.kokoroTts.synthesize(noLineBreaks);
            }
            if (audio) {
              await voiceDeps.sendVoice(chatIdNum, audio);
            }
          }
        } catch (err) {
          cmdLogger.error({ error: String(err) }, 'Voice opt-in TTS error');
        }

        await ctx.editText(msgs.voice_response_enabled);
        return;
      }

      // Intent verification: accept
      if (action === 'intent_accept' && intentDeps) {
        const intentId = Number(payload);
        intentDeps.intentRepo.updateStatus(intentId, 'approved');
        intentDeps.intentMatcher?.reload();
        await ctx.answer('Intent approved ✅');
        const currentText = (ctx as unknown as { message?: { text?: string } }).message?.text ?? '';
        await ctx.editText(`${currentText}\n\n✅ APPROVED`).catch(() => {});
        return;
      }

      // Intent verification: reject
      if (action === 'intent_reject' && intentDeps) {
        const intentId = Number(payload);
        intentDeps.intentRepo.updateStatus(intentId, 'rejected');
        await ctx.answer('Intent rejected ❌');
        const currentText = (ctx as unknown as { message?: { text?: string } }).message?.text ?? '';
        await ctx.editText(`${currentText}\n\n❌ REJECTED`).catch(() => {});
        return;
      }

      // Intent verification: edit — store admin edit session
      if (action === 'intent_edit' && intentDeps) {
        const intentId = Number(payload);
        if (intentDeps.adminEditSessions) {
          intentDeps.adminEditSessions.set(user.telegram_id, {
            intentId,
            state: 'awaiting_instructions',
            createdAt: Date.now(),
          });
        }
        await ctx.answer('Send edit instructions...');
        return;
      }

      // Secretary accept/decline
      if (data.startsWith('sec:accept:') && secretaryDeps) {
        const id = Number(data.slice('sec:accept:'.length));
        await handleSecretaryAccept(id, user.telegram_id, secretaryDeps);
        await ctx.answer();
        return;
      }
      if (data.startsWith('sec:decline:') && secretaryDeps) {
        const id = Number(data.slice('sec:decline:'.length));
        await handleSecretaryDecline(id, user.telegram_id, secretaryDeps);
        await ctx.answer();
        return;
      }

      if (data.startsWith('prop:accept:') && proposalDeps) {
        const id = Number(data.slice('prop:accept:'.length));
        await handleProposalAccept(id, user.telegram_id, proposalDeps);
        await ctx.answer();
        return;
      }
      if (data.startsWith('prop:decline:') && proposalDeps) {
        const id = Number(data.slice('prop:decline:'.length));
        await handleProposalDecline(id, user.telegram_id, proposalDeps);
        await ctx.answer();
        return;
      }

      // Snooze reminder — callback data: "snooze:{minutes}:{eventId}"
      if (action === 'snooze' && snoozeDeps) {
        const minutes = Number(parts[1]);
        const eventId = Number(parts[2]);
        await handleSnoozeCallback(
          ctx,
          user.telegram_id,
          eventId,
          minutes,
          snoozeDeps.reminderRepo,
          snoozeDeps.eventRepo,
        );
        return;
      }

      cmdLogger.warn({ action, payload }, 'Unknown callback action');
      await ctx.answer();
    } catch (error) {
      const errStr = String(error);
      // Duplicate click — message already updated, silently acknowledge
      if (errStr.includes('message is not modified')) {
        await ctx.answer().catch((e) => cmdLogger.debug({ error: String(e) }, 'answer() after duplicate click'));
        return;
      }
      cmdLogger.error({ error: errStr, action }, 'Callback handler error');
      await ctx
        .answer({ text: 'Error' })
        .catch((e) => cmdLogger.debug({ error: String(e) }, 'answer() in error handler'));
    }
  };
}

export interface SnoozeDeps {
  reminderRepo: Pick<EventReminderRepository, 'insert'>;
  eventRepo: Pick<EventRepository, 'findById'>;
}

export interface ForceInviteDeps {
  invitationService: InvitationService;
  invRepo: Pick<import('../../database/repositories/invitation.repository.ts').InvitationRepository, 'setMessageInfo'>;
  deepLinkService: import('../../services/sharing/deep-link-service.ts').DeepLinkService;
  sendMessage: (
    chatId: number,
    text: string,
    options: { parse_mode: string; reply_markup?: unknown },
  ) => Promise<{ message_id: number }>;
}

export interface SecretaryDeps {
  secretaryRepo: Pick<SecretaryRepository, 'findById' | 'updateStatus'>;
  userRepo: Pick<UserRepository, 'findByTelegramId'>;
  sendMessage: (chatId: number, text: string) => Promise<void>;
  editMessage: (chatId: number, messageId: number, text: string) => Promise<void>;
}

function formatUserRef(user: { first_name?: string | null; username?: string | null; telegram_id: number }): string {
  if (user.username) return `@${user.username}`;
  if (user.first_name) return user.first_name;
  return `User ${user.telegram_id}`;
}

export async function handleSecretaryAccept(id: number, callerId: number, deps: SecretaryDeps): Promise<void> {
  const record = deps.secretaryRepo.findById(id);
  if (!record || record.secretary_id !== callerId || record.status !== 'pending') return;

  deps.secretaryRepo.updateStatus(id, 'active');

  const secretary = deps.userRepo.findByTelegramId(record.secretary_id);
  const secretaryRef = secretary ? formatUserRef(secretary) : `User ${record.secretary_id}`;
  await deps.sendMessage(
    record.owner_id,
    `Пользователь ${secretaryRef} принял приглашение и теперь является секретарём твоего календаря.`,
  );

  if (record.dm_message_id !== null) {
    const owner = deps.userRepo.findByTelegramId(record.owner_id);
    const ownerRef = owner ? formatUserRef(owner) : `User ${record.owner_id}`;
    await deps.editMessage(
      record.secretary_id,
      record.dm_message_id,
      `✅ Принято. Ты теперь секретарь ${ownerRef}. Напиши мне, чтобы управлять её/его календарём.`,
    );
  }
}

export async function handleSecretaryDecline(id: number, callerId: number, deps: SecretaryDeps): Promise<void> {
  const record = deps.secretaryRepo.findById(id);
  if (!record || record.secretary_id !== callerId || record.status !== 'pending') return;

  deps.secretaryRepo.updateStatus(id, 'declined');

  const secretary = deps.userRepo.findByTelegramId(record.secretary_id);
  const secretaryRef = secretary ? formatUserRef(secretary) : `User ${record.secretary_id}`;
  await deps.sendMessage(record.owner_id, `${secretaryRef} отклонил приглашение секретаря.`);

  if (record.dm_message_id !== null) {
    await deps.editMessage(record.secretary_id, record.dm_message_id, 'Приглашение отклонено.');
  }
}

export interface ProposalDeps {
  proposalRepo: Pick<CalendarProposalRepository, 'findById' | 'updateStatus'>;
  eventService: {
    createEvent: (userId: number, data: Omit<CreateEventData, 'user_id'>) => { id: number; title?: string } | null;
    updateEvent: (id: number, userId: number, data: UpdateEventData) => { id: number } | null;
    deleteEvent: (id: number, userId: number) => boolean;
  };
  userRepo: Pick<UserRepository, 'findByTelegramId'>;
  sendMessage: (chatId: number, text: string) => Promise<void>;
  editMessage: (chatId: number, messageId: number, text: string) => Promise<void>;
}

export async function handleProposalAccept(id: number, callerId: number, deps: ProposalDeps): Promise<void> {
  const proposal = deps.proposalRepo.findById(id);
  if (!proposal || proposal.target_id !== callerId) return;

  if (proposal.status !== 'pending') {
    if (proposal.dm_message_id !== null) {
      await deps.editMessage(proposal.target_id, proposal.dm_message_id, 'Предложение истекло или уже обработано.');
    }
    return;
  }

  const payloadData = JSON.parse(proposal.payload) as {
    action: string;
    event?: Omit<CreateEventData, 'user_id'>;
    event_id?: number;
    changes?: UpdateEventData;
  };

  let result: { id: number; title?: string } | boolean | null | undefined;
  if (proposal.action === 'create' && payloadData.event) {
    result = deps.eventService.createEvent(proposal.target_id, payloadData.event);
  } else if (proposal.action === 'update' && payloadData.event_id !== undefined && payloadData.changes) {
    result = deps.eventService.updateEvent(payloadData.event_id, proposal.target_id, payloadData.changes);
  } else if (proposal.action === 'delete' && payloadData.event_id !== undefined) {
    result = deps.eventService.deleteEvent(payloadData.event_id, proposal.target_id);
  }

  if (result === null || result === undefined || result === false) {
    deps.proposalRepo.updateStatus(id, 'expired');
    await deps.sendMessage(proposal.target_id, 'Событие больше не существует — предложение аннулировано.');
    await deps.sendMessage(proposal.proposer_id, 'Событие больше не существует — предложение аннулировано.');
    return;
  }

  const proposer = deps.userRepo.findByTelegramId(proposal.proposer_id);
  const proposerRef = proposer ? formatUserRef(proposer) : `User ${proposal.proposer_id}`;
  const target = deps.userRepo.findByTelegramId(proposal.target_id);
  const targetRef = target ? formatUserRef(target) : `User ${proposal.target_id}`;

  if (proposal.dm_message_id !== null) {
    await deps.editMessage(
      proposal.target_id,
      proposal.dm_message_id,
      '✅ Принято. Изменение применено к твоему календарю.',
    );
  }

  if (proposal.group_message_id !== null) {
    await deps.editMessage(
      proposal.group_chat_id,
      proposal.group_message_id,
      `✅ ${targetRef} принял(а) предложение от ${proposerRef}: ${proposal.summary}`,
    );
  }

  deps.proposalRepo.updateStatus(id, 'accepted');
  await deps.sendMessage(proposal.proposer_id, `✅ ${targetRef} принял(а) твоё предложение: ${proposal.summary}`);
}

export async function handleProposalDecline(id: number, callerId: number, deps: ProposalDeps): Promise<void> {
  const proposal = deps.proposalRepo.findById(id);
  if (!proposal || proposal.target_id !== callerId) return;

  deps.proposalRepo.updateStatus(id, 'declined');

  const proposer = deps.userRepo.findByTelegramId(proposal.proposer_id);
  const proposerRef = proposer ? formatUserRef(proposer) : `User ${proposal.proposer_id}`;
  const target = deps.userRepo.findByTelegramId(proposal.target_id);
  const targetRef = target ? formatUserRef(target) : `User ${proposal.target_id}`;

  if (proposal.dm_message_id !== null) {
    await deps.editMessage(proposal.target_id, proposal.dm_message_id, 'Предложение отклонено.');
  }

  if (proposal.group_message_id !== null) {
    await deps.editMessage(
      proposal.group_chat_id,
      proposal.group_message_id,
      `❌ ${targetRef} отклонил(а) предложение от ${proposerRef}: ${proposal.summary}`,
    );
  }

  await deps.sendMessage(proposal.proposer_id, `❌ ${targetRef} отклонил(а) твоё предложение: ${proposal.summary}`);
}

async function notifyInviterProposal(
  invitation: Invitation,
  respondent: User,
  formattedTime: string,
  eventTitle: string,
  deps: {
    userRepo: UserRepository;
    sendMessage: (
      chatId: number,
      text: string,
      options: { parse_mode: string; reply_markup?: unknown },
    ) => Promise<void>;
  },
): Promise<void> {
  const inviter = deps.userRepo.findByTelegramId(invitation.inviter_id);
  if (!inviter) return;
  const inviterLang = (inviter.language ?? 'en') as Lang;
  const name = respondent.first_name ?? respondent.username ?? `#${respondent.telegram_id}`;
  const text = t(inviterLang).invite_propose_notify(name, eventTitle, formattedTime);
  const keyboard = new InlineKeyboard()
    .text(t(inviterLang).invite_reschedule_btn, `${CB.INVITATION_ACTION}:reschedule:${invitation.id}`)
    .text(t(inviterLang).invite_keep_btn, `${CB.INVITATION_ACTION}:dismiss:${invitation.id}`);
  await deps.sendMessage(invitation.inviter_id, text, { parse_mode: 'HTML', reply_markup: keyboard });
}

async function notifyInviter(
  invitation: Invitation,
  action: 'accept' | 'decline' | 'maybe',
  respondent: User,
  deps: {
    userRepo: UserRepository;
    sendMessage: (chatId: number, text: string, options: { parse_mode: string }) => Promise<void>;
  },
  eventRepo?: EventRepository,
): Promise<void> {
  const inviter = deps.userRepo.findByTelegramId(invitation.inviter_id);
  if (!inviter) return;

  const inviterLang = (inviter.language ?? 'en') as Lang;
  const msgs = t(inviterLang);
  const respondentName = respondent.first_name ?? respondent.username ?? `#${respondent.telegram_id}`;

  const event = eventRepo?.findById(invitation.event_id, invitation.inviter_id);
  const eventTitle = event?.title ?? `Event #${invitation.event_id}`;

  const text =
    action === 'accept'
      ? msgs.invitation_response_accepted(respondentName, eventTitle)
      : action === 'decline'
        ? msgs.invitation_response_declined(respondentName, eventTitle)
        : msgs.invitation_response_maybe(respondentName, eventTitle);

  await deps.sendMessage(invitation.inviter_id, text, { parse_mode: 'HTML' });
}
