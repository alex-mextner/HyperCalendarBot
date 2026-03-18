export type ChatType = 'group' | 'supergroup' | 'private' | 'channel';

export interface CtxWithChat {
  chat?: { type: ChatType; id: number };
}

export function isGroup(ctx: CtxWithChat): boolean {
  return ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
}

export function getGroupId(ctx: CtxWithChat): number | null {
  if (!isGroup(ctx)) return null;
  return ctx.chat?.id ?? null;
}
