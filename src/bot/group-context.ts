export type ChatType = 'group' | 'supergroup' | 'private' | 'channel';

export interface CtxWithChat {
  chat?: { type: string; id: number };
  message?: { chat?: { type: string; id: number } };
}

function resolveChat(ctx: CtxWithChat): { type: string; id: number } | undefined {
  return ctx.chat ?? ctx.message?.chat;
}

export function isGroup(ctx: CtxWithChat): boolean {
  const chat = resolveChat(ctx);
  return chat?.type === 'group' || chat?.type === 'supergroup';
}

export function getGroupId(ctx: CtxWithChat): number | null {
  const chat = resolveChat(ctx);
  if (chat?.type !== 'group' && chat?.type !== 'supergroup') return null;
  return chat.id;
}
