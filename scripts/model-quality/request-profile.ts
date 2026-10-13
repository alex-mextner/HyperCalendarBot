import type OpenAI from 'openai';
import { createToolExposure } from '../../src/services/ai/tool-exposure.ts';
export function createRequestCatalog(mode: 'full' | 'lazy', tools: OpenAI.ChatCompletionTool[]) {
  const exposure = mode === 'lazy' ? createToolExposure(tools) : undefined;
  return { prompt: exposure?.prompt ?? '', schemas: () => exposure?.schemas() ?? tools, exposure };
}
/** Provider-owned continuation metadata stays in memory, never in reports. */
export function preserveAssistant(
  message: OpenAI.ChatCompletionMessage,
  provider: string,
): OpenAI.ChatCompletionAssistantMessageParam {
  return {
    ...message,
    role: 'assistant',
    content: provider === 'together' ? (message.content ?? '') : message.content,
  };
}
export function modelAdvertised(_provider: string, id: string, available: string[]): boolean {
  return available.some(
    (name) => name === id || (_provider === 'gemini' && name.replace(/^models\//, '') === id.replace(/^models\//, '')),
  );
}
export function isTransportConfigurationError(_error: string | null, _detail?: string): boolean {
  return _error === 'HTTP_400' && /only supports streaming/i.test(_detail ?? '');
}
