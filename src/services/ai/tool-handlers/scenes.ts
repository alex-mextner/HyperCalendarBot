// src/services/ai/tool-handlers/scenes.ts
import type { ScenePauseService } from '../../scene-pause.ts';
import type { AgentContext, ToolResult } from '../types.ts';

export async function handleResumeScene(ctx: AgentContext, scenePauseService: ScenePauseService): Promise<ToolResult> {
  await scenePauseService.clear(ctx.user.telegram_id);
  return {
    success: true,
    output:
      ctx.user.language === 'ru'
        ? 'Продолжай заполнение с того места, где остановился.'
        : 'Continue the wizard from where you left off.',
  };
}

export async function handleCancelScene(ctx: AgentContext, scenePauseService: ScenePauseService): Promise<ToolResult> {
  await scenePauseService.clear(ctx.user.telegram_id);
  if (ctx.sceneStorage) {
    const sceneKey = `@gramio/scenes:${ctx.user.telegram_id}`;
    await ctx.sceneStorage.delete(sceneKey);
  }
  return {
    success: true,
    output: ctx.user.language === 'ru' ? 'Мастер отменён.' : 'Wizard cancelled.',
  };
}
