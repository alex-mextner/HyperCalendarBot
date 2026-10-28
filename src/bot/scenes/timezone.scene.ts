// src/bot/scenes/timezone.scene.ts
import { Scene } from '@gramio/scenes';
import { InlineKeyboard, type Keyboard } from 'gramio';
import { CB, type Lang } from '../../config/constants.ts';
import type { DatabaseService } from '../../database/index.ts';
import type { User } from '../../database/types.ts';
import { resolveCity } from '../../services/timezone/city-resolver.ts';
import { getTimezoneDisplay, resolveTimezone } from '../../services/timezone/timezone-service.ts';
import { botLogger } from '../../utils/logger.ts';
import { buildGeneralView } from '../commands/settings.ts';
import {
  cityInputPrompt,
  clearReplyKeyboard,
  type RemoveKeyboardParams,
  removeKeyboard,
  timezoneConfirmKeyboard,
  timezoneMethodKeyboard,
} from '../keyboards.ts';
import type { UserResolverComposer } from '../middleware/user-resolver.ts';

import type { TimezoneState } from './types.ts';

interface TimezoneParams {
  settingsMsgId: number;
  settingsChatId: number;
}

interface SendOptions {
  reply_markup?: InlineKeyboard | Keyboard | RemoveKeyboardParams['reply_markup'];
  parse_mode?: 'HTML';
}

interface SentMessage {
  id: number;
  delete(): Promise<unknown>;
}

/** What the timezone step handlers need from the scene context; the scene builds it once per update. */
interface TimezoneEnv {
  lang: Lang;
  user: User;
  params: TimezoneParams;
  state: TimezoneState;
  send(text: string, options?: SendOptions): Promise<SentMessage>;
  /** Merges into the scene state and stays on the same step. */
  update(patch: Partial<TimezoneState>): Promise<unknown>;
  exit(): unknown;
  deleteMessage(messageId: number): Promise<unknown>;
}

interface TimezoneCallbackEnv extends TimezoneEnv {
  answer(): Promise<unknown>;
  editText(text: string, options?: { reply_markup: InlineKeyboard }): Promise<unknown>;
  /** Deletes the message that carried the tapped button. */
  deleteSource(): Promise<unknown> | undefined;
  editMessage(args: {
    chat_id: number;
    message_id: number;
    text: string;
    reply_markup: InlineKeyboard;
  }): Promise<unknown>;
}

const backLabel = (lang: Lang) => (lang === 'ru' ? '← Назад' : '← Back');

function cancelKeyboard(lang: Lang): InlineKeyboard {
  return new InlineKeyboard().text(backLabel(lang), CB.TZ_CANCEL);
}

function deleteGeoPrompt(env: TimezoneEnv, geoMsgId: number): void {
  env
    .deleteMessage(geoMsgId)
    .catch((err: unknown) => botLogger.warn({ err }, 'tz scene: failed to delete geo message'));
}

function unresolvedCityMessage(lang: Lang): string {
  return lang === 'ru'
    ? 'Не удалось определить таймзону. Попробуй ещё раз или:\n• Введи код напрямую, например: <code>Europe/Belgrade</code>\n  Список: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones'
    : 'Could not determine timezone. Try again or:\n• Enter code directly, e.g. <code>Europe/Belgrade</code>\n  Full list: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones';
}

/** A typed city name, accepted only after the city-input mode was entered. */
async function handleTypedCity(
  env: TimezoneEnv,
  rawText: string | undefined,
  resolveCityFn: typeof resolveCity,
): Promise<void> {
  if (!env.state.cityInputMode) return;
  const text = rawText?.trim();
  if (!text) return;
  const tz = await resolveCityFn(text);
  if (!tz) {
    await env.send(unresolvedCityMessage(env.lang), { parse_mode: 'HTML' });
    return;
  }
  await env.send(`✅ ${getTimezoneDisplay(tz)}`, { reply_markup: timezoneConfirmKeyboard(env.lang) });
  await env.update({ detectedTz: tz });
}

/** A location shared via the reply keyboard. */
async function handleSharedLocation(env: TimezoneEnv, latitude: number, longitude: number): Promise<void> {
  const tz = resolveTimezone(latitude, longitude);
  const display = getTimezoneDisplay(tz);
  // Delete the geo request message now that location is received
  if (env.state.geoMsgId) deleteGeoPrompt(env, env.state.geoMsgId);
  await env.send(`✅ ${display}`, { reply_markup: timezoneConfirmKeyboard(env.lang) });
  await env.update({ detectedTz: tz });
}

/** Geo pick — show the geo reply keyboard via a new message and remember its id. */
async function startGeoPick(env: TimezoneCallbackEnv): Promise<void> {
  const { lang } = env;
  await env.answer();
  const display = getTimezoneDisplay(env.user.timezone);
  const geoPromptText =
    lang === 'ru'
      ? `🌍 Текущий: ${display}\n\nПоделись геолокацией:`
      : `🌍 Current: ${display}\n\nShare your location:`;
  await env.editText(geoPromptText, { reply_markup: cancelKeyboard(lang) });
  const geoMsg = await env.send(lang === 'ru' ? '📍 Нажми кнопку ниже:' : '📍 Tap the button below:', {
    reply_markup: timezoneMethodKeyboard(lang),
  });
  await env.update({ geoMsgId: geoMsg.id });
}

/** Enter city input mode. */
async function startCityInput(env: TimezoneCallbackEnv): Promise<void> {
  const { lang } = env;
  await env.answer();
  const display = getTimezoneDisplay(env.user.timezone);
  const header = lang === 'ru' ? `🌍 Текущий: ${display}\n\n` : `🌍 Current: ${display}\n\n`;
  const promptText = header + cityInputPrompt(lang).replace(/^🌍 /, '');
  await env.editText(promptText, { reply_markup: cancelKeyboard(lang) });
  // Send city prompt as new message — removes any stale reply keyboard
  await env.send(cityInputPrompt(lang), removeKeyboard());
  await env.update({ cityInputMode: true });
}

/** Cancel — restore general settings. */
async function cancelTimezoneChange(env: TimezoneCallbackEnv): Promise<void> {
  await env.answer();
  const { geoMsgId } = env.state;
  await env.exit();
  const { text: settingsText, kb: settingsKb } = buildGeneralView(env.user);
  await env.editText(settingsText, { reply_markup: settingsKb });
  // If geo request was active: delete its message and remove reply keyboard
  if (geoMsgId) {
    deleteGeoPrompt(env, geoMsgId);
    await clearReplyKeyboard((text, params) => env.send(text, params));
  }
}

/** Confirm — save timezone, update the settings message. */
async function confirmTimezone(env: TimezoneCallbackEnv, db: DatabaseService): Promise<void> {
  const pendingTz = env.state.detectedTz;
  if (!pendingTz) {
    await env.answer();
    return;
  }
  const updatedUser = db.users.update(env.user.telegram_id, { timezone: pendingTz });
  await env.exit();
  // Edit the confirm message to show success
  await env.editText(`✅ ${getTimezoneDisplay(pendingTz)}`);
  // Restore general settings in the original settings message
  const { settingsMsgId, settingsChatId } = env.params;
  if (updatedUser && settingsMsgId && settingsChatId) {
    const { text, kb } = buildGeneralView(updatedUser);
    await env.editMessage({ chat_id: settingsChatId, message_id: settingsMsgId, text, reply_markup: kb });
  }
  await env.answer();
}

/** Retry — delete the confirm message, user can type another city. */
async function retryCity(env: TimezoneCallbackEnv): Promise<void> {
  await env.answer();
  await env.deleteSource();
}

async function handleTimezoneCallback(
  env: TimezoneCallbackEnv,
  data: string | undefined,
  db: DatabaseService,
): Promise<void> {
  if (!data) return;
  switch (data.split(':')[0]) {
    case CB.TZ_GEO_PICK:
      return startGeoPick(env);
    case CB.TZ_TYPE_CITY:
      return startCityInput(env);
    case CB.TZ_CANCEL:
      return cancelTimezoneChange(env);
    case CB.ONBOARD_TZ:
      return confirmTimezone(env, db);
    case CB.ONBOARD_TZ_RETRY:
      return retryCity(env);
    default:
      await env.answer();
  }
}

export function createTimezoneScene(
  db: DatabaseService,
  userComposer: UserResolverComposer,
  resolveCityFn: typeof resolveCity = resolveCity,
) {
  return (
    new Scene('timezone')
      .state<TimezoneState>()
      .params<TimezoneParams>()
      // extend() AFTER params() — params() uses Modify which replaces Derives.global
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
          .text(backLabel(lang), CB.TZ_CANCEL);

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
        const env: TimezoneEnv = {
          lang: context.lang,
          user,
          params: context.scene.params as TimezoneParams,
          state: context.scene.state,
          send: (text, options) => context.send(text, options),
          update: (patch) => context.scene.update(patch, { step: undefined }),
          exit: () => context.scene.exit(),
          deleteMessage: (messageId) =>
            context.bot.api.deleteMessage({ chat_id: context.chatId ?? 0, message_id: messageId }),
        };

        if (context.is('message')) {
          await handleTypedCity(env, context.text, resolveCityFn);
        } else if (context.is('location')) {
          await handleSharedLocation(env, context.eventLocation.latitude, context.eventLocation.longitude);
        } else if (context.is('callback_query')) {
          await handleTimezoneCallback(
            {
              ...env,
              answer: () => context.answer(),
              editText: (text, options) => context.editText(text, options),
              deleteSource: () => context.message?.delete(),
              editMessage: (args) => context.bot.api.editMessageText(args),
            },
            context.data,
            db,
          );
        }
      })
  );
}
