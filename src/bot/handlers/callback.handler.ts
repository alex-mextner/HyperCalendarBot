// src/bot/handlers/callback.handler.ts

import type { AnyScene } from '@gramio/scenes';
import type { Lang } from '../../config/constants.ts';
import { CB, t } from '../../config/constants.ts';
import type { User } from '../../database/types.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatEventDetail } from '../../services/event/formatters.ts';
import type { HolidayService } from '../../services/holiday/holiday-service.ts';
import { cmdLogger } from '../../utils/logger.ts';
import { handleDeleteCallback, handleDeleteConfirmCallback } from '../commands/delete.ts';
import { handleEditCallback, handleEditFieldCallback } from '../commands/edit.ts';
import { handleHolidayCallback } from '../commands/holidays.ts';
import { handleMonth } from '../commands/month.ts';
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

      // Holidays
      if (action === CB.HOLIDAYS) {
        return handleHolidayCallback(ctx, holidayService, user, payload);
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
