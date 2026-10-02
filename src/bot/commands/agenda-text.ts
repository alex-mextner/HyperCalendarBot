// Text agenda transport preserves HTML and puts picker controls on the final chunk.
import { splitMessage } from '../../utils/telegram.ts';
import type { BotCommandContext } from '../types.ts';

type SendOptions = Parameters<BotCommandContext['send']>[1];
export async function sendAgendaText(
  ctx: { send: (text: string, options?: SendOptions) => Promise<unknown> },
  text: string,
  options?: SendOptions,
): Promise<void> {
  const chunks = splitMessage(text, 4000, 'HTML');
  for (const [index, chunk] of chunks.entries()) {
    await ctx.send(chunk, { ...(index === chunks.length - 1 ? options : undefined), parse_mode: 'HTML' });
  }
}
