// src/bot/middleware/user-resolver.ts
import type { DatabaseService } from '../../database/index.ts';

/**
 * Returns a derive function that resolves/creates user from Telegram update.
 * Attaches dbUser, userTimezone, and lang to context.
 */
export function createUserResolver(db: DatabaseService) {
  return async (context: any) => {
    if (!context.from) return {};

    const dbUser = db.users.findOrCreate({
      telegram_id: context.from.id,
      username: context.from.username,
      first_name: context.from.firstName,
    });

    return {
      dbUser,
      userTimezone: dbUser.timezone,
      lang: dbUser.language as 'en' | 'ru',
    };
  };
}
