// src/bot/scenes/onboarding.scene.ts

import { Scene } from '@gramio/scenes';
import { InlineKeyboard } from 'gramio';
import { CB, t } from '../../config/constants.ts';
import type { DatabaseService } from '../../database/index.ts';
import type { HolidayService } from '../../services/holiday/holiday-service.ts';
import type { NotificationPreferencesService } from '../../services/notification/preferences.ts';
import { resolveCity } from '../../services/timezone/city-resolver.ts';
import {
  getTimezoneDisplay,
  guessCountryFromTimezone,
  resolveTimezone,
} from '../../services/timezone/timezone-service.ts';
import {
  cityInputPrompt,
  countryKeyboard,
  languageKeyboard,
  removeKeyboard,
  timezoneConfirmKeyboard,
  timezoneMethodKeyboard,
} from '../keyboards.ts';

const GCAL_ONBOARD_LATER = `${CB.GCAL}:onboard:later`;

interface OnboardingState {
  lang?: 'en' | 'ru';
  detectedTz?: string;
  timezone?: string;
  country?: string;
}

export function createOnboardingScene(
  db: DatabaseService,
  gcalConfigured = false,
  prefsService?: NotificationPreferencesService,
  holidayService?: HolidayService,
  aiModel?: string,
) {
  return (
    new Scene('onboarding')
      .state<OnboardingState>()
      // onEnter sends welcome — because scene is entered from /start (message)
      // but step 0 is "callback_query", so firstTime won't fire on entry
      .onEnter(async (context) => {
        await context.send(t('en').welcome, { reply_markup: languageKeyboard() });
      })
      // Step 0: Language selection (callback only)
      .step('callback_query', async (context) => {
        const data = (context as unknown as { data: string }).data;
        if (!data) return;
        const parts = data.split(':');
        if (parts[0] !== CB.ONBOARD_LANG) return;

        const lang = parts[1] as 'en' | 'ru';
        db.users.update(context.from.id, { language: lang });

        const cbCtx = context as unknown as {
          editText: (text: string, opts?: Record<string, unknown>) => Promise<unknown>;
          answer: (opts?: Record<string, unknown>) => Promise<unknown>;
        };
        await cbCtx.editText(`${lang === 'ru' ? 'Язык: Русский' : 'Language: English'} \u2705`);
        await cbCtx.answer();
        await context.scene.update({ lang });
      })

      // Step 1: Timezone (message + location + callback)
      .step(['message', 'location', 'callback_query'], async (context) => {
        const { lang } = context.scene.state;
        const l = lang ?? 'en';

        if (context.scene.step.firstTime) {
          await context.send(cityInputPrompt(l), { reply_markup: timezoneMethodKeyboard(l) });
          return;
        }

        // Handle typed city name
        if (context.is('message')) {
          const text = (context as unknown as { text?: string }).text?.trim();
          if (!text) return;
          const tz = await resolveCity(text, aiModel);
          if (tz) {
            await context.send(`✅ ${getTimezoneDisplay(tz)}`, {
              reply_markup: timezoneConfirmKeyboard(l),
            });
            await context.scene.update({ detectedTz: tz }, { step: undefined });
          } else {
            const msg =
              l === 'ru'
                ? 'Не удалось определить таймзону. Попробуйте ещё раз или:\n• Отправьте 📍 геолокацию\n• Введите код напрямую, например: <code>Europe/Belgrade</code>\n  Список кодов: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones'
                : 'Could not determine timezone. Try again or:\n• Share 📍 location\n• Enter timezone code directly, e.g. <code>Europe/Belgrade</code>\n  Full list: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones';
            await context.send(msg, { parse_mode: 'HTML' });
          }
          return;
        }

        // Handle location
        if (context.is('location')) {
          const { latitude, longitude } = (
            context as unknown as {
              eventLocation: { latitude: number; longitude: number };
            }
          ).eventLocation;
          const tz = resolveTimezone(latitude, longitude);
          const display = getTimezoneDisplay(tz);
          await context.send(t(l).tz_detected(tz, display), {
            ...removeKeyboard(),
            reply_markup: timezoneConfirmKeyboard(l),
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
            answer: (opts?: Record<string, unknown>) => Promise<unknown>;
          };

          if (action === CB.ONBOARD_TZ) {
            const payload = parts.slice(1).join(':');
            if (payload === 'confirm') {
              const tz = context.scene.state.detectedTz;
              if (!tz) return;
              db.users.update(context.from.id, {
                timezone: tz,
                country_code: guessCountryFromTimezone(tz) ?? undefined,
              });
              await context.send(`✅ ${getTimezoneDisplay(tz)}`, removeKeyboard());
              await cbCtx.answer();
              await context.scene.update({ timezone: tz });
              return;
            }
          }

          if (action === CB.ONBOARD_TZ_RETRY) {
            await cbCtx.answer();
            await context.send(cityInputPrompt(l), { reply_markup: timezoneMethodKeyboard(l) });
            return;
          }

          await cbCtx.answer();
        }
      })

      // Step 2: Country selection (callback)
      .step('callback_query', async (context) => {
        const { lang, timezone } = context.scene.state;
        const l = lang ?? 'en';

        if (context.scene.step.firstTime) {
          const country = guessCountryFromTimezone(timezone ?? 'UTC');
          await context.send(t(l).country_prompt, {
            reply_markup: countryKeyboard(country, l),
          });
          return;
        }

        const data = (context as unknown as { data: string }).data;
        if (!data) return;
        const parts = data.split(':');
        if (parts[0] !== CB.ONBOARD_COUNTRY) return;

        const payload = parts.slice(1).join(':');
        if (payload !== 'skip') {
          holidayService?.subscribeUser(context.from.id, payload, true);
        }

        const cbCtx = context as unknown as {
          answer: (opts?: Record<string, unknown>) => Promise<unknown>;
        };
        await cbCtx.answer();
        await context.scene.update({ country: payload });
      })

      // Step 3: Morning agenda prompt (callback)
      .step('callback_query', async (context) => {
        const { lang } = context.scene.state;
        const l = lang ?? 'en';

        if (context.scene.step.firstTime) {
          const agendaKb = new InlineKeyboard()
            .text('08:00', `${CB.ONBOARD_AGENDA}:08:00`)
            .text('09:00', `${CB.ONBOARD_AGENDA}:09:00`)
            .text('10:00', `${CB.ONBOARD_AGENDA}:10:00`)
            .row()
            .text('11:00', `${CB.ONBOARD_AGENDA}:11:00`)
            .text('12:00', `${CB.ONBOARD_AGENDA}:12:00`)
            .text(l === 'ru' ? 'Нет' : 'No thanks', `${CB.ONBOARD_AGENDA}:no`);
          await context.send(t(l).agenda_prompt, { reply_markup: agendaKb });
          return;
        }

        const data = (context as unknown as { data: string }).data;
        if (!data) return;
        const parts = data.split(':');
        if (parts[0] !== CB.ONBOARD_AGENDA) return;

        const selectedTime = parts.slice(1).join(':');
        const { timezone } = context.scene.state;

        // Save morning agenda preference if user selected a time (not "no")
        if (selectedTime !== 'no' && prefsService && timezone) {
          prefsService.getOrCreate(context.from.id);
          prefsService.updateMorningTime(context.from.id, selectedTime);
          db.notificationPreferences.update(context.from.id, { morning_agenda_enabled: 1 });
        }

        // Complete onboarding
        db.users.update(context.from.id, { onboarding_completed: 1 });
        const cbCtx = context as unknown as {
          answer: (opts?: Record<string, unknown>) => Promise<unknown>;
        };
        await cbCtx.answer();

        const tourKb = new InlineKeyboard().text(t(l).feature_tour_btn, `${CB.FEATURE_TOUR}:0`);
        await context.send(t(l).onboard_done, { reply_markup: tourKb });

        // Show Google Calendar onboarding prompt if configured and not already connected
        if (gcalConfigured) {
          const user = db.users.findByTelegramId(context.from.id);
          if (!user?.google_refresh_token_enc) {
            const gcalKb = new InlineKeyboard()
              .text(t(l).gcal_connect_button, `${CB.GCAL}:onboard:connect`)
              .row()
              .text(t(l).gcal_onboarding_maybe_later, GCAL_ONBOARD_LATER);
            await context.send(t(l).gcal_onboarding, { reply_markup: gcalKb });
          }
        }

        await context.scene.exit();
      })
  );
}
