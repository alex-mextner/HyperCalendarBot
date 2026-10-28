// src/bot/scenes/onboarding.scene.ts

import { Scene } from '@gramio/scenes';
import { InlineKeyboard, type Keyboard } from 'gramio';
import { CB, type Lang, t } from '../../config/constants.ts';
import type { DatabaseService } from '../../database/index.ts';
import type { InvitationRepository } from '../../database/repositories/invitation.repository.ts';
import type { UserRepository } from '../../database/repositories/user.repository.ts';
import type { EventService } from '../../services/event/event-service.ts';
import { formatInvitation } from '../../services/event/formatters.ts';
import type { HolidayService } from '../../services/holiday/holiday-service.ts';
import type { NotificationPreferencesService } from '../../services/notification/preferences.ts';
import { readInvitationRoster } from '../../services/sharing/invitation-roster.ts';
import { invitationRsvpKeyboard } from '../../services/sharing/invitation-rsvp-keyboard.ts';
import { resolveCity } from '../../services/timezone/city-resolver.ts';
import {
  getTimezoneDisplay,
  guessCountryFromTimezone,
  resolveTimezone,
} from '../../services/timezone/timezone-service.ts';
import { botLogger } from '../../utils/logger.ts';
import {
  cityInputPrompt,
  countryKeyboard,
  languageKeyboard,
  type RemoveKeyboardParams,
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

interface SendOptions {
  reply_markup?: InlineKeyboard | Keyboard | RemoveKeyboardParams['reply_markup'];
  parse_mode?: 'HTML';
}

type Send = (text: string, options?: SendOptions) => Promise<unknown>;

/** What the timezone step needs from the scene context; the scene builds it once per update. */
interface TimezoneStepEnv {
  lang: Lang;
  state: OnboardingState;
  send: Send;
  update(patch: Partial<OnboardingState>, options?: { step?: number }): Promise<unknown>;
}

interface TimezoneCallbackEnv extends TimezoneStepEnv {
  userId: number;
  answer(): Promise<unknown>;
}

function unresolvedCityMessage(lang: Lang): string {
  return lang === 'ru'
    ? 'Не удалось определить таймзону. Попробуйте ещё раз или:\n• Отправьте 📍 геолокацию\n• Введите код напрямую, например: <code>Europe/Belgrade</code>\n  Список кодов: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones'
    : 'Could not determine timezone. Try again or:\n• Share 📍 location\n• Enter timezone code directly, e.g. <code>Europe/Belgrade</code>\n  Full list: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones';
}

async function handleTypedCity(
  env: TimezoneStepEnv,
  rawText: string | undefined,
  resolveCityFn: typeof resolveCity,
): Promise<void> {
  const text = rawText?.trim();
  if (!text) return;
  const tz = await resolveCityFn(text);
  if (!tz) {
    await env.send(unresolvedCityMessage(env.lang), { parse_mode: 'HTML' });
    return;
  }
  await env.send(`✅ ${getTimezoneDisplay(tz)}`, { reply_markup: timezoneConfirmKeyboard(env.lang) });
  await env.update({ detectedTz: tz }, { step: undefined });
}

async function handleSharedLocation(env: TimezoneStepEnv, latitude: number, longitude: number): Promise<void> {
  const tz = resolveTimezone(latitude, longitude);
  const display = getTimezoneDisplay(tz);
  await env.send(t(env.lang).tz_detected(tz, display), {
    ...removeKeyboard(),
    reply_markup: timezoneConfirmKeyboard(env.lang),
  });
  await env.update({ detectedTz: tz }, { step: undefined });
}

async function confirmDetectedTimezone(env: TimezoneCallbackEnv, db: DatabaseService): Promise<void> {
  const tz = env.state.detectedTz;
  if (!tz) return;
  db.users.update(env.userId, { timezone: tz, country_code: guessCountryFromTimezone(tz) ?? undefined });
  await env.send(`✅ ${getTimezoneDisplay(tz)}`, removeKeyboard());
  await env.answer();
  await env.update({ timezone: tz });
}

async function handleTimezoneCallback(
  env: TimezoneCallbackEnv,
  data: string | undefined,
  db: DatabaseService,
): Promise<void> {
  if (!data) return;
  const [action, ...rest] = data.split(':');
  if (action === CB.ONBOARD_TZ && rest.join(':') === 'confirm') {
    await confirmDetectedTimezone(env, db);
    return;
  }
  await env.answer();
  if (action === CB.ONBOARD_TZ_RETRY) {
    await env.send(cityInputPrompt(env.lang), { reply_markup: timezoneMethodKeyboard(env.lang) });
  }
}

function agendaKeyboard(lang: Lang): InlineKeyboard {
  return new InlineKeyboard()
    .text('08:00', `${CB.ONBOARD_AGENDA}:08:00`)
    .text('09:00', `${CB.ONBOARD_AGENDA}:09:00`)
    .text('10:00', `${CB.ONBOARD_AGENDA}:10:00`)
    .row()
    .text('11:00', `${CB.ONBOARD_AGENDA}:11:00`)
    .text('12:00', `${CB.ONBOARD_AGENDA}:12:00`)
    .text(lang === 'ru' ? 'Нет' : 'No thanks', `${CB.ONBOARD_AGENDA}:no`);
}

interface PendingInvitationDisplay {
  send: Send;
  params: OnboardingParams | undefined;
  deps: OnboardingInvitationDeps | undefined;
  userId: number;
  lang: Lang;
  userTimezone: string | undefined;
}

/** Re-displays the invitation that triggered onboarding, now in the user's own timezone. */
async function redisplayPendingInvitation({
  send,
  params,
  deps,
  userId,
  lang,
  userTimezone,
}: PendingInvitationDisplay): Promise<void> {
  const { pendingInvitationId, pendingEventId, pendingInviterTelegramId } = params ?? {};
  if (!pendingInvitationId || !pendingEventId || !pendingInviterTelegramId || !deps) return;
  try {
    const invitation = deps.invitationRepo.findById(pendingInvitationId);
    if (invitation?.status !== 'pending') return;
    const event = deps.eventService.getEvent(pendingEventId, pendingInviterTelegramId);
    const inviter = deps.userRepo.findByTelegramId(pendingInviterTelegramId);
    if (!event || !userTimezone) return;
    const inviterName = inviter?.first_name ?? inviter?.username ?? `User ${pendingInviterTelegramId}`;
    const text = formatInvitation(
      event,
      event.timezone,
      lang,
      inviterName,
      pendingInviterTelegramId,
      inviter?.username,
      userTimezone,
      true,
      readInvitationRoster(deps.invitationRepo, event.id, userId),
    );
    await send(text, { parse_mode: 'HTML', reply_markup: invitationRsvpKeyboard(invitation.id, lang, event) });
  } catch (err) {
    botLogger.warn({ err, userId }, 'Failed to re-display invitation after onboarding');
  }
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

  // Save morning agenda preference if user selected a time (not "no")
  const saveMorningAgenda = (userId: number, selectedTime: string, timezone: string | undefined) => {
    if (selectedTime === 'no' || !prefsService || !timezone) return;
    prefsService.getOrCreate(userId);
    prefsService.updateMorningTime(userId, selectedTime);
    db.notificationPreferences.update(userId, { morning_agenda_enabled: 1 });
  };

  // Offer Google Calendar connection if configured and not already connected
  const offerGoogleCalendar = async (send: Send, userId: number, lang: Lang) => {
    if (!gcalConfigured || db.users.findByTelegramId(userId)?.google_refresh_token_enc) return;
    const gcalKb = new InlineKeyboard()
      .text(t(lang).gcal_connect_button, `${CB.GCAL}:onboard:connect`)
      .row()
      .text(t(lang).gcal_onboarding_maybe_later, GCAL_ONBOARD_LATER);
    await send(t(lang).gcal_onboarding, { reply_markup: gcalKb });
  };

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
        const l = context.scene.state.lang ?? 'en';

        if (context.scene.step.firstTime) {
          await context.send(cityInputPrompt(l), { reply_markup: timezoneMethodKeyboard(l) });
          return;
        }

        const env: TimezoneStepEnv = {
          lang: l,
          state: context.scene.state,
          send: (text, options) => context.send(text, options),
          update: (patch, options) => (options ? context.scene.update(patch, options) : context.scene.update(patch)),
        };
        if (context.is('message')) {
          await handleTypedCity(env, context.text, resolveCity_);
        } else if (context.is('location')) {
          await handleSharedLocation(env, context.eventLocation.latitude, context.eventLocation.longitude);
        } else if (context.is('callback_query')) {
          await handleTimezoneCallback(
            { ...env, userId: context.from.id, answer: () => context.answer() },
            context.data,
            db,
          );
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
        const l = context.scene.state.lang ?? 'en';

        if (context.scene.step.firstTime) {
          await context.send(t(l).agenda_prompt, { reply_markup: agendaKeyboard(l) });
          return;
        }

        const data = context.data;
        if (!data) return;
        const parts = data.split(':');
        if (parts[0] !== CB.ONBOARD_AGENDA) return;

        const userId = context.from.id;
        const { timezone } = context.scene.state;
        saveMorningAgenda(userId, parts.slice(1).join(':'), timezone);

        // Complete onboarding
        db.users.update(userId, { onboarding_completed: 1 });
        await context.answer();

        const send: Send = (text, options) => context.send(text, options);
        const tourKb = new InlineKeyboard().text(t(l).feature_tour_btn, `${CB.FEATURE_TOUR}:0`);
        await send(t(l).onboard_done, { reply_markup: tourKb });

        await redisplayPendingInvitation({
          send,
          params: context.scene.params,
          deps: invitationDeps,
          userId,
          lang: l,
          userTimezone: context.scene.state.timezone,
        });
        await offerGoogleCalendar(send, userId, l);

        await context.scene.exit();
      })
  );
}
