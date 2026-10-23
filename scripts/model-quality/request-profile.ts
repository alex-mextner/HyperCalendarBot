import type OpenAI from 'openai';
import { createToolExposure } from '../../src/services/ai/tool-exposure.ts';

/** The tool catalog a request carries: every schema (production default) or lazy exposure with discovery. */
export function createRequestCatalog(mode: 'full' | 'lazy', tools: OpenAI.ChatCompletionTool[]) {
  const exposure = mode === 'lazy' ? createToolExposure(tools) : undefined;
  return { prompt: exposure?.prompt ?? '', schemas: () => exposure?.schemas() ?? tools, exposure };
}
