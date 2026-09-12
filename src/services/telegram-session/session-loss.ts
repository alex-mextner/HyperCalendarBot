import { t } from '../../config/constants.ts';
export type SessionLossReason = 'revoked' | 'expired' | 'local' | 'account_unavailable';
export function formatSessionLoss(
  lang: 'en' | 'ru',
  reason: SessionLossReason = 'expired',
  observedAt = new Date().toISOString(),
): string {
  const date = new Date(observedAt);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid session observation time');
  const tr = t(lang).connectTelegram;
  const detail =
    reason === 'revoked'
      ? tr.revocationConfirmed
      : reason === 'account_unavailable'
        ? tr.accountUnavailable
        : tr.connectionUnavailable;
  return `${detail}\n\n${tr.sessionExpired}\n\n${tr.lossObservedAt(date.toISOString())}`;
}
