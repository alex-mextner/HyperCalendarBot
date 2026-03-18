import type { SecretaryRepository } from '../../../database/repositories/secretary.repository.ts';

type AccessMode = 'read' | 'write';

export function checkSecretaryAccess(
  callerUserId: number,
  ownerId: number | undefined,
  secretaryRepo: Pick<SecretaryRepository, 'findByOwnerAndSecretary'> | null,
  mode: AccessMode,
): { ok: true; effectiveUserId: number } | { ok: false; error: string } {
  if (!ownerId) return { ok: true, effectiveUserId: callerUserId };

  if (!secretaryRepo) return { ok: false, error: 'SECRETARY_ACCESS_DENIED' };

  const record = secretaryRepo.findByOwnerAndSecretary(ownerId, callerUserId);
  if (!record || record.status !== 'active') return { ok: false, error: 'SECRETARY_ACCESS_DENIED' };
  if (mode === 'write' && record.permission !== 'write') return { ok: false, error: 'SECRETARY_ACCESS_DENIED' };

  return { ok: true, effectiveUserId: ownerId };
}
