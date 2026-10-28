// src/bot/handlers/callback.handler.ts
// Entry point for inline-keyboard callbacks: builds the action → handler table from the per-feature
// route groups under ./callback/ and dispatches by the callback-data prefix.

import type { AnyScene } from '@gramio/scenes';
import { z } from 'zod';
import type { Lang } from '../../config/constants.ts';
import { CB, t, toLang } from '../../config/constants.ts';
import type { EventService } from '../../services/event/event-service.ts';
import type { HolidayService } from '../../services/holiday/holiday-service.ts';
import type { NotificationPreferencesService } from '../../services/notification/preferences.ts';
import { jsonCodec } from '../../utils/json-codec.ts';
import { cmdLogger } from '../../utils/logger.ts';
import type { AddEventState, OnboardingState, TimezoneState } from '../scenes/types.ts';
import type { BotCallbackContext } from '../types.ts';
import { registerAdminRoutes } from './callback/admin-routes.ts';
import { registerAgendaRoutes } from './callback/agenda-routes.ts';
import { registerAiRoutes } from './callback/ai-routes.ts';
import { registerEventRoutes } from './callback/event-routes.ts';
import { registerInvitationRoutes } from './callback/invitation-routes.ts';
import { registerInviteRoutes } from './callback/invite-routes.ts';
import { registerLocationRoutes } from './callback/location-routes.ts';
import { registerProposalRoutes } from './callback/proposal-routes.ts';
import { registerSettingsRoutes } from './callback/settings-routes.ts';
import type { CallbackDispatch, CallbackHandlerOpts, CallbackRouteDeps } from './callback/types.ts';

export { parseAiBtnPayload } from './callback/ai-routes.ts';
export {
  handleProposalAccept,
  handleProposalDecline,
  handleSecretaryAccept,
  handleSecretaryDecline,
} from './callback/secretary-proposal-handlers.ts';
export type {
  CallbackHandlerOpts,
  ForceInviteDeps,
  ProposalDeps,
  SecretaryDeps,
  SnoozeDeps,
} from './callback/types.ts';

/**
 * Route all inline keyboard callbacks.
 * Callback data format: "prefix:payload" or "prefix:p1:p2"
 */
export function createCallbackHandler(
  eventService: EventService,
  editValueScene: AnyScene,
  holidayService: HolidayService,
  prefsService: NotificationPreferencesService,
  opts: CallbackHandlerOpts = {},
) {
  const { scenePauseDeps } = opts;
  const dispatch: CallbackDispatch = new Map();
  const routeDeps: CallbackRouteDeps = { eventService, editValueScene, holidayService, prefsService, opts };
  registerAiRoutes(dispatch, routeDeps);
  registerEventRoutes(dispatch, routeDeps);
  registerAgendaRoutes(dispatch, routeDeps);
  registerInvitationRoutes(dispatch, routeDeps);
  registerProposalRoutes(dispatch, routeDeps);
  registerInviteRoutes(dispatch, routeDeps);
  registerSettingsRoutes(dispatch, routeDeps);
  registerLocationRoutes(dispatch, routeDeps);
  registerAdminRoutes(dispatch, routeDeps);

  return async (ctx: BotCallbackContext) => {
    const data = ctx.data as string;
    if (!data) return;

    const parts = data.split(':');
    const action = parts[0]!;
    const payload = parts.slice(1).join(':');

    const user = ctx.dbUser;
    if (!user) {
      await answerMissingUser(ctx, action);
      return;
    }

    try {
      const handler = dispatch.get(action);
      if (handler) {
        await handler(ctx, payload, parts, user, data);
      } else {
        cmdLogger.warn({ action, payload }, 'Unknown callback action');
        await ctx.answer();
        if (!scenePauseDeps) return;

        const rawScene = await scenePauseDeps.sceneStorage.get(`@gramio/scenes:${user.telegram_id}`);
        if (!rawScene) return;

        await pauseActiveScene(scenePauseDeps, user.telegram_id, rawScene);

        const lang = user.language as 'en' | 'ru';
        await ctx.send(t(lang).callbackErrors.sceneHelpPrompt);
        return;
      }
    } catch (error) {
      await answerHandlerError(ctx, action, user.language, error);
    }
  };
}

/**
 * dbUser is created on the fly from the update's `from` (see createUserResolver), so it is
 * absent only when the update carries no usable `from` — an anonymous group admin or a
 * channel. A group RSVP tap from such a sender can't be attributed to a person, so prompt
 * them to DM the bot instead of dropping the tap in silence.
 */
async function answerMissingUser(ctx: BotCallbackContext, action: string): Promise<void> {
  if (action !== CB.GROUP_RSVP) return;
  // No dbUser means no resolved language; fall back to the tapper's Telegram client language
  // (`from.languageCode`) when present, else English.
  const hintLang = toLang(ctx.from?.languageCode);
  await ctx
    .answer({ text: t(hintLang).group_rsvp_start_hint, show_alert: true })
    .catch((e) => cmdLogger.debug({ err: e }, 'answer() group RSVP start hint'));
}

const storedSceneSchema = jsonCodec(
  z.object({
    name: z.string(),
    step: z.number(),
    state: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  }),
);

type ScenePauseDeps = NonNullable<CallbackHandlerOpts['scenePauseDeps']>;

/** Saves the user's running scene so the help prompt can resume it; unparseable state is skipped. */
async function pauseActiveScene(scenePauseDeps: ScenePauseDeps, telegramId: number, rawScene: unknown): Promise<void> {
  try {
    const parsed = storedSceneSchema.parse(rawScene as string);
    const sceneName = parsed.name;
    const step = parsed.step;
    const state = parsed.state ?? {};
    // Build pause state matching scene name to its typed state
    if (sceneName === 'add_event') {
      await scenePauseDeps.scenePauseService.save(telegramId, {
        sceneName: 'add_event',
        step,
        sceneState: state as AddEventState,
      });
    } else if (sceneName === 'timezone') {
      await scenePauseDeps.scenePauseService.save(telegramId, {
        sceneName: 'timezone',
        step,
        sceneState: state as TimezoneState,
      });
    } else if (sceneName === 'onboarding') {
      await scenePauseDeps.scenePauseService.save(telegramId, {
        sceneName: 'onboarding',
        step,
        sceneState: state as OnboardingState,
      });
    } else if (sceneName === 'edit_value' || sceneName === 'import') {
      await scenePauseDeps.scenePauseService.save(telegramId, { sceneName, step, sceneState: {} });
    }
  } catch {
    // proceed with defaults — scene state unparseable
  }
}

async function answerHandlerError(ctx: BotCallbackContext, action: string, language: string, error: unknown) {
  const errStr = String(error);
  // Duplicate click — message already updated, silently acknowledge
  if (errStr.includes('message is not modified')) {
    await ctx.answer().catch((e) => cmdLogger.debug({ err: e }, 'answer() after duplicate click'));
    return;
  }
  cmdLogger.error({ err: error, action }, 'Callback handler error');
  const lang = (language ?? 'en') as Lang;
  await ctx
    .answer({ text: t(lang).callbackErrors.error })
    .catch((e) => cmdLogger.debug({ err: e }, 'answer() in error handler'));
}
