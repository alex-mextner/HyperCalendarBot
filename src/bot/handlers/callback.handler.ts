// src/bot/handlers/callback.handler.ts

import { TZDate } from '@date-fns/tz';
import type { AnyScene } from '@gramio/scenes';
import type { Lang } from '../../config/constants.ts';
import { CB, t } from '../../config/constants.ts';
import type { EventRepository } from '../../database/repositories/event.repository.ts';
import type { GoogleCalendarRepository } from '../../database/repositories/google-calendar.repository.ts';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatEventDetail } from '../../services/event/formatters.ts';
import type { HolidayService } from '../../services/holiday/holiday-service.ts';
import { mapDailyAgendaData, mapWeeklyOverviewData } from '../../services/image/data-mapper.ts';
import type { RenderService } from '../../services/image/render-service.ts';
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
import { handleNotifyCallback } from '../commands/notify.ts';
import { editFieldKeyboard, eventActionsKeyboard } from '../keyboards.ts';
import type { BotCallbackContext } from '../types.ts';

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
            await ctx.answer({ text: t(lang).gcal_connect_prompt });
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
          const statusText =
            subAction === 'accept'
              ? t(lang).invitation_accepted
              : subAction === 'decline'
                ? t(lang).invitation_declined
                : t(lang).invitation_maybe;
          await ctx.answer(statusText);
          await ctx.editText(statusText).catch(() => {});
        } else {
          await ctx.answer(result.error ?? 'Error');
        }
        return;
      }

      // Group agenda pagination
      if (action === CB.GROUP_AGENDA && groupChatRepo && eventRepo) {
        return handleGroupAgendaCallback(ctx, groupChatRepo, eventRepo, Number(payload));
      }

      // Feature tour
      if (action === CB.FEATURE_TOUR) {
        return handleFeatureTourCallback(ctx, payload);
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
