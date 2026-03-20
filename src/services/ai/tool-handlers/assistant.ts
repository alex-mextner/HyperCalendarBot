import type { AgentCommand } from '../../../agent/protocol.ts';
import type { AgentContext, ToolResult } from '../types.ts';

function notConnected(lang: string): ToolResult {
  return {
    success: false,
    output:
      lang === 'ru'
        ? '⚠️ Агент не подключён. Скачай и настрой: /connect'
        : '⚠️ Agent not connected. Download and set up: /connect',
  };
}

export async function handleAssistantTool(
  ctx: AgentContext,
  toolName: AgentCommand['type'],
  payload: Record<string, unknown>,
): Promise<ToolResult> {
  if (!ctx.agentRegistry?.isConnected(ctx.user.telegram_id)) {
    return notConnected(ctx.user.language);
  }

  const chunks: string[] = [];
  const onChunk = (text: string) => {
    chunks.push(text);
    ctx.onAgentChunk?.(text);
  };

  try {
    const result = await ctx.agentDispatcher!.send(ctx.user.telegram_id, toolName, payload, onChunk);
    const text = chunks.join('') || String(result.data ?? '');
    const exitInfo = result.exitCode !== undefined ? ` (exit ${result.exitCode})` : '';
    return {
      success: result.exitCode === undefined || result.exitCode === 0,
      output: text + exitInfo,
      data: result.data,
    };
  } catch (err) {
    return {
      success: false,
      output: err instanceof Error ? err.message : String(err),
    };
  }
}
