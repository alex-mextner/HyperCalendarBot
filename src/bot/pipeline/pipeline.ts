// src/bot/pipeline/pipeline.ts

import type { BotCommandContext } from '../types.ts';
import type { FeedbackThreadContext, GroupContext, PipelineLayer } from './types.ts';

export async function runPipeline(
  ctx: BotCommandContext,
  messageText: string,
  layers: PipelineLayer[],
  groupContext?: GroupContext,
): Promise<void> {
  let feedbackContext: FeedbackThreadContext | undefined;
  let supplementMode = false;
  let supplementAutoResponse: string | undefined;

  for (const layer of layers) {
    const result = await layer(ctx, messageText, {
      feedbackContext,
      groupContext,
      supplementMode,
      supplementAutoResponse,
    });
    if (result.handled) {
      if ('needsSupplement' in result) {
        supplementMode = true;
        supplementAutoResponse = result.supplementAutoResponse;
        continue;
      }
      return;
    }
    if ('feedbackContext' in result) {
      feedbackContext = result.feedbackContext;
    }
  }
}
