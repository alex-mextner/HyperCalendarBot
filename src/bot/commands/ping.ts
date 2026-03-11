// src/bot/commands/ping.ts
import { t } from '../../config/constants.ts';
import type { User } from '../../database/types.ts';

export async function handlePing(ctx: any): Promise<void> {
  const start = Date.now();
  const lang = (ctx.dbUser as User)?.language ?? 'en';
  const ms = Date.now() - start;
  await ctx.send(t(lang as 'en' | 'ru').pong(ms));
}
