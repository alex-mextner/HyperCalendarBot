// src/bot/types.ts

import type { AnyScene } from '@gramio/scenes';
import type { AnyBot, CallbackQueryContext, MessageContext } from 'gramio';
import type { User } from '../database/types.ts';

/**
 * Properties derived into GramIO context by user-resolver middleware.
 */
export interface DerivedProps {
  dbUser: User;
  userTimezone: string;
  lang: 'en' | 'ru';
}

/**
 * Additional properties GramIO injects into command/message contexts at runtime.
 * `args` is added by `.command()`, `location`/`document` are optional message fields,
 * `getFile` is a bot helper available on message contexts.
 */
export interface GramIOMessageExtras {
  /** Text after the command (injected by GramIO .command() handler) */
  args?: string | null;
  /** Shared location (present only when message contains location) */
  location?: { latitude: number; longitude: number } | null;
  /** Attached document (present only when message contains a document) */
  document?: { file_id: string; file_name?: string; mime_type?: string } | null;
  /** Get file metadata for download */
  getFile(): Promise<{ file_path: string }>;
}

/**
 * Scene access derived by @gramio/scenes plugin.
 * Available on message and callback_query contexts.
 */
export interface SceneAccess {
  enter: (scene: AnyScene, ...args: unknown[]) => Promise<void>;
  exit: () => Promise<void>;
}

/**
 * Command/message handler context — MessageContext with derived properties.
 */
export type BotCommandContext = MessageContext<AnyBot> &
  DerivedProps &
  GramIOMessageExtras & {
    scene: SceneAccess;
  };

/**
 * Callback query handler context — CallbackQueryContext with derived properties.
 */
export type BotCallbackContext = CallbackQueryContext<AnyBot> &
  DerivedProps & {
    scene: SceneAccess;
  };
