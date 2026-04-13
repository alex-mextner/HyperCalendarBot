// src/services/ai/tool-handlers/scenes.ts
import { t } from '../../../config/constants.ts';
import { logger } from '../../../utils/logger.ts';
import type { ScenePauseService } from '../../scene-pause.ts';
import type { AgentContext, ToolHandlerMeta, ToolResult } from '../types.ts';

const toolLogger = logger.child({ module: 'scene-tools' });

export async function handleResumeScene(ctx: AgentContext, scenePauseService: ScenePauseService): Promise<ToolResult> {
  await scenePauseService.clear(ctx.user.telegram_id);
  return {
    success: true,
    output: t(ctx.user.language).aiTools.meta.sceneResumed,
  };
}
handleResumeScene.meta = { skipActionLog: true } satisfies ToolHandlerMeta;

export async function handleCancelScene(ctx: AgentContext, scenePauseService: ScenePauseService): Promise<ToolResult> {
  await scenePauseService.clear(ctx.user.telegram_id);
  if (ctx.sceneStorage) {
    const sceneKey = `@gramio/scenes:${ctx.user.telegram_id}`;
    await ctx.sceneStorage.delete(sceneKey);
  } else {
    toolLogger.warn(
      { userId: ctx.user.telegram_id },
      'cancel_scene: sceneStorage not available, scene key not deleted',
    );
  }
  return {
    success: true,
    output: t(ctx.user.language).aiTools.meta.sceneCancelled,
  };
}
handleCancelScene.meta = { skipActionLog: true } satisfies ToolHandlerMeta;
