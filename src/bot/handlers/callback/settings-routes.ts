// src/bot/handlers/callback/settings-routes.ts
// Settings, timezone detection, feature tour and voice-reply prompt callbacks.

import type { Lang } from '../../../config/constants.ts';
import { CB, t } from '../../../config/constants.ts';
import type { ChatHistoryMessage } from '../../../database/types.ts';
import { guessCountryFromTimezone } from '../../../services/timezone/timezone-service.ts';
import {
  fixDateOrdinals,
  fixLineBreaks,
  markStress,
  numbersToWords,
  stripMarkdown,
  transliterateEnglish,
} from '../../../services/voice/stress-marker.ts';
import { cmdLogger } from '../../../utils/logger.ts';
import { formatUtcOffset } from '../../../utils/telegram.ts';
import { handleFeatureTourCallback } from '../../commands/feature-tour.ts';
import { handleSettingsCallback, pendingGroupTzInput } from '../../commands/settings.ts';
import type { CallbackDispatch, CallbackHandlerOpts, CallbackRouteDeps } from './types.ts';

type VoiceDeps = NonNullable<CallbackHandlerOpts['voiceDeps']>;

function canSynthesize(voiceDeps: VoiceDeps, isRu: boolean): boolean {
  return isRu ? !!(voiceDeps.sileroTts && voiceDeps.stressDictionary) : !!voiceDeps.kokoroTts;
}

/** The text blocks of the newest assistant message in the history, or '' when there is none. */
function lastAssistantText(history: ChatHistoryMessage[]): string {
  const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant');
  if (!lastAssistant) return '';
  try {
    const blocks = JSON.parse(lastAssistant.content) as { type: string; text?: string }[];
    if (!Array.isArray(blocks)) return lastAssistant.content;
    return blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  } catch {
    return lastAssistant.content;
  }
}

async function synthesizeVoice(voiceDeps: VoiceDeps, isRu: boolean, text: string): Promise<Buffer | undefined> {
  if (isRu && voiceDeps.sileroTts && voiceDeps.stressDictionary) {
    const withNumbers = numbersToWords(fixDateOrdinals(text));
    const withStress = markStress(withNumbers, voiceDeps.stressDictionary);
    return voiceDeps.sileroTts.synthesize(transliterateEnglish(withStress));
  }
  if (!isRu && voiceDeps.kokoroTts) return voiceDeps.kokoroTts.synthesize(text);
  return undefined;
}

export function registerSettingsRoutes(dispatch: CallbackDispatch, deps: CallbackRouteDeps): void {
  const { prefsService } = deps;
  const {
    chatHistoryRepo,
    callSettingsRepo,
    sharingSettingsRepo,
    userRepo,
    voiceDeps,
    timezoneScene,
    connectTelegramScene,
    telegramDeps,
    groupRepo,
  } = deps.opts;

  // Feature tour
  dispatch.set(CB.FEATURE_TOUR, async (ctx, payload) => {
    return handleFeatureTourCallback(ctx, payload);
  });

  // Settings category picker
  dispatch.set('stg', async (ctx, payload, _parts, user) => {
    if (payload === 'change_tz') {
      if (!timezoneScene) {
        cmdLogger.error('timezoneScene not wired into createCallbackHandler');
        const lang = (user.language ?? 'en') as Lang;
        await ctx.answer(t(lang).callbackErrors.unavailable);
        return;
      }
      if (!ctx.message || !ctx.chatId) {
        cmdLogger.warn({ userId: user.telegram_id }, 'settings change_tz: missing message or chatId');
        await ctx.answer();
        return;
      }
      await ctx.answer();
      await ctx.scene.enter(timezoneScene, { settingsMsgId: ctx.message.id, settingsChatId: ctx.chatId });
      return;
    }
    const tgDeps =
      telegramDeps && connectTelegramScene
        ? {
            sessionRepo: telegramDeps.sessionRepo,
            masterKey: telegramDeps.masterKey,
            enterScene: async () => {
              await ctx.scene.enter(connectTelegramScene);
            },
          }
        : undefined;
    return handleSettingsCallback(
      ctx,
      user,
      payload,
      prefsService,
      callSettingsRepo,
      sharingSettingsRepo,
      userRepo,
      tgDeps,
    );
  });

  // Geo-location timezone: confirm update
  dispatch.set(CB.GEO_TZ_CONFIRM, async (ctx, payload, _parts, user) => {
    const tz = payload; // IANA timezone string, e.g. "Europe/Moscow"
    const lang = (user.language ?? 'en') as Lang;
    // Validate that the timezone is a real IANA zone
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz });
    } catch {
      await ctx.answer({ text: t(lang).callbackErrors.error });
      return;
    }
    if (!userRepo) {
      cmdLogger.warn({ userId: user.telegram_id }, 'GEO_TZ_CONFIRM: userRepo not available');
      await ctx.answer({ text: t(lang).callbackErrors.error });
      return;
    }
    const countryCode = guessCountryFromTimezone(tz);
    userRepo.update(user.telegram_id, {
      timezone: tz,
      ...(countryCode ? { country_code: countryCode } : {}),
    });
    const offset = formatUtcOffset(tz);
    await ctx.answer();
    await ctx.editText(t(lang).geo_tz_updated(tz, offset), { reply_markup: undefined });
  });

  // Geo-location timezone: dismiss (keep current)
  dispatch.set(CB.GEO_TZ_DISMISS, async (ctx, _payload, _parts, user) => {
    const lang = (user.language ?? 'en') as Lang;
    await ctx.answer();
    await ctx.editText(t(lang).geo_tz_dismissed, { reply_markup: undefined });
  });

  // Group settings: timezone picker
  dispatch.set(CB.GROUP_SETTINGS_TZ, async (ctx, payload, _parts, user) => {
    if (!groupRepo) return;
    const chatId = ctx.chatId ?? null;
    if (!chatId) {
      await ctx.answer();
      return;
    }
    if (payload === 'select') {
      await ctx.answer();
      const prompt =
        user.language === 'ru'
          ? '🌍 Введите название города для группы:\n\nПримеры: Белград, Belgrade, Нью-Йорк, Bangkok'
          : '🌍 Enter city name for the group:\n\nExamples: Belgrade, New York, Bangkok';
      pendingGroupTzInput.set(user.telegram_id, { chatId, ts: Date.now(), lang: user.language as 'en' | 'ru' });
      await ctx.send(prompt);
      return;
    }
    // Stale callback from old region/city buttons — just dismiss it
    await ctx.answer();
  });

  // Voice response opt-in prompt response
  dispatch.set('voice_prompt', async (ctx, payload, _parts, user) => {
    if (!userRepo) {
      await ctx.answer();
      return;
    }
    const enabled = payload === 'yes' ? 1 : 0;
    userRepo.update(user.telegram_id, { voice_response_enabled: enabled });
    await ctx.answer();

    const lang = (user.language ?? 'en') as Lang;
    const msgs = t(lang);

    if (!enabled) {
      await ctx.editText(msgs.voice_response_disabled);
      return;
    }

    // On opt-in: resend the last AI response as voice so user hears it immediately
    const isRu = user.language === 'ru';
    const chatIdNum = ctx.chatId ? Number(ctx.chatId) : null;

    if (!voiceDeps || !chatHistoryRepo || !chatIdNum || !canSynthesize(voiceDeps, isRu)) {
      await ctx.editText(msgs.voice_response_enabled);
      return;
    }

    await ctx.editText('⌛');

    try {
      const responseText = lastAssistantText(chatHistoryRepo.getRecent(user.telegram_id, 10));
      if (responseText.trim()) {
        const audio = await synthesizeVoice(voiceDeps, isRu, fixLineBreaks(stripMarkdown(responseText)));
        if (audio) {
          await voiceDeps.sendVoice(chatIdNum, audio);
        }
      }
    } catch (err) {
      cmdLogger.error({ err: err }, 'Voice opt-in TTS error');
      await ctx.editText(msgs.voice_demo_failed).catch(() => {});
      return;
    }

    await ctx.editText(msgs.voice_response_enabled).catch(() => {});
  });

  // Connected-Telegram timezone detection: user confirms update
  dispatch.set(CB.CT_TZ_UPDATE, async (ctx, payload, _parts, user) => {
    const iana = payload;
    const lang = (user.language ?? 'en') as Lang;
    try {
      Intl.DateTimeFormat(undefined, { timeZone: iana });
    } catch {
      await ctx.answer({ text: t(lang).callbackErrors.error });
      return;
    }
    if (!userRepo) {
      cmdLogger.warn({ userId: user.telegram_id }, 'CT_TZ_UPDATE: userRepo not available');
      await ctx.answer({ text: t(lang).callbackErrors.error });
      return;
    }
    const countryCode = guessCountryFromTimezone(iana);
    userRepo.update(user.telegram_id, {
      timezone: iana,
      ...(countryCode ? { country_code: countryCode } : {}),
    });
    await ctx.answer();
    await ctx.editText(t(lang).connectTelegram.tzUpdated(iana), { reply_markup: undefined });
  });

  // Connected-Telegram timezone detection: user skips
  dispatch.set(CB.CT_TZ_SKIP, async (ctx, _payload, _parts, user) => {
    const lang = (user.language ?? 'en') as Lang;
    await ctx.answer();
    await ctx.editText(t(lang).connectTelegram.tzSkipped, { reply_markup: undefined });
  });

  // Timezone detection consent: user allows
  dispatch.set(CB.CT_TZ_CONSENT_YES, async (ctx, _payload, _parts, user) => {
    const lang = (user.language ?? 'en') as Lang;
    if (!telegramDeps?.sessionRepo) {
      cmdLogger.warn({ userId: user.telegram_id }, 'CT_TZ_CONSENT_YES: sessionRepo not available');
      await ctx.answer({ text: t(lang).callbackErrors.error });
      return;
    }
    telegramDeps.sessionRepo.setTzConsentAt(user.telegram_id, new Date().toISOString());
    await ctx.answer();
    await ctx.editText(t(lang).connectTelegram.tzConsentYes, { reply_markup: undefined });
  });

  // Timezone detection consent: user refuses
  dispatch.set(CB.CT_TZ_CONSENT_NO, async (ctx, _payload, _parts, user) => {
    const lang = (user.language ?? 'en') as Lang;
    if (!telegramDeps?.sessionRepo) {
      cmdLogger.warn({ userId: user.telegram_id }, 'CT_TZ_CONSENT_NO: sessionRepo not available');
      await ctx.answer({ text: t(lang).callbackErrors.error });
      return;
    }
    telegramDeps.sessionRepo.setTzConsentAt(user.telegram_id, 'never');
    await ctx.answer();
    await ctx.editText(t(lang).connectTelegram.tzConsentNo, { reply_markup: undefined });
  });
}
