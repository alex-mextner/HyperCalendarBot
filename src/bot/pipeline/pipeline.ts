// src/bot/pipeline/pipeline.ts

import type { BotCommandContext } from '../types.ts';
import type { FeedbackThreadContext, PipelineLayer } from './types.ts';

export async function runPipeline(ctx: BotCommandContext, messageText: string, layers: PipelineLayer[]): Promise<void> {
  let feedbackContext: FeedbackThreadContext | undefined;

  for (const layer of layers) {
    const result = await layer(ctx, messageText, { feedbackContext });
    if (result.handled) return;
    if ('feedbackContext' in result) {
      feedbackContext = result.feedbackContext;
    }
  }
}
