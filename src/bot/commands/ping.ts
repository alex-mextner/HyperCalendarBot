// src/bot/commands/ping.ts
import { t } from '../../config/constants.ts';
import type { BotCommandContext } from '../types.ts';

export async function handlePing(ctx: BotCommandContext): Promise<void> {
  const start = Date.now();
  const lang = ctx.dbUser?.language ?? 'en';
  const ms = Date.now() - start;
  await ctx.send(t(lang as 'en' | 'ru').pong(ms));
}
