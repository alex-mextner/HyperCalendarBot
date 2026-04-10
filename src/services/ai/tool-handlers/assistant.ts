import type { AgentCommand } from '../../../agent/protocol.ts';
import type { AgentContext, ToolResult } from '../types.ts';

function notConnected(lang: string): ToolResult {
  return {
    success: false,
    error:
      lang === 'ru'
        ? '⚠️ Агент не подключён. Скачай и настрой: /connect'
        : '⚠️ Agent not connected. Download and set up: /connect',
  };
}

export async function handleAssistantTool(
  ctx: AgentContext,
  toolName: AgentCommand['type'],
  payload: AgentCommand['payload'],
): Promise<ToolResult> {
  if (!ctx.agents?.agentRegistry.isConnected(ctx.user.telegram_id)) {
    return notConnected(ctx.user.language);
  }

  const chunks: string[] = [];
  const onChunk = (text: string) => {
    chunks.push(text);
    ctx.agents?.onAgentChunk?.(text);
  };

  try {
    const result = await ctx.agents.agentDispatcher.send(ctx.user.telegram_id, toolName, payload, onChunk);
    const streamed = chunks.join('');
    const dataText =
      streamed ||
      (result.data == null ? '' : typeof result.data === 'string' ? result.data : JSON.stringify(result.data));
    const exitInfo = result.exitCode !== undefined ? ` (exit ${result.exitCode})` : '';
    return {
      success: result.exitCode === undefined || result.exitCode === 0,
      output: dataText + exitInfo,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
