// src/bot/scenes/onboarding.scene.ts

import { Scene } from '@gramio/scenes';
import { InlineKeyboard } from 'gramio';
import { CB, t } from '../../config/constants.ts';
import type { DatabaseService } from '../../database/index.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatInvitation } from '../../services/event/formatters.ts';
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
import type { UserResolverComposer } from '../middleware/user-resolver.ts';
import type { OnboardingParams, OnboardingState } from './types.ts';

const GCAL_ONBOARD_LATER = `${CB.GCAL}:onboard:later`;

export interface OnboardingInvitationDeps {
  invitationRepo: InvitationRepository;
  userRepo: UserRepository;
  eventService: EventService;
}

export function createOnboardingScene(
  db: DatabaseService,
  userComposer: UserResolverComposer,
  gcalConfigured = false,
  prefsService?: NotificationPreferencesService,
  holidayService?: HolidayService,
  resolveCityFn?: typeof resolveCity,
  invitationDeps?: OnboardingInvitationDeps,
) {
  const resolveCity_ = resolveCityFn ?? resolveCity;
  return (
    new Scene('onboarding')
      .state<OnboardingState>()
      .params<OnboardingParams>()
      // extend() AFTER params() — params() uses Modify which replaces Derives.global
      .extend(userComposer)
      // onEnter sends welcome — because scene is entered from /start (message)
      // but step 0 is "callback_query", so firstTime won't fire on entry
      .onEnter(async (context) => {
        await context.send(t('en').welcome, { reply_markup: languageKeyboard() });
      })
      // Step 0: Language selection (callback only)
      .step('callback_query', async (context) => {
        const data = context.data;
        if (!data) return;
        const parts = data.split(':');
        if (parts[0] !== CB.ONBOARD_LANG) return;

        const lang = parts[1] as 'en' | 'ru';
        db.users.update(context.from.id, { language: lang });

        await context.editText(`${lang === 'ru' ? 'Язык: Русский' : 'Language: English'} \u2705`);
        await context.answer();
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
          const text = context.text?.trim();
          if (!text) return;
          const tz = await resolveCity_(text);
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
          const { latitude, longitude } = context.eventLocation;
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
          const data = context.data;
          if (!data) return;

          const parts = data.split(':');
          const action = parts[0];

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
              await context.answer();
              await context.scene.update({ timezone: tz });
              return;
            }
          }

          if (action === CB.ONBOARD_TZ_RETRY) {
            await context.answer();
            await context.send(cityInputPrompt(l), { reply_markup: timezoneMethodKeyboard(l) });
            return;
          }

          await context.answer();
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

        const data = context.data;
        if (!data) return;
        const parts = data.split(':');
        if (parts[0] !== CB.ONBOARD_COUNTRY) return;

        const payload = parts.slice(1).join(':');
        if (payload !== 'skip') {
          holidayService?.subscribeUser(context.from.id, payload, true);
        }

        await context.answer();
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

        const data = context.data;
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
        await context.answer();

        const tourKb = new InlineKeyboard().text(t(l).feature_tour_btn, `${CB.FEATURE_TOUR}:0`);
        await context.send(t(l).onboard_done, { reply_markup: tourKb });

        // Re-display invitation with user's timezone after onboarding
        const params = context.scene.params;
        if (params?.pendingInvitationId && params.pendingEventId && params.pendingInviterTelegramId && invitationDeps) {
          const invitation = invitationDeps.invitationRepo.findById(params.pendingInvitationId);
          if (invitation && invitation.status === 'pending') {
            const event = invitationDeps.eventService.getEvent(params.pendingEventId, params.pendingInviterTelegramId);
            const inviter = invitationDeps.userRepo.findByTelegramId(params.pendingInviterTelegramId);
            const inviterName = inviter?.first_name ?? inviter?.username ?? `User ${params.pendingInviterTelegramId}`;
            const userTz = context.scene.state.timezone;
            if (event && userTz) {
              const text = formatInvitation(
                event,
                event.timezone,
                l,
                inviterName,
                params.pendingInviterTelegramId,
                inviter?.username,
                userTz,
                true,
              );
              const kb = new InlineKeyboard()
                .text('✅ Accept', `${CB.INVITATION_ACTION}:accept:${invitation.id}`)
                .text('❌ Decline', `${CB.INVITATION_ACTION}:decline:${invitation.id}`)
                .row()
                .text('Maybe 🤔', `${CB.INVITATION_ACTION}:maybe:${invitation.id}`)
                .text(t(l).invite_propose_btn, `${CB.INVITATION_ACTION}:propose:${invitation.id}`);
              await context.send(text, { parse_mode: 'HTML', reply_markup: kb });
            }
          }
        }

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
