// src/bot/commands/add.ts
import type { AnyScene } from '@gramio/scenes';
import { t } from '../../config/constants.ts';
import type { GroupChatRepository } from '../../database/repositories/group-chat.repository.ts';
import { getGroupId } from '../group-context.ts';
import { parseWizardDateTime } from '../scenes/add-event.scene.ts';
import type { AddEventParams } from '../scenes/types.ts';
import type { BotCommandContext } from '../types.ts';
import { type DialogueV3AddDeps, tryFullFieldAdd } from './add-v3.ts';

export interface AddCommandDeps {
  readonly dialogueV3?: DialogueV3AddDeps;
}

export async function handleAdd(
  ctx: BotCommandContext,
  addEventScene: AnyScene,
  groupRepo?: GroupChatRepository,
  deps?: AddCommandDeps,
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
    // GH-652: a fully specified command (title + time/all-day, zero LLM calls, reading the
    // shared event.create registration) executes here directly. Production (bot/index.ts)
    // always passes `deps.dialogueV3`; the actual on/off switch is `deps.dialogueV3.enabled`
    // (DIALOGUE_V3_ENABLED, src/config/env.ts), checked first thing inside `tryFullFieldAdd` —
    // when it's false, `tryFullFieldAdd` returns `{handled:false, seed:{}}` immediately and
    // `workingInput` stays exactly `input`, so the rest of this function is byte-identical to
    // before GH-652. A caller that omits `deps` entirely (e.g. an older test) skips this branch.
    let workingInput = input;
    if (deps?.dialogueV3) {
      const outcome = await tryFullFieldAdd(ctx, user, timezone, groupId, input, deps.dialogueV3);
      if (outcome.handled) return;
      if (outcome.seed.startAt) {
        params.title = outcome.seed.title ?? input;
        params.startAt = outcome.seed.startAt;
        await ctx.scene.enter(addEventScene, params);
        return;
      }
      if (outcome.seed.title) workingInput = outcome.seed.title;
    }
    params.title = workingInput;
    // Longest plausible date suffix first; the title itself remains verbatim.
    for (const boundary of [...workingInput.matchAll(/\s+/g)].slice(-8)) {
      const suffix = workingInput.slice(boundary.index + boundary[0].length);
      const parsed = parseWizardDateTime(suffix, timezone);
      if (parsed.kind !== 'complete' && parsed.kind !== 'needs_time') continue;
      params.title = workingInput.slice(0, boundary.index).trim();
      if (parsed.kind === 'complete') params.startAt = parsed.startAt;
      else params.pendingDate = parsed.localDate;
      break;
    }
  }
  // Command arguments seed the same draft as the guided flow, never a separate write path.
  await ctx.scene.enter(addEventScene, params);
}
