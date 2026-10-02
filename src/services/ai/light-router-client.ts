import OpenAI from 'openai';
import { logger } from '../../utils/logger.ts';
import { groqClient } from './clients.ts';
import type { RoutingPacketRequest } from './turn-routing.ts';

const routerLogger = logger.child({ module: 'ai-router-client' });
export const DEFAULT_LIGHT_ROUTER_MODELS = ['qwen/qwen3.8-27b', 'openai/gpt-oss-20b'] as const;

interface RouterClient {
  chat: {
    completions: {
      create(
        params: OpenAI.ChatCompletionCreateParamsNonStreaming,
        options?: { signal?: AbortSignal },
      ): Promise<OpenAI.ChatCompletion>;
    };
  };
}

function reasoningEffort(model: string): 'none' | 'low' {
  return model.includes('qwen') ? 'none' : 'low';
}

export function createLightRouterRequest(
  client: RouterClient = groqClient(),
  models: readonly string[] = DEFAULT_LIGHT_ROUTER_MODELS,
) {
  if (models.length === 0) throw new Error('EMPTY_ROUTER_MODEL_CHAIN');
  return async (packet: RoutingPacketRequest, signal: AbortSignal): Promise<string> => {
    const failures: string[] = [];
    for (const model of models) {
      signal.throwIfAborted();
      const startedAt = performance.now();
      try {
        const response = await client.chat.completions.create(
          {
            ...packet,
            model,
            temperature: 0,
            reasoning_effort: reasoningEffort(model),
          } as OpenAI.ChatCompletionCreateParamsNonStreaming,
          { signal },
        );
        const content = response.choices[0]?.message?.content?.trim();
        if (!content) throw new Error('EMPTY_ROUTER_RESPONSE');
        const usage = response.usage;
        routerLogger.info(
          {
            model,
            durationMs: Math.max(0, performance.now() - startedAt),
            promptTokens: usage?.prompt_tokens ?? null,
            completionTokens: usage?.completion_tokens ?? null,
            totalTokens: usage?.total_tokens ?? null,
            reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
            cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? null,
            success: true,
          },
          'Router model call metric',
        );
        return content;
      } catch (error) {
        signal.throwIfAborted();
        const status = error instanceof OpenAI.APIError ? error.status : undefined;
        failures.push(`${model}:${status ?? 'error'}`);
        routerLogger.warn(
          {
            model,
            durationMs: Math.max(0, performance.now() - startedAt),
            status: status ?? null,
            errorClass: error instanceof Error ? error.name : 'unknown',
            success: false,
          },
          'Router model attempt failed',
        );
      }
    }
    throw new Error(`ROUTER_MODEL_CHAIN_FAILED:${failures.join(',')}`);
  };
}
