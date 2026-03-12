// src/bot/commands/holidays.ts

import { t } from '../../config/constants.ts';
import type { User } from '../../database/types.ts';
import type { HolidayService } from '../../services/holiday/holiday-service.ts';
import { escapeHtml } from '../../utils/telegram.ts';
import {
  holidayCountryKeyboard,
  holidayManageCountryKeyboard,
  holidayManageListKeyboard,
  holidayRegionKeyboard,
  holidaysMenuKeyboard,
} from '../keyboards.ts';
import type { BotCallbackContext, BotCommandContext } from '../types.ts';

export async function handleHolidays(ctx: BotCommandContext, holidayService: HolidayService): Promise<void> {
  const user = ctx.dbUser as User;
  const lang = user.language as 'en' | 'ru';
  const args = (ctx.args as string)?.trim();

  if (args === 'list') {
    const text = buildUpcomingText(holidayService, user, lang);
    await ctx.send(text ?? (t(lang).holidays_none_upcoming as string), { parse_mode: 'HTML' });
    return;
  }

  await sendMainMenu(ctx, holidayService, user, lang);
}

function buildMenuText(holidayService: HolidayService, user: User, lang: 'en' | 'ru'): string {
  const subs = holidayService.getSubscriptions(user.telegram_id);
  let text = t(lang).holidays_menu as string;

  if (subs.length === 0) {
    text += `\n\n${t(lang).holidays_no_subs}`;
  } else {
    text += '\n';
    for (const s of subs) {
      const country = holidayService.getCountryName(s.country_code);
      const primary = s.is_primary ? ' ⭐' : '';
      text += `\n• ${country}${primary}`;
    }
  }
  return text;
}

async function sendMainMenu(
  ctx: BotCommandContext,
  holidayService: HolidayService,
  user: User,
  lang: 'en' | 'ru',
): Promise<void> {
  await ctx.send(buildMenuText(holidayService, user, lang), {
    parse_mode: 'HTML',
    reply_markup: holidaysMenuKeyboard(lang),
  });
}

async function editMainMenu(
  ctx: BotCallbackContext,
  holidayService: HolidayService,
  user: User,
  lang: 'en' | 'ru',
): Promise<void> {
  await ctx.editText(buildMenuText(holidayService, user, lang), {
    parse_mode: 'HTML',
    reply_markup: holidaysMenuKeyboard(lang),
  });
}

function buildUpcomingText(holidayService: HolidayService, user: User, lang: 'en' | 'ru'): string | null {
  const holidays = holidayService.getUpcomingHolidays(user.telegram_id, 10);
  if (holidays.length === 0) return null;
  const lines = holidays.map((h) => `  ${h.date}  ${escapeHtml(h.name)} <i>(${escapeHtml(h.countryName)})</i>`);
  return `${t(lang).holidays_upcoming}\n\n${lines.join('\n')}`;
}

export async function handleHolidayCallback(
  ctx: BotCallbackContext,
  holidayService: HolidayService,
  user: User,
  payload: string,
): Promise<void> {
  const lang = (user.language ?? 'en') as 'en' | 'ru';
  const parts = payload.split(':');
  const action = parts[0]!;

  // hl:menu
  if (action === 'menu') {
    await ctx.answer();
    return editMainMenu(ctx, holidayService, user, lang);
  }

  // hl:noop (pagination label)
  if (action === 'noop') {
    await ctx.answer();
    return;
  }

  // hl:add — show region picker
  // hl:add:{region} — show country picker
  // hl:add:{region}:{page} — paginated country picker
  if (action === 'add') {
    await ctx.answer();
    const region = parts[1];
    if (!region) {
      const regions = holidayService.getAvailableRegions();
      await ctx.editText(t(lang).holidays_pick_region as string, {
        parse_mode: 'HTML',
        reply_markup: holidayRegionKeyboard(regions, lang),
      });
      return;
    }
    const page = parts[2] ? Number(parts[2]) : 0;
    const countries = holidayService.getCountriesForRegion(region);
    await ctx.editText(t(lang).holidays_pick_country as string, {
      parse_mode: 'HTML',
      reply_markup: holidayCountryKeyboard(countries, region, page, lang),
    });
    return;
  }

  // hl:sub:{countryCode} — subscribe
  if (action === 'sub') {
    const countryCode = parts[1]!;
    const subs = holidayService.getSubscriptions(user.telegram_id);
    const isPrimary = subs.length === 0;
    holidayService.subscribeUser(user.telegram_id, countryCode, isPrimary);
    const countryName = holidayService.getCountryName(countryCode);
    await ctx.answer({ text: (t(lang).holidays_added as (c: string) => string)(countryName) });
    return editMainMenu(ctx, holidayService, user, lang);
  }

  // hl:manage — show subscription list
  // hl:manage:{countryCode} — show management for country
  if (action === 'manage') {
    await ctx.answer();
    const countryCode = parts[1];
    if (!countryCode) {
      const subs = holidayService.getSubscriptions(user.telegram_id);
      if (subs.length === 0) {
        await ctx.editText(t(lang).holidays_no_subs as string, { parse_mode: 'HTML' });
        return;
      }
      const subsWithNames = subs.map((s) => ({
        country_code: s.country_code,
        countryName: holidayService.getCountryName(s.country_code),
        is_primary: s.is_primary,
      }));
      await ctx.editText(t(lang).holidays_manage_prompt as string, {
        parse_mode: 'HTML',
        reply_markup: holidayManageListKeyboard(subsWithNames, lang),
      });
      return;
    }
    const subscription = holidayService.getSubscription(user.telegram_id, countryCode);
    if (!subscription) {
      await ctx.editText(t(lang).holidays_no_subs as string, { parse_mode: 'HTML' });
      return;
    }
    const countryName = holidayService.getCountryName(countryCode);
    await ctx.editText(countryName, {
      reply_markup: holidayManageCountryKeyboard(
        countryCode,
        subscription.is_primary === 1,
        !!subscription.notify,
        lang,
      ),
    });
    return;
  }

  // hl:primary:{countryCode}
  if (action === 'primary') {
    const countryCode = parts[1]!;
    holidayService.setPrimary(user.telegram_id, countryCode);
    const countryName = holidayService.getCountryName(countryCode);
    await ctx.answer({ text: (t(lang).holidays_set_primary as (c: string) => string)(countryName) });
    const subs = holidayService.getSubscriptions(user.telegram_id);
    const subsWithNames = subs.map((s) => ({
      country_code: s.country_code,
      countryName: holidayService.getCountryName(s.country_code),
      is_primary: s.is_primary,
    }));
    await ctx.editText(t(lang).holidays_manage_prompt as string, {
      parse_mode: 'HTML',
      reply_markup: holidayManageListKeyboard(subsWithNames, lang),
    });
    return;
  }

  // hl:remove:{countryCode}
  if (action === 'remove') {
    const countryCode = parts[1]!;
    const countryName = holidayService.getCountryName(countryCode);
    holidayService.unsubscribeUser(user.telegram_id, countryCode);
    await ctx.answer({ text: (t(lang).holidays_removed as (c: string) => string)(countryName) });
    return editMainMenu(ctx, holidayService, user, lang);
  }

  // hl:notify:{countryCode} — toggle notifications
  if (action === 'notify') {
    const countryCode = parts[1]!;
    holidayService.toggleNotify(user.telegram_id, countryCode);
    const countryName = holidayService.getCountryName(countryCode);
    const subscription = holidayService.getSubscription(user.telegram_id, countryCode);
    if (!subscription) return;
    const notifyMsg = subscription.notify
      ? (t(lang).holidays_notify_on as (c: string) => string)(countryName)
      : (t(lang).holidays_notify_off as (c: string) => string)(countryName);
    await ctx.answer({ text: notifyMsg });
    await ctx.editText(countryName, {
      reply_markup: holidayManageCountryKeyboard(
        countryCode,
        subscription.is_primary === 1,
        !!subscription.notify,
        lang,
      ),
    });
    return;
  }

  // hl:list — upcoming holidays
  if (action === 'list') {
    await ctx.answer();
    const text = buildUpcomingText(holidayService, user, lang);
    await ctx.editText(text ?? (t(lang).holidays_none_upcoming as string), { parse_mode: 'HTML' });
  }
}
