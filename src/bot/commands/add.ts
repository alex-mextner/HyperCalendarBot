// src/bot/commands/add.ts
import type { AnyScene } from '@gramio/scenes';
import { t } from '../../config/constants.ts';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import { getGroupId } from '../group-context.ts';
import { parseWizardDateTime } from '../scenes/add-event.scene.ts';
import type { AddEventParams } from '../scenes/types.ts';
import type { BotCommandContext } from '../types.ts';

export async function handleAdd(
  ctx: BotCommandContext,
  addEventScene: AnyScene,
  groupRepo?: GroupChatRepository,
): Promise<void> {
  const user = ctx.dbUser;
  if (!user) return;
  const groupId = getGroupId(ctx);
  const timezone = groupId === null ? user.timezone : groupRepo?.getTimezone(groupId);
  if (!timezone) {
    await ctx.send(t(user.language).addWizard.noGroupTimezone);
    return;
  }
  const params: AddEventParams = { timezone, ...(groupId !== null ? { groupId } : {}) };
  const input = ctx.args?.trim();
  if (input) {
    params.title = input;
    // Longest plausible date suffix first; the title itself remains verbatim.
    for (const boundary of [...input.matchAll(/\s+/g)].slice(-8)) {
      const suffix = input.slice(boundary.index + boundary[0].length);
      const parsed = parseWizardDateTime(suffix, timezone);
      if (parsed.kind !== 'complete' && parsed.kind !== 'needs_time') continue;
      params.title = input.slice(0, boundary.index).trim();
      if (parsed.kind === 'complete') params.startAt = parsed.startAt;
      else params.pendingDate = parsed.localDate;
      break;
    }
  }
  // Command arguments seed the same draft as the guided flow, never a separate write path.
  await ctx.scene.enter(addEventScene, params);
}
