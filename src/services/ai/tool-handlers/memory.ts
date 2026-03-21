import type { AgentContext, ToolResult } from '../types.ts';

interface RememberUserFactInput {
  type: 'append' | 'rewrite';
  content: string;
}

export function handleRememberUserFact(ctx: AgentContext, input: RememberUserFactInput): ToolResult {
  if (!ctx.userMemoryRepo) {
    return { success: false, error: 'Memory storage not available' };
  }

  if (input.type === 'append') {
    ctx.userMemoryRepo.append(ctx.user.telegram_id, input.content);
  } else {
    ctx.userMemoryRepo.rewrite(ctx.user.telegram_id, input.content);
  }

  return { success: true, output: 'fact saved' };
}
