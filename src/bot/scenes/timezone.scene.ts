// src/bot/scenes/timezone.scene.ts
import { Scene } from '@gramio/scenes';
import { CB } from '../../config/constants.ts';
import type { DatabaseService } from '../../database/index.ts';
import { resolveCity } from '../../services/timezone/city-resolver.ts';
import { getTimezoneDisplay, resolveTimezone } from '../../services/timezone/timezone-service.ts';
import { removeKeyboard, timezoneConfirmKeyboard, timezoneMethodKeyboard } from '../keyboards.ts';
import { getSceneLang, getSceneUser } from './helpers.ts';

interface TimezoneState {
  detectedTz?: string;
}

export function createTimezoneScene(db: DatabaseService) {
  return new Scene('timezone')
    .state<TimezoneState>()
    .onEnter(async (context) => {
      const lang = getSceneLang(context);
      const user = getSceneUser(context);
      if (!user) return;

      const display = getTimezoneDisplay(user.timezone);
      const current = lang === 'ru' ? `🌍 Текущий: ${display}\n\n` : `🌍 Current: ${display}\n\n`;
      const prompt =
        lang === 'ru'
          ? `${current}В каком городе вы находитесь?\n\nПримеры: Белград, Belgrade, Нью-Йорк, бангкок, Алматы, київ`
          : `${current}What city are you in?\n\nExamples: Belgrade, New York, Bangkok, Almaty, Kyiv`;

      await context.send(prompt, { reply_markup: timezoneMethodKeyboard(lang) });
    })
    .step(['message', 'location', 'callback_query'], async (context) => {
      const user = getSceneUser(context);
      if (!user) {
        await context.scene.exit();
        return;
      }
      const lang = getSceneLang(context);

      // Handle typed city name
      if (context.is('message')) {
        const text = (context as unknown as { text?: string }).text?.trim();
        if (!text) return;
        const tz = await resolveCity(text);
        if (tz) {
          await context.send(`✅ ${getTimezoneDisplay(tz)}`, {
            reply_markup: timezoneConfirmKeyboard(lang),
          });
          await context.scene.update({ detectedTz: tz }, { step: undefined });
        } else {
          const msg =
            lang === 'ru'
              ? 'Не удалось определить таймзону. Попробуйте ещё раз или:\n• Отправьте 📍 геолокацию\n• Введите код напрямую, например: <code>Europe/Belgrade</code>\n  Список: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones'
              : 'Could not determine timezone. Try again or:\n• Share 📍 location\n• Enter code directly, e.g. <code>Europe/Belgrade</code>\n  Full list: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones';
          await context.send(msg, { parse_mode: 'HTML' });
        }
        return;
      }

      // Handle location
      if (context.is('location')) {
        const { latitude, longitude } = (
          context as unknown as { eventLocation: { latitude: number; longitude: number } }
        ).eventLocation;
        const tz = resolveTimezone(latitude, longitude);
        const display = getTimezoneDisplay(tz);
        await context.send(`✅ ${display}`, {
          ...removeKeyboard(),
          reply_markup: timezoneConfirmKeyboard(lang),
        });
        await context.scene.update({ detectedTz: tz }, { step: undefined });
        return;
      }

      // Handle callback
      if (context.is('callback_query')) {
        const data = (context as unknown as { data: string }).data;
        if (!data) return;
        const parts = data.split(':');
        const action = parts[0];
        const cbCtx = context as unknown as {
          answer: () => Promise<unknown>;
        };

        if (action === CB.ONBOARD_TZ) {
          const pendingTz = context.scene.state.detectedTz;
          if (!pendingTz) {
            await cbCtx.answer();
            return;
          }
          db.users.update(user.telegram_id, { timezone: pendingTz });
          await context.scene.exit();
          await context.send(`✅ ${getTimezoneDisplay(pendingTz)}`, removeKeyboard());
          await cbCtx.answer();
          return;
        }

        if (action === CB.ONBOARD_TZ_RETRY) {
          await cbCtx.answer();
          const prompt =
            lang === 'ru'
              ? '🌍 В каком городе вы находитесь?\n\nПримеры: Белград, Belgrade, Нью-Йорк, бангкок, Алматы, київ'
              : '🌍 What city are you in?\n\nExamples: Belgrade, New York, Bangkok, Almaty, Kyiv';
          await context.send(prompt, { reply_markup: timezoneMethodKeyboard(lang) });
          return;
        }

        await cbCtx.answer();
      }
    });
}
