// src/bot/commands/import.ts

import type { AnyScene } from '@gramio/scenes';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import { type CtxWithChat, getGroupId, isGroup } from '../group-context.ts';

interface ImportContext extends CtxWithChat {
  dbUser?: { language: string };
  send(text: string): Promise<unknown>;
  scene: { enter(scene: AnyScene, state?: { groupId: number; groupTimezone: string }): Promise<unknown> };
}

export async function handleImport(
  ctx: ImportContext,
  importScene: AnyScene,
  groupRepo?: Pick<GroupChatRepository, 'getTimezone'>,
): Promise<void> {
  if (isGroup(ctx)) {
    const groupId = getGroupId(ctx);
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
