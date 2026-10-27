// Refusals the write handlers return before touching any data: `not_applied` tells the agent loop
// the call changed nothing, so it may be corrected and retried.
import type { ToolResult } from '../../types.ts';

export const GROUP_CONTEXT_REQUIRED = 'Group context required for group scope';

export function notApplied(error: string): ToolResult {
  return { success: false, mutationState: 'not_applied', error };
}
