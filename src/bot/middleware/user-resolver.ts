// src/bot/middleware/user-resolver.ts
import type { AnyBot, Context } from 'gramio';
import type { DatabaseService } from '../../database/index.ts';
import type { User } from '../../database/types.ts';

interface TelegramFrom {
  id: number;
  username?: string;
  firstName?: string;
}

/**
 * Extract `from` from GramIO context via runtime check.
 * GramIO's base Context class doesn't expose `from` in its type —
 * it's mixed in by TargetMixin on specific update contexts (message, callback_query, etc.).
 */
function extractFrom(context: Context<AnyBot>): TelegramFrom | undefined {
  if ('from' in context && context.from) {
    return context.from as TelegramFrom;
  }
  return undefined;
}

/**
 * Returns a derive function that resolves/creates user from Telegram update.
 * Attaches dbUser, userTimezone, and lang to context.
 */
export function createUserResolver(db: DatabaseService) {
  return async (
    context: Context<AnyBot>,
  ): Promise<{ dbUser: User | undefined; userTimezone: string | undefined; lang: 'en' | 'ru' }> => {
    const from = extractFrom(context);
    if (!from) return { dbUser: undefined, userTimezone: undefined, lang: 'en' };

    const dbUser = db.users.findOrCreate({
      telegram_id: from.id,
      username: from.username,
      first_name: from.firstName,
    });

    return {
      dbUser,
      userTimezone: dbUser.timezone,
      lang: dbUser.language as 'en' | 'ru',
    };
  };
}
