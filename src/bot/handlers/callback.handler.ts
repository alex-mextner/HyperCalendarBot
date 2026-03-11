// src/bot/handlers/callback.handler.ts
import type { DatabaseService } from '../../database/index.ts';
import type { EventService } from '../../services/event/event-service.ts';
import type { User } from '../../database/types.ts';
import { CB } from '../../config/constants.ts';
import { handleOnboardingCallback } from '../commands/start.ts';
import { handleEditCallback, handleEditFieldCallback } from '../commands/edit.ts';
import { handleDeleteCallback, handleDeleteConfirmCallback } from '../commands/delete.ts';
import { handleMonth } from '../commands/month.ts';
import { formatEventDetail } from '../../services/event/formatters.ts';
import { eventActionsKeyboard, editFieldKeyboard } from '../keyboards.ts';
import { cmdLogger } from '../../utils/logger.ts';

/**
 * Route all inline keyboard callbacks.
 * Callback data format: "prefix:payload" or "prefix:p1:p2"
 */
export function createCallbackHandler(db: DatabaseService, eventService: EventService) {
  return async (ctx: any) => {
    const data = ctx.data as string;
    if (!data) return;

    const user = ctx.dbUser as User;
    const parts = data.split(':');
    const action = parts[0]!;
    const payload = parts.slice(1).join(':');

    try {
      // Onboarding actions
      if ([CB.ONBOARD_LANG, CB.ONBOARD_TZ_REGION, CB.ONBOARD_TZ, CB.ONBOARD_COUNTRY, CB.ONBOARD_AGENDA].includes(action)) {
        return handleOnboardingCallback(ctx, db, action, payload);
      }

      // Event view
      if (action === CB.EVENT_VIEW) {
        if (payload === 'cancel') return ctx.editText('OK');
        const eventId = Number(payload);
        const event = eventService.getEvent(eventId, user.telegram_id);
        if (!event) return ctx.answer({ text: 'Not found' });
        const detail = formatEventDetail(event, user.timezone, user.language);
        return ctx.editText(detail, {
          parse_mode: 'HTML',
          reply_markup: eventActionsKeyboard(eventId, user.language as 'en' | 'ru'),
        });
      }

      // Event edit
      if (action === CB.EVENT_EDIT) {
        if (payload === 'cancel') return ctx.editText('OK');
        return handleEditCallback(ctx, eventService, user, Number(payload));
      }

      // Edit field
      if (action === CB.EDIT_FIELD) {
        const [eidStr, field] = payload.split(':');
        if (field === 'cancel' || eidStr === 'cancel') return ctx.editText('OK');
        return handleEditFieldCallback(ctx, eventService, user, Number(eidStr), field!);
      }

      // Event delete
      if (action === CB.EVENT_DELETE) {
        if (payload === 'cancel') return ctx.editText('OK');
        return handleDeleteCallback(ctx, eventService, user, Number(payload));
      }

      // Delete confirm
      if (action === CB.EVENT_DELETE_CONFIRM) {
        return handleDeleteConfirmCallback(ctx, eventService, user, Number(payload));
      }

      // Recurring event edit/delete choice (this / future / all)
      if (action === CB.EVENT_RECURRENCE) {
        const [eidStr, mode] = payload.split(':');
        const eventId = Number(eidStr);
        const lang = (user.language ?? 'en') as 'en' | 'ru';

        if (mode === 'all') {
          // Edit the template (all occurrences)
          return ctx.editText(
            lang === 'ru' ? 'Что изменить?' : 'What to edit?',
            { reply_markup: editFieldKeyboard(eventId, lang) },
          );
        }

        // 'this' and 'future' require occurrence-level context — not yet implemented
        await ctx.answer({
          text: lang === 'ru' ? 'Будет в следующей версии' : 'Coming in next version',
        });
        return;
      }

      // Month navigation
      if (action === CB.MONTH_NAV) {
        return handleMonth(ctx, eventService, payload);
      }

      cmdLogger.warn({ action, payload }, 'Unknown callback action');
      await ctx.answer();
    } catch (error) {
      cmdLogger.error({ error: String(error), action }, 'Callback handler error');
      await ctx.answer({ text: 'Error' });
    }
  };
}
