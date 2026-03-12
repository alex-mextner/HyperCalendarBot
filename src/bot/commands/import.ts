// src/bot/commands/import.ts

import type { AnyScene } from '@gramio/scenes';
import type { BotCommandContext } from '../types.ts';

export async function handleImport(ctx: BotCommandContext, importScene: AnyScene): Promise<void> {
  await ctx.scene.enter(importScene);
}
