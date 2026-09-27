import { mock } from 'bun:test';
import { type CallbackHandlerOpts, createCallbackHandler } from '../../src/bot/handlers/callback.handler.ts';
import type { BotCallbackContext } from '../../src/bot/types.ts';
import type { User } from '../../src/database/types.ts';
import type { EventService } from '../../src/services/event/event-service.ts';

type CallbackHandlerArgs = Parameters<typeof createCallbackHandler>;

/**
 * A callback handler wired only with `opts` (and an event service when the flow moves events). The
 * edit-value scene, holiday and notification-preference services stay unset: invitation flows never
 * reach them. Partial dependencies go through this one centralized test cast.
 */
export function makeCallbackHandler(opts: CallbackHandlerOpts, eventService: Partial<EventService> = {}) {
  return createCallbackHandler(
    eventService as unknown as CallbackHandlerArgs[0],
    {} as unknown as CallbackHandlerArgs[1],
    {} as unknown as CallbackHandlerArgs[2],
    {} as unknown as CallbackHandlerArgs[3],
    opts,
  );
}

/** A private-chat button tap carrying `data`; `answer` and `editText` record the bot's replies. */
export function makeCallbackTap(data: string, dbUser: Partial<User>) {
  const answer = mock((_params?: unknown) => Promise.resolve(true));
  const editText = mock((_text: string, _params?: unknown) => Promise.resolve(true));
  const ctx = { data, dbUser, answer, editText } as unknown as BotCallbackContext;
  return { ctx, answer, editText };
}
