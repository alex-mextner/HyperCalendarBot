// src/bot/commands/holidays.ts

import { t } from '../../config/constants.ts';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import type { HolidaySubscriptionRow, User } from '../../database/types.ts';
import type { HolidayService } from '../../services/holiday/holiday-service.ts';
import { escapeHtml } from '../../utils/telegram.ts';
import { getGroupId, isGroup } from '../group-context.ts';
import {
  holidayCountryKeyboard,
  holidayManageCountryKeyboard,
  holidayManageListKeyboard,
  holidayRegionKeyboard,
  holidaysMenuKeyboard,
} from '../keyboards.ts';
import type { BotCallbackContext, BotCommandContext } from '../types.ts';

async function handleGroupHolidays(
  ctx: BotCommandContext,
  holidayService: HolidayService,
  groupRepo: GroupChatRepository | undefined,
  lang: 'en' | 'ru',
): Promise<void> {
  const groupId = getGroupId(ctx);
  if (groupId === null) return;
  const group = groupRepo?.findByChatId(groupId);
  if (!group?.country) {
    await ctx.send(
      lang === 'ru' ? '🏳️ Сначала задайте страну группы через /settings' : '🏳️ Set the group country first via /settings',
    );
    return;
  }
  const upcoming = holidayService.getUpcomingForCountry(group.country);
  const countryName = holidayService.getCountryName(group.country);
  if (upcoming.length === 0) {
    await ctx.send(
      lang === 'ru'
        ? `🎉 ${escapeHtml(countryName)} — праздников не найдено`
        : `🎉 ${escapeHtml(countryName)} — no upcoming holidays`,
      { parse_mode: 'HTML' },
    );
    return;
  }
  const lines = upcoming.map((h) => `${h.date} — ${escapeHtml(h.name)}`).join('\n');
  await ctx.send(`🎉 <b>${escapeHtml(countryName)}</b>\n\n${lines}`, { parse_mode: 'HTML' });
}

export async function handleHolidays(
  ctx: BotCommandContext,
  holidayService: HolidayService,
  groupRepo?: GroupChatRepository,
): Promise<void> {
  const user = ctx.dbUser;
  if (!user) return;
  const lang = user.language as 'en' | 'ru';
  const args = (ctx.args as string)?.trim();

  if (isGroup(ctx)) {
    await handleGroupHolidays(ctx, holidayService, groupRepo, lang);
    return;
  }

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

/** Everything a `hl:*` callback action needs; `parts` is the payload split on ':' (parts[0] is the action). */
interface HolidayCallbackScope {
  ctx: BotCallbackContext;
  holidayService: HolidayService;
  user: User;
  lang: 'en' | 'ru';
  parts: string[];
}

type HolidayCallbackAction = (scope: HolidayCallbackScope) => Promise<void>;

async function editManageList({ ctx, holidayService, user, lang }: HolidayCallbackScope): Promise<void> {
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
}

async function editCountryManagement(
  { ctx, lang }: HolidayCallbackScope,
  countryCode: string,
  countryName: string,
  subscription: HolidaySubscriptionRow,
): Promise<void> {
  await ctx.editText(countryName, {
    reply_markup: holidayManageCountryKeyboard(countryCode, subscription.is_primary === 1, !!subscription.notify, lang),
  });
}

// hl:menu
async function holidayMenuAction(scope: HolidayCallbackScope): Promise<void> {
  await scope.ctx.answer();
  return editMainMenu(scope.ctx, scope.holidayService, scope.user, scope.lang);
}

// hl:noop (pagination label)
async function holidayNoopAction({ ctx }: HolidayCallbackScope): Promise<void> {
  await ctx.answer();
}

// hl:add — show region picker
// hl:add:{region} — show country picker
// hl:add:{region}:{page} — paginated country picker
async function holidayAddAction({ ctx, holidayService, lang, parts }: HolidayCallbackScope): Promise<void> {
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
}

// hl:sub:{countryCode} — subscribe
async function holidaySubscribeAction(scope: HolidayCallbackScope): Promise<void> {
  const { ctx, holidayService, user, lang, parts } = scope;
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
async function holidayManageAction(scope: HolidayCallbackScope): Promise<void> {
  const { ctx, holidayService, user, lang, parts } = scope;
  await ctx.answer();
  const countryCode = parts[1];
  if (!countryCode) {
    if (holidayService.getSubscriptions(user.telegram_id).length === 0) {
      await ctx.editText(t(lang).holidays_no_subs as string, { parse_mode: 'HTML' });
      return;
    }
    await editManageList(scope);
    return;
  }
  const subscription = holidayService.getSubscription(user.telegram_id, countryCode);
  if (!subscription) {
    await ctx.editText(t(lang).holidays_no_subs as string, { parse_mode: 'HTML' });
    return;
  }
  await editCountryManagement(scope, countryCode, holidayService.getCountryName(countryCode), subscription);
}

// hl:primary:{countryCode}
async function holidayPrimaryAction(scope: HolidayCallbackScope): Promise<void> {
  const { ctx, holidayService, user, lang, parts } = scope;
  const countryCode = parts[1]!;
  holidayService.setPrimary(user.telegram_id, countryCode);
  const countryName = holidayService.getCountryName(countryCode);
  await ctx.answer({ text: (t(lang).holidays_set_primary as (c: string) => string)(countryName) });
  await editManageList(scope);
}

// hl:remove:{countryCode}
async function holidayRemoveAction(scope: HolidayCallbackScope): Promise<void> {
  const { ctx, holidayService, user, lang, parts } = scope;
  const countryCode = parts[1]!;
  const countryName = holidayService.getCountryName(countryCode);
  holidayService.unsubscribeUser(user.telegram_id, countryCode);
  await ctx.answer({ text: (t(lang).holidays_removed as (c: string) => string)(countryName) });
  return editMainMenu(ctx, holidayService, user, lang);
}

// hl:notify:{countryCode} — toggle notifications
async function holidayNotifyAction(scope: HolidayCallbackScope): Promise<void> {
  const { ctx, holidayService, user, lang, parts } = scope;
  const countryCode = parts[1]!;
  holidayService.toggleNotify(user.telegram_id, countryCode);
  const countryName = holidayService.getCountryName(countryCode);
  const subscription = holidayService.getSubscription(user.telegram_id, countryCode);
  if (!subscription) return;
  const notifyMsg = subscription.notify
    ? (t(lang).holidays_notify_on as (c: string) => string)(countryName)
    : (t(lang).holidays_notify_off as (c: string) => string)(countryName);
  await ctx.answer({ text: notifyMsg });
  await editCountryManagement(scope, countryCode, countryName, subscription);
}

// hl:list — upcoming holidays
async function holidayListAction({ ctx, holidayService, user, lang }: HolidayCallbackScope): Promise<void> {
  await ctx.answer();
  const text = buildUpcomingText(holidayService, user, lang);
  await ctx.editText(text ?? (t(lang).holidays_none_upcoming as string), { parse_mode: 'HTML' });
}

const HOLIDAY_CALLBACK_ACTIONS: Record<string, HolidayCallbackAction> = {
  menu: holidayMenuAction,
  noop: holidayNoopAction,
  add: holidayAddAction,
  sub: holidaySubscribeAction,
  manage: holidayManageAction,
  primary: holidayPrimaryAction,
  remove: holidayRemoveAction,
  notify: holidayNotifyAction,
  list: holidayListAction,
};

export async function handleHolidayCallback(
  ctx: BotCallbackContext,
  holidayService: HolidayService,
  user: User,
  payload: string,
): Promise<void> {
  const lang = (user.language ?? 'en') as 'en' | 'ru';
  const parts = payload.split(':');
  const actionName = parts[0]!;
  // The action comes from callback data: own keys only, so `constructor` etc. never resolve.
  if (!Object.hasOwn(HOLIDAY_CALLBACK_ACTIONS, actionName)) return;
  await HOLIDAY_CALLBACK_ACTIONS[actionName]!({ ctx, holidayService, user, lang, parts });
}
