import { InlineKeyboard } from 'gramio';
import { CB, t } from '../../config/constants';
import type { User } from '../../database/types';
import type { BotCallbackContext } from '../types';

export function handleFeatureTourCallback(ctx: BotCallbackContext, payload: string): void {
  const user = ctx.dbUser as User;
  const lang = (user.language ?? 'en') as 'en' | 'ru';
  const pages = t(lang).feature_tour;
  const page = Number(payload) || 0;

  if (page < 0 || page >= pages.length) {
    ctx.answer();
    return;
  }

  const text = `${pages[page]}\n\n<i>${page + 1} / ${pages.length}</i>`;

  const kb = new InlineKeyboard();
  if (page > 0) kb.text('⬅️', `${CB.FEATURE_TOUR}:${page - 1}`);
  if (page < pages.length - 1) kb.text('➡️', `${CB.FEATURE_TOUR}:${page + 1}`);

  ctx.answer();
  ctx.editText(text, { parse_mode: 'HTML', reply_markup: kb }).catch(() => {
    // First page — send instead of edit (no message to edit yet)
    ctx.send(text, { parse_mode: 'HTML', reply_markup: kb });
  });
}
