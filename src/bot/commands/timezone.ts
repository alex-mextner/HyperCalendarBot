// src/bot/commands/timezone.ts

import type { AnyScene } from '@gramio/scenes';
import type { BotCommandContext } from '../types.ts';

export async function handleTimezone(ctx: BotCommandContext, timezoneScene: AnyScene): Promise<void> {
  await ctx.scene.enter(timezoneScene);
}
