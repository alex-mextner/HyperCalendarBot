import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import type { Lang } from '../config/constants.ts';

export function formatProposedTime(isoUtc: string, timezone: string, lang: Lang): string {
  const d = new TZDate(new Date(isoUtc).getTime(), timezone);
  return lang === 'ru' ? format(d, 'd MMMM, HH:mm', { locale: ru }) : format(d, 'MMM d, h:mm a');
}
