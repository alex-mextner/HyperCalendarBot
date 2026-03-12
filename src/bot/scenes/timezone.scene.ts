// src/bot/scenes/timezone.scene.ts
import { Scene } from '@gramio/scenes';
import { CB } from '../../config/constants.ts';
import type { DatabaseService } from '../../database/index.ts';
import { getTimezoneDisplay, resolveTimezone } from '../../services/timezone/timezone-service.ts';
import { timezoneCitiesKeyboard, timezoneManualKeyboard, timezoneMethodKeyboard } from '../keyboards.ts';
import { getSceneUser } from './helpers.ts';

export function createTimezoneScene(db: DatabaseService) {
  return (
    new Scene('timezone')
      // onEnter sends prompts — because scene is entered from /timezone (message)
      // but step 0 is ["callback_query", "location"], so firstTime won't fire on entry
      .onEnter(async (context) => {
        const lang = getSceneLang(context);
        const user = getSceneUser(context);
        if (!user) return;

        const display = getTimezoneDisplay(user.timezone);
        const text =
          lang === 'ru'
            ? `\ud83c\udf0d Текущий часовой пояс: ${display}\n\nИзменить?`
            : `\ud83c\udf0d Current timezone: ${display}\n\nChange it?`;

        await context.send(text, { reply_markup: timezoneManualKeyboard() });
        await context.send(lang === 'ru' ? 'Или отправьте геолокацию:' : 'Or share your location:', {
          reply_markup: timezoneMethodKeyboard(lang),
        });
      })
      .step(['callback_query', 'location'], async (context) => {
        const user = getSceneUser(context);
        if (!user) {
          await context.scene.exit();
          return;
        }

        // Handle location
        if (context.is('location')) {
          const { latitude, longitude } = (
            context as unknown as { eventLocation: { latitude: number; longitude: number } }
          ).eventLocation;
          const tz = resolveTimezone(latitude, longitude);
          db.users.update(user.telegram_id, { timezone: tz });
          await context.scene.exit();
          await context.send(`\u2705 ${getTimezoneDisplay(tz)}`, {
            reply_markup: { remove_keyboard: true },
          });
          return;
        }

        // Handle callback_query
        if (context.is('callback_query')) {
          const data = (context as unknown as { data: string }).data;
          if (!data) return;

          const parts = data.split(':');
          const action = parts[0];
          const payload = parts.slice(1).join(':');
          const cbCtx = context as unknown as {
            answer: (opts?: Record<string, unknown>) => Promise<unknown>;
            editText: (text: string, opts?: Record<string, unknown>) => Promise<unknown>;
          };

          // Region selected -> show cities
          if (action === CB.ONBOARD_TZ_REGION) {
            await cbCtx.editText('Select city:', {
              reply_markup: timezoneCitiesKeyboard(payload),
            });
            await cbCtx.answer();
            return; // Stay on same step
          }

          // Timezone selected
          if (action === CB.ONBOARD_TZ) {
            db.users.update(user.telegram_id, { timezone: payload });
            await context.scene.exit();
            await context.send(`\u2705 ${getTimezoneDisplay(payload)}`, {
              reply_markup: { remove_keyboard: true },
            });
            await cbCtx.answer();
            return;
          }

          await cbCtx.answer();
        }
      })
  );
}
