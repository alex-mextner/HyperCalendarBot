// src/bot/commands/import.ts

import type { AnyScene } from '@gramio/scenes';
import { isGroup } from '../group-context.ts';
import type { BotCommandContext } from '../types.ts';

export async function handleImport(ctx: BotCommandContext, importScene: AnyScene): Promise<void> {
  if (isGroup(ctx)) {
    const lang = ((ctx.dbUser?.language ?? 'en') as string) === 'ru' ? 'ru' : ('en' as const);
    await ctx.send(
      lang === 'ru'
        ? '📥 Импорт доступен только в личном чате с ботом'
        : '📥 Import is only available in private chat with the bot',
    );
    return;
  }
  await ctx.scene.enter(importScene);
}
