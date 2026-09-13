// Text agenda transport preserves HTML and puts picker controls on the final chunk.
import { splitMessage } from '../../utils/telegram.ts';
import type { BotCallbackContext, BotCommandContext } from '../types.ts';

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

/** Edit the first chunk and send continuations, keeping controls on the final message. */
export async function editAgendaText(
  ctx: Pick<BotCallbackContext, 'editText' | 'send'>,
  text: string,
  options?: Parameters<BotCallbackContext['editText']>[1],
): Promise<void> {
  const chunks = splitMessage(text, 4000, 'HTML');
  for (const [index, chunk] of chunks.entries()) {
    const final = index === chunks.length - 1;
    if (index === 0) {
      await ctx.editText(chunk, {
        ...options,
        parse_mode: 'HTML',
        reply_markup: final ? options?.reply_markup : { inline_keyboard: [] },
      });
    } else {
      await ctx.send(chunk, { parse_mode: 'HTML', reply_markup: final ? options?.reply_markup : undefined });
    }
  }
}
