// src/bot/handlers/callback.handler.ts

import { TZDate } from '@date-fns/tz';
import type { AnyScene } from '@gramio/scenes';
import { InlineKeyboard } from 'gramio';
import type { Lang } from '../../config/constants.ts';
import { CB, t } from '../../config/constants.ts';
import type { CallSettingsRepository } from '../../database/repositories/call-settings.repository.ts';
import type { ChatHistoryRepository } from '../../database/repositories/chat-history.repository.ts';
import type { EditProposalRepository } from '../../database/repositories/edit-proposal.repository.ts';
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { FeedbackRepository } from '../../database/repositories/feedback.repository.ts';
import type { GoogleCalendarRepository } from '../../database/repositories/google-calendar.repository.ts';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { IntentRepository } from '../../database/repositories/intent.repository.ts';
import type { SharingSettingsRepository } from '../../database/repositories/sharing-settings.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { Invitation, UpdateEventData, User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatDayAgenda, formatEventDetail } from '../../services/event/formatters.ts';
import type { GoogleOAuthService } from '../../services/google/oauth.ts';
import type { HolidayService } from '../../services/holiday/holiday-service.ts';
import { mapDailyAgendaData, mapWeeklyOverviewData } from '../../services/image/data-mapper.ts';
import type { RenderService } from '../../services/image/render-service.ts';
import type { AdminEditSession } from '../../services/intent/admin-edit-session.ts';
import type { NotificationPreferencesService } from '../../services/notification/preferences.ts';
import type { InvitationService } from '../../services/sharing/invitation-service.ts';
import { getWeekRangeUtc } from '../../utils/date.ts';
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
import { editFieldKeyboard, eventActionsKeyboard } from '../keyboards.ts';
import type { BotCallbackContext } from '../types.ts';
import { handleNotifyCallback } from './notify-callback.ts';

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
    sendMessage: (chatId: number, text: string, options: { parse_mode: string }) => Promise<void>;
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
) {
  return async (ctx: BotCallbackContext) => {
    const data = ctx.data as string;
    if (!data) return;

    const user = ctx.dbUser as User;
    const parts = data.split(':');
    const action = parts[0]!;
    const payload = parts.slice(1).join(':');

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
        if (chatHistoryRepo) {
          chatHistoryRepo.save(user.telegram_id, 'user', answerText);
        }
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

      // Invite: user picked an event → open user picker
      if (action === CB.INVITE_PICK) {
        const eventId = Number(payload);
        const event = eventService.getEvent(eventId, user.telegram_id);
        if (!event) return ctx.answer({ text: 'Not found' });
        await ctx.answer();
        await ctx.editText(
          lang === 'ru'
            ? `📨 Приглашение на: <b>${event.title}</b>\nВыберите участников:`
            : `📨 Inviting to: <b>${event.title}</b>\nSelect participants:`,
          { parse_mode: 'HTML' },
        );
        // Send user picker with eventId as requestId
        if (ctx.message) {
          const { Keyboard } = await import('gramio');
          const kb = new Keyboard()
            .requestUsers(lang === 'ru' ? '👤 Выбрать участников' : '👤 Select participants', eventId, {
              user_is_bot: false,
              max_quantity: 10,
              request_name: true,
              request_username: true,
            })
            .resized()
            .oneTime();
          await ctx.message.send(lang === 'ru' ? 'Нажмите кнопку ниже:' : 'Tap button below:', {
            reply_markup: kb,
          });
        }
        return;
      }

      // Feature tour
      if (action === CB.FEATURE_TOUR) {
        return handleFeatureTourCallback(ctx, payload);
      }

      // Settings category picker
      if (action === 'stg') {
        return handleSettingsCallback(ctx, user, payload, prefsService, callSettingsRepo, sharingSettingsRepo);
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
        await ctx.editText(enabled ? '🎤 Голосовые ответы включены!' : '🎤 Ок, только текстом.');
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
