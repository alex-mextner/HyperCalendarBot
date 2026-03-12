// src/bot/commands/start.ts
import { InlineKeyboard } from 'gramio';
import { CB, t } from '../../config/constants.ts';
import type { DatabaseService } from '../../database/index.ts';
import type { User } from '../../database/types.ts';
import {
  getTimezoneDisplay,
  guessCountryFromTimezone,
  resolveTimezone,
} from '../../services/timezone/timezone-service.ts';
import {
  countryKeyboard,
  languageKeyboard,
  removeKeyboard,
  timezoneCitiesKeyboard,
  timezoneConfirmKeyboard,
  timezoneManualKeyboard,
  timezoneMethodKeyboard,
} from '../keyboards.ts';
import type { BotCallbackContext, BotCommandContext } from '../types.ts';
import { clearSession, getSession, setSession } from '../types.ts';

export async function handleStart(ctx: BotCommandContext): Promise<void> {
  const user = ctx.dbUser as User;

  if (user.onboarding_completed) {
    const lang = user.language as 'en' | 'ru';
    await ctx.send(t(lang).welcome_back);
    return;
  }

  // Step 1: Language selection
  setSession(user.telegram_id, 'onboard:lang');
  await ctx.send(t('en').welcome, { reply_markup: languageKeyboard() });
}

/**
 * Handle onboarding callback queries.
 * Called from the callback handler router.
 */
export async function handleOnboardingCallback(
  ctx: BotCallbackContext,
  db: DatabaseService,
  action: string,
  payload: string,
): Promise<void> {
  const user = ctx.dbUser as User;
  const userId = user.telegram_id;

  if (action === 'ol') {
    // Language selected
    const lang = payload as 'en' | 'ru';
    db.users.update(userId, { language: lang });
    setSession(userId, 'onboard:tz', { lang });
    await ctx.editText(t(lang).tz_prompt, {
      reply_markup: timezoneManualKeyboard(),
    });
    // Also send reply keyboard for location
    await ctx.send(t(lang).tz_prompt, {
      reply_markup: timezoneMethodKeyboard(lang),
    });
  }

  if (action === 'otr') {
    // Timezone region selected
    await ctx.editText('Select city:', {
      reply_markup: timezoneCitiesKeyboard(payload),
    });
  }

  if (action === 'ot') {
    const session = getSession(userId);
    const lang = (session?.data.lang as 'en' | 'ru') ?? (user.language as 'en' | 'ru');

    if (payload === 'confirm') {
      // Timezone already set in session data, proceed to country
      const tz = (session?.data.detectedTz as string) ?? user.timezone;
      db.users.update(userId, { timezone: tz });
      const country = guessCountryFromTimezone(tz);
      setSession(userId, 'onboard:country', { ...session?.data, tz });
      await ctx.send(t(lang).country_prompt, {
        ...removeKeyboard(),
      });
      await ctx.send(t(lang).country_prompt, {
        reply_markup: countryKeyboard(country, lang),
      });
    } else if (payload === 'manual') {
      // Show region selection
      await ctx.editText('Select region:', {
        reply_markup: timezoneManualKeyboard(),
      });
    } else {
      // Timezone city selected directly
      db.users.update(userId, { timezone: payload });
      const country = guessCountryFromTimezone(payload);
      setSession(userId, 'onboard:country', { ...session?.data, tz: payload });
      await ctx.send(`✅ ${getTimezoneDisplay(payload)}`, removeKeyboard());
      await ctx.send(t(lang).country_prompt, {
        reply_markup: countryKeyboard(country, lang),
      });
    }
  }

  if (action === 'oc') {
    // Country selected or skipped
    const session = getSession(userId);
    const lang = (session?.data.lang as 'en' | 'ru') ?? (user.language as 'en' | 'ru');

    if (payload !== 'skip') {
      db.users.update(userId, { country_code: payload });
    }

    // Step 4: Morning agenda prompt
    setSession(userId, 'onboard:agenda', { ...session?.data });
    const agendaKb = new InlineKeyboard()
      .text('08:00', `${CB.ONBOARD_AGENDA}:08:00`)
      .text('09:00', `${CB.ONBOARD_AGENDA}:09:00`)
      .text('10:00', `${CB.ONBOARD_AGENDA}:10:00`)
      .row()
      .text('11:00', `${CB.ONBOARD_AGENDA}:11:00`)
      .text('12:00', `${CB.ONBOARD_AGENDA}:12:00`)
      .text(lang === 'ru' ? 'Нет' : 'No thanks', `${CB.ONBOARD_AGENDA}:no`);
    await ctx.send(t(lang).agenda_prompt, { reply_markup: agendaKb });
  }

  if (action === 'oa') {
    // Morning agenda response — complete onboarding
    // Note: actual notification preferences are set in sub-project 04.
    // Here we just acknowledge the choice and finish.
    const session = getSession(userId);
    const lang = (session?.data.lang as 'en' | 'ru') ?? (user.language as 'en' | 'ru');

    db.users.update(userId, { onboarding_completed: 1 });
    clearSession(userId);
    await ctx.send(t(lang).onboard_done);
  }
}

/**
 * Handle location message during onboarding
 */
export async function handleOnboardingLocation(
  ctx: BotCommandContext,
  latitude: number,
  longitude: number,
): Promise<void> {
  const user = ctx.dbUser as User;
  const session = getSession(user.telegram_id);
  if (!session || !session.step.startsWith('onboard:tz')) return;

  const lang = (session.data.lang as 'en' | 'ru') ?? (user.language as 'en' | 'ru');
  const tz = resolveTimezone(latitude, longitude);
  const display = getTimezoneDisplay(tz);

  setSession(user.telegram_id, 'onboard:tz', { ...session.data, detectedTz: tz });

  await ctx.send(t(lang).tz_detected(tz, display), {
    ...removeKeyboard(),
    reply_markup: timezoneConfirmKeyboard(lang),
  });
}
