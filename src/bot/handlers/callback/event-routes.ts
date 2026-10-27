// src/bot/handlers/callback/event-routes.ts
// Event view/edit/delete/recurrence, month navigation, notification, holiday, Google Calendar and snooze callbacks.

import { InlineKeyboard } from 'gramio';
import type { Lang } from '../../../config/constants.ts';
import { CB, t } from '../../../config/constants.ts';
import type { User } from '../../../database/types.ts';
import { enrichAgendaEvents } from '../../../services/event/agenda-enrichment.ts';
import { formatEventDetail } from '../../../services/event/formatters.ts';
import { withMapButton } from '../../../services/location/event-venue.ts';
import { editAgendaText } from '../../commands/agenda-text.ts';
import { buildCalendarPickerKeyboard, handleCalendarPickerCallback } from '../../commands/calendars.ts';
import { handleDeleteCallback, handleDeleteConfirmCallback } from '../../commands/delete.ts';
import { executeDisconnect } from '../../commands/disconnect-google.ts';
import { handleEditCallback, handleEditFieldCallback } from '../../commands/edit.ts';
import { handleHolidayCallback } from '../../commands/holidays.ts';
import { handleMonth } from '../../commands/month.ts';
import { getGroupId, isGroup } from '../../group-context.ts';
import { editFieldKeyboard, eventActionsKeyboard } from '../../keyboards.ts';
import type { BotCallbackContext } from '../../types.ts';
import { handleNotifyCallback } from '../notify-callback.ts';
import { handleSnoozeCallback } from '../snooze-callback.ts';
import type { CallbackDispatch, CallbackRouteDeps } from './types.ts';

export function registerEventRoutes(dispatch: CallbackDispatch, deps: CallbackRouteDeps): void {
  const { eventService, editValueScene, holidayService, prefsService } = deps;
  const { calendarRepo, disconnectDeps, onCalendarsDone, oauthDeps, snoozeDeps, triggerSync } = deps.opts;

  // Event view
  dispatch.set(CB.EVENT_VIEW, async (ctx, payload, _parts, user) => {
    if (payload === 'cancel') {
      await ctx.answer();
      return ctx.editText(t((user.language ?? 'en') as Lang).callbackErrors.closed);
    }
    const eventId = Number(payload);
    const event = eventService.getEvent(eventId, user.telegram_id);
    const lang = (user.language ?? 'en') as Lang;
    if (!event) return ctx.answer({ text: t(lang).callbackErrors.notFound });
    const detail = formatEventDetail(
      enrichAgendaEvents(
        [event],
        {
          userId: user.telegram_id,
          language: user.language as 'en' | 'ru',
          groupId: isGroup(ctx) ? (getGroupId(ctx) ?? undefined) : undefined,
        },
        eventService.agendaRepository,
      )[0]!,
      user.timezone,
      user.language,
    );
    await ctx.answer();
    return editAgendaText(ctx, detail, {
      parse_mode: 'HTML',
      reply_markup: withMapButton(eventActionsKeyboard(eventId, user.language as 'en' | 'ru'), event, lang),
    });
  });

  // Event edit — payload: "42" (one-off) or "42:2026-03-15T10:00:00Z" (recurring)
  dispatch.set(CB.EVENT_EDIT, async (ctx, payload, _parts, user) => {
    if (payload === 'cancel') {
      await ctx.answer();
      return ctx.editText(t((user.language ?? 'en') as Lang).callbackErrors.editCancelled);
    }
    const colonIdx = payload.indexOf(':');
    if (colonIdx === -1) {
      return handleEditCallback(ctx, eventService, user, Number(payload));
    }
    const eventId = Number(payload.slice(0, colonIdx));
    const occurrenceDate = payload.slice(colonIdx + 1);
    return handleEditCallback(ctx, eventService, user, eventId, occurrenceDate);
  });

  // Edit field
  dispatch.set(CB.EDIT_FIELD, async (ctx, payload, _parts, user) => {
    const [eidStr, field] = payload.split(':');
    if (field === 'cancel' || eidStr === 'cancel') {
      await ctx.answer();
      return ctx.editText(t((user.language ?? 'en') as Lang).callbackErrors.editCancelled);
    }
    return handleEditFieldCallback(ctx, user, Number(eidStr), field!, editValueScene);
  });

  // Event delete — payload: "42" or "42:2026-03-15T10:00:00Z"
  dispatch.set(CB.EVENT_DELETE, async (ctx, payload, _parts, user) => {
    if (payload === 'cancel') {
      await ctx.answer();
      return ctx.editText(t((user.language ?? 'en') as Lang).callbackErrors.deletionCancelled);
    }
    const colonIdx = payload.indexOf(':');
    if (colonIdx === -1) {
      return handleDeleteCallback(ctx, eventService, user, Number(payload));
    }
    const eventId = Number(payload.slice(0, colonIdx));
    const occurrenceDate = payload.slice(colonIdx + 1);
    return handleDeleteCallback(ctx, eventService, user, eventId, occurrenceDate);
  });

  // Delete confirm
  dispatch.set(CB.EVENT_DELETE_CONFIRM, async (ctx, payload, _parts, user) => {
    return handleDeleteConfirmCallback(ctx, eventService, user, Number(payload));
  });

  // Recurring event edit scope — er:{eventId}:{occurrenceDate}:{scope}
  dispatch.set(CB.EVENT_RECURRENCE, async (ctx, payload, _parts, user) => {
    const [eidStr, ...rest] = payload.split(':');
    const eventId = Number(eidStr);
    const scope = rest.pop(); // 'this' or 'future'
    const occurrenceDate = rest.join(':'); // ISO date contains ':'
    const lang = (user.language ?? 'en') as Lang;

    if (scope === 'this') {
      const exception = eventService.editOccurrence(eventId, occurrenceDate, user.telegram_id);
      if (!exception) return ctx.answer({ text: t(lang).callbackErrors.error });
      await ctx.answer();
      return editAgendaText(
        ctx,
        formatEventDetail(
          enrichAgendaEvents(
            [exception],
            {
              userId: user.telegram_id,
              language: lang,
              groupId: isGroup(ctx) ? (getGroupId(ctx) ?? undefined) : undefined,
            },
            eventService.agendaRepository,
          )[0]!,
          user.timezone,
          lang,
        ),
        {
          parse_mode: 'HTML',
          reply_markup: editFieldKeyboard(exception.id, lang),
        },
      );
    }

    if (scope === 'future') {
      const newTemplate = eventService.splitRecurrence(eventId, occurrenceDate, user.telegram_id);
      if (!newTemplate) return ctx.answer({ text: t(lang).callbackErrors.error });
      await ctx.answer();
      return editAgendaText(
        ctx,
        formatEventDetail(
          enrichAgendaEvents(
            [newTemplate],
            {
              userId: user.telegram_id,
              language: lang,
              groupId: isGroup(ctx) ? (getGroupId(ctx) ?? undefined) : undefined,
            },
            eventService.agendaRepository,
          )[0]!,
          user.timezone,
          lang,
        ),
        {
          parse_mode: 'HTML',
          reply_markup: editFieldKeyboard(newTemplate.id, lang),
        },
      );
    }

    await ctx.answer();
  });

  // Recurring event delete scope — erd:{eventId}:{occurrenceDate}:{scope}
  dispatch.set(CB.RECURRENCE_DELETE, async (ctx, payload, _parts, user) => {
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
  });

  // Month navigation
  dispatch.set(CB.MONTH_NAV, async (ctx, payload) => {
    await ctx.answer();
    return handleMonth(ctx, eventService, payload);
  });

  // Notifications
  dispatch.set(CB.NOTIFY, async (ctx, payload, _parts, user) => {
    return handleNotifyCallback(ctx, prefsService, user, payload);
  });

  // Holidays
  dispatch.set(CB.HOLIDAYS, async (ctx, payload, _parts, user) => {
    return handleHolidayCallback(ctx, holidayService, user, payload);
  });

  async function handleGcalCalendar(ctx: BotCallbackContext, user: User, lang: Lang, subPayload: string) {
    if (!calendarRepo) return;
    if (subPayload === 'open') {
      const calendars = calendarRepo.getCalendars(user.telegram_id);
      const keyboard = buildCalendarPickerKeyboard(calendars, lang);
      await ctx.answer();
      await ctx.send(t(lang).gcal_calendar_picker, { reply_markup: keyboard });
      return;
    }
    await handleCalendarPickerCallback(ctx, calendarRepo, user.telegram_id, subPayload, lang, onCalendarsDone);
  }

  async function handleGcalDisconnect(ctx: BotCallbackContext, user: User, lang: Lang, subPayload: string) {
    if (subPayload === 'yes' && disconnectDeps) {
      await executeDisconnect(user.telegram_id, disconnectDeps);
      await ctx.answer();
      await ctx.editText(t(lang).gcal_disconnected);
      return;
    }
    await ctx.answer();
    await ctx.editText(t(lang).callbackErrors.disconnectCancelled);
  }

  async function offerGcalConnect(ctx: BotCallbackContext, user: User, lang: Lang) {
    if (!oauthDeps) {
      await ctx.answer({ text: t(lang).gcal_connect_prompt });
      return;
    }
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
  }

  async function handleGcalOnboard(ctx: BotCallbackContext, user: User, lang: Lang, subPayload: string) {
    if (subPayload === 'later') {
      await ctx.answer();
      await ctx.message?.delete();
      return;
    }
    if (subPayload === 'connect') await offerGcalConnect(ctx, user, lang);
  }

  // Google Calendar callbacks
  dispatch.set(CB.GCAL, async (ctx, payload, _parts, user) => {
    const lang = (user.language ?? 'en') as Lang;
    const subParts = payload.split(':');
    const subAction = subParts[0];
    const subPayload = subParts.slice(1).join(':');

    if (subAction === 'sync') {
      await ctx.answer({ text: t(lang).gcal_status_sync_started });
      triggerSync?.(user.telegram_id).catch(() => {});
      return;
    }
    if (subAction === 'cal' && calendarRepo) return handleGcalCalendar(ctx, user, lang, subPayload);
    if (subAction === 'disconnect') return handleGcalDisconnect(ctx, user, lang, subPayload);
    if (subAction === 'onboard') return handleGcalOnboard(ctx, user, lang, subPayload);
  });

  // Snooze reminder — callback data: "snooze:{minutes}:{eventId}"
  dispatch.set('snooze', async (ctx, _payload, parts, user) => {
    if (!snoozeDeps) return;
    const minutes = Number(parts[1]);
    const eventId = Number(parts[2]);
    await handleSnoozeCallback(ctx, user.telegram_id, eventId, minutes, snoozeDeps.reminderRepo, snoozeDeps.eventRepo);
  });
}
