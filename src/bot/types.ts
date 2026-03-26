// src/bot/types.ts

import type { EnterExit } from '@gramio/scenes';
import type { AnyBot, CallbackQueryContext, MessageContext } from 'gramio';
import type { User } from '../database/types.ts';

/**
 * Properties derived into GramIO context by user-resolver middleware.
 */
export interface DerivedProps {
  dbUser: User | undefined;
  userTimezone: string | undefined;
  lang: 'en' | 'ru';
}

/**
 * GramIO injects `args` (text after the command) into the context for `.command()` handlers.
 * `document` and `location` access is done via the standard `Message` class properties on MessageContext.
 * `getFile` is only available in scene steps — cast to `typeof context & GramIOFileContext` there.
 */
export interface GramIOFileContext {
  document?: { file_id: string; file_name?: string; mime_type?: string } | null;
  getFile(): Promise<{ file_path: string }>;
}

/**
 * Scene access derived by @gramio/scenes `scenes()` plugin.
 * The `scenes()` plugin provides `Omit<EnterExit, "exit">` — only `enter` is exposed here.
 * `exit` is available inside scene step handlers via their own context type, not through BotCommandContext.
 */
export interface SceneAccess {
  enter: EnterExit['enter'];
}

/**
 * Command/message handler context — MessageContext with derived properties.
 * `args` is injected by GramIO's `.command()` handler as `string | null`.
 */
export type BotCommandContext = MessageContext<AnyBot> &
  DerivedProps & {
    args?: string | null;
    scene: SceneAccess;
  };

/**
 * Callback query handler context — CallbackQueryContext with derived properties.
 */
export type BotCallbackContext = CallbackQueryContext<AnyBot> &
  DerivedProps & {
    scene: SceneAccess;
  };

/**
 * Narrows a command-or-callback context to a callback context.
 * CallbackQueryContext provides `editText`; MessageContext does not.
 */
export function isCallbackContext(ctx: BotCommandContext | BotCallbackContext): ctx is BotCallbackContext {
  return 'editText' in ctx && typeof (ctx as BotCallbackContext).editText === 'function';
}
