import type { UserRepository } from '../database/repositories/user.repository.ts';
import type { CalendarSecretary } from '../database/types.ts';
import { logger } from '../utils/logger.ts';

export async function runSecretaryExpiry(deps: {
  secretaryRepo: { expirePending(): CalendarSecretary[] };
  userRepo: Pick<UserRepository, 'findByTelegramId'>;
  notify: (userId: number, text: string) => Promise<void>;
}): Promise<void> {
  const expired = deps.secretaryRepo.expirePending();

  for (const record of expired) {
    const secUser = deps.userRepo.findByTelegramId(record.secretary_id);
    const name = secUser?.username ? `@${secUser.username}` : (secUser?.first_name ?? `User ${record.secretary_id}`);
    await deps
      .notify(record.owner_id, `Приглашение для ${name} истекло — нет ответа в течение 7 дней.`)
      .catch((err) => logger.error({ err, recordId: record.id }, 'failed to send expiry notification'));
  }
}
