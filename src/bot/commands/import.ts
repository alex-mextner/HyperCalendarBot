// src/bot/commands/import.ts

import type { AnyScene } from '@gramio/scenes';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import { type CtxWithChat, getGroupId, isGroup } from '../group-context.ts';
import type { BotCommandContext } from '../types.ts';

export async function handleImport(
  ctx: BotCommandContext,
  importScene: AnyScene,
  groupRepo?: GroupChatRepository,
): Promise<void> {
  if (isGroup(ctx as unknown as CtxWithChat)) {
    const groupId = getGroupId(ctx as unknown as CtxWithChat);
    if (groupId === null) return;
    const timezone = groupRepo?.getTimezone(groupId) ?? null;
    const lang = (ctx.dbUser?.language ?? 'en') === 'ru' ? 'ru' : ('en' as const);
    if (!timezone) {
      await ctx.send(
        lang === 'ru'
          ? '⚙️ Сначала задайте таймзону группы через /settings'
          : '⚙️ Set the group timezone first via /settings',
      );
      return;
    }
    await ctx.scene.enter(importScene, { groupId, groupTimezone: timezone });
    return;
  }
  await ctx.scene.enter(importScene);
}
