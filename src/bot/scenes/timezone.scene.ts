// src/bot/scenes/timezone.scene.ts
import { Scene } from '@gramio/scenes';
import { InlineKeyboard } from 'gramio';
import { CB } from '../../config/constants.ts';
import type { DatabaseService } from '../../database/index.ts';
import { resolveCity } from '../../services/timezone/city-resolver.ts';
import { getTimezoneDisplay, resolveTimezone } from '../../services/timezone/timezone-service.ts';
import { botLogger } from '../../utils/logger.ts';
import { buildGeneralView } from '../commands/settings.ts';
import { cityInputPrompt, removeKeyboard, timezoneConfirmKeyboard, timezoneMethodKeyboard } from '../keyboards.ts';
import type { UserResolverComposer } from '../middleware/user-resolver.ts';

import type { TimezoneState } from './types.ts';

interface TimezoneParams {
  settingsMsgId: number;
  settingsChatId: number;
}

export function createTimezoneScene(db: DatabaseService, userComposer: UserResolverComposer, aiModel?: string) {
  return new Scene('timezone')
    .state<TimezoneState>()
    .params<TimezoneParams>()
    .extend(userComposer)
    .onEnter(async (context) => {
      const { lang, dbUser: user } = context;
      if (!user) return;

      const display = getTimezoneDisplay(user.timezone);
      const chooserText =
        lang === 'ru'
          ? `🌍 Текущий: ${display}\n\nВыбери способ изменения:`
          : `🌍 Current: ${display}\n\nChoose how to change:`;

      const chooserKb = new InlineKeyboard()
        .text(lang === 'ru' ? '🎹 Написать город' : '🎹 Type city', CB.TZ_TYPE_CITY)
        .text(lang === 'ru' ? '📍 Скинуть гео' : '📍 Share geo', CB.TZ_GEO_PICK)
        .row()
        .text(lang === 'ru' ? '← Назад' : '← Back', CB.TZ_CANCEL);

      // onEnter is called from stg:change_tz callback_query — editText replaces the settings message
      await (context as { editText: (text: string, opts?: unknown) => Promise<unknown> }).editText(chooserText, {
        reply_markup: chooserKb,
      });
    })
    .step(['message', 'location', 'callback_query'], async (context) => {
      const { dbUser: user } = context;
      if (!user) {
        await context.scene.exit();
        return;
      }
      const { lang } = context;
      const params = context.scene.params as TimezoneParams;
      const { cityInputMode, geoMsgId } = context.scene.state;

      // Handle typed city name (only after entering city input mode)
      if (context.is('message')) {
        if (!cityInputMode) return;
        const text = context.text?.trim();
        if (!text) return;
        const tz = await resolveCity(text, aiModel);
        if (tz) {
          await context.send(`✅ ${getTimezoneDisplay(tz)}`, {
            reply_markup: timezoneConfirmKeyboard(lang),
          });
          await context.scene.update({ detectedTz: tz }, { step: undefined });
        } else {
          const msg =
            lang === 'ru'
              ? 'Не удалось определить таймзону. Попробуй ещё раз или:\n• Введи код напрямую, например: <code>Europe/Belgrade</code>\n  Список: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones'
              : 'Could not determine timezone. Try again or:\n• Enter code directly, e.g. <code>Europe/Belgrade</code>\n  Full list: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones';
          await context.send(msg, { parse_mode: 'HTML' });
        }
        return;
      }

      // Handle location shared via reply keyboard
      if (context.is('location')) {
        const { latitude, longitude } = context.eventLocation;
        const tz = resolveTimezone(latitude, longitude);
        const display = getTimezoneDisplay(tz);
        // Delete the geo request message now that location is received
        if (geoMsgId) {
          const { bot } = context;
          const chatId = context.chatId ?? 0;
          bot.api
            .deleteMessage({ chat_id: chatId, message_id: geoMsgId })
            .catch((err: unknown) => botLogger.warn({ err }, 'tz scene: failed to delete geo message'));
        }
        await context.send(`✅ ${display}`, {
          reply_markup: timezoneConfirmKeyboard(lang),
        });
        await context.scene.update({ detectedTz: tz }, { step: undefined });
        return;
      }

      // Handle callback
      if (context.is('callback_query')) {
        const data = context.data;
        if (!data) return;
        const parts = data.split(':');
        const action = parts[0];

        // Geo pick — show geo reply keyboard via new message, save its ID
        if (action === CB.TZ_GEO_PICK) {
          await context.answer();
          const display = getTimezoneDisplay(user.timezone);
          const geoPromptText =
            lang === 'ru'
              ? `🌍 Текущий: ${display}\n\nПоделись геолокацией:`
              : `🌍 Current: ${display}\n\nShare your location:`;
          const cancelKb = new InlineKeyboard().text(lang === 'ru' ? '← Назад' : '← Back', CB.TZ_CANCEL);
          await context.editText(geoPromptText, { reply_markup: cancelKb });
          const geoMsg = await context.send(lang === 'ru' ? '📍 Нажми кнопку ниже:' : '📍 Tap the button below:', {
            reply_markup: timezoneMethodKeyboard(lang),
          });
          await context.scene.update({ geoMsgId: geoMsg.id }, { step: undefined });
          return;
        }

        // Enter city input mode
        if (action === CB.TZ_TYPE_CITY) {
          await context.answer();
          const display = getTimezoneDisplay(user.timezone);
          const header = lang === 'ru' ? `🌍 Текущий: ${display}\n\n` : `🌍 Current: ${display}\n\n`;
          const promptText = header + cityInputPrompt(lang).replace(/^🌍 /, '');
          const cancelKb = new InlineKeyboard().text(lang === 'ru' ? '← Назад' : '← Back', CB.TZ_CANCEL);
          await context.editText(promptText, { reply_markup: cancelKb });
          // Send city prompt as new message — removes any stale reply keyboard
          await context.send(cityInputPrompt(lang), removeKeyboard());
          await context.scene.update({ cityInputMode: true }, { step: undefined });
          return;
        }

        // Cancel — restore general settings
        if (action === CB.TZ_CANCEL) {
          await context.answer();
          await context.scene.exit();
          const { text: settingsText, kb: settingsKb } = buildGeneralView(user);
          await context.editText(settingsText, { reply_markup: settingsKb });
          // If geo request was active: delete its message and remove reply keyboard
          if (geoMsgId) {
            const { bot } = context;
            const chatId = context.chatId ?? 0;
            bot.api
              .deleteMessage({ chat_id: chatId, message_id: geoMsgId })
              .catch((err: unknown) => botLogger.warn({ err }, 'tz scene: failed to delete geo message'));
            const tempMsg = await context.send('.', removeKeyboard());
            tempMsg.delete().catch((err: unknown) => {
              botLogger.warn({ err }, 'tz scene: failed to delete temp remove-keyboard message');
            });
          }
          return;
        }

        // Confirm — save timezone, update settings message
        if (action === CB.ONBOARD_TZ) {
          const pendingTz = context.scene.state.detectedTz;
          if (!pendingTz) {
            await context.answer();
            return;
          }
          const updatedUser = db.users.update(user.telegram_id, { timezone: pendingTz });
          await context.scene.exit();
          // Edit the confirm message to show success
          await context.editText(`✅ ${getTimezoneDisplay(pendingTz)}`);
          // Restore general settings in the original settings message
          if (updatedUser && params.settingsMsgId && params.settingsChatId) {
            const { text: settingsText, kb: settingsKb } = buildGeneralView(updatedUser);
            const { bot } = context;
            await bot.api.editMessageText({
              chat_id: params.settingsChatId,
              message_id: params.settingsMsgId,
              text: settingsText,
              reply_markup: settingsKb,
            });
          }
          await context.answer();
          return;
        }

        // Retry — delete the confirm message, user can type another city
        if (action === CB.ONBOARD_TZ_RETRY) {
          await context.answer();
          await context.message?.delete();
          return;
        }

        await context.answer();
      }
    });
}
