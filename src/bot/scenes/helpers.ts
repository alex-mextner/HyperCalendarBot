// src/bot/scenes/helpers.ts
import type { User } from '../../database/types.ts';

/**
 * Get user from derived context.
 * Scenes don't have DerivedProps typing, so this helper extracts dbUser safely.
 */
export function getSceneUser(context: unknown): User | undefined {
  const ctx = context as { dbUser?: User };
  return ctx.dbUser;
}

/**
 * Get user language shorthand.
 */
export function getSceneLang(context: unknown): 'en' | 'ru' {
  const user = getSceneUser(context);
  return (user?.language ?? 'en') as 'en' | 'ru';
}
