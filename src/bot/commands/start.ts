// src/bot/commands/start.ts

import type { AnyScene } from '@gramio/scenes';
import { t } from '../../config/constants.ts';
import type { User } from '../../database/types.ts';
import type { BotCommandContext } from '../types.ts';

export async function handleStart(ctx: BotCommandContext, onboardingScene: AnyScene): Promise<void> {
  const user = ctx.dbUser as User;

  if (user.onboarding_completed) {
    const lang = user.language as 'en' | 'ru';
    await ctx.send(t(lang).welcome_back);
    return;
  }

  await ctx.scene.enter(onboardingScene);
}
