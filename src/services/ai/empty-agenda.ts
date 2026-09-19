import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';

interface EmptyAgendaInput {
  start: string;
  end: string;
  timezone: string;
  language: 'ru' | 'en';
  scope: 'personal' | 'group';
  delegated?: boolean;
  now?: Date;
}
/** Wording for a successfully read empty calendar, never a read-failure fallback. */
export function formatEmptyAgenda(input: EmptyAgendaInput): string {
  const { timezone, language, scope } = input;
  const start = new Date(input.start),
    end = new Date(input.end),
    now = input.now ?? new Date();
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end)
    throw new RangeError('Invalid calendar interval');
  const first = new TZDate(start, timezone),
    last = new TZDate(end, timezone),
    localNow = new TZDate(now, timezone);
  const firstDay = format(first, 'yyyy-MM-dd'),
    lastDay = format(last, 'yyyy-MM-dd'),
    today = format(localNow, 'yyyy-MM-dd');
  const delta = Math.round((Date.parse(`${firstDay}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  const ru = language === 'ru';
  const locale = ru ? 'ru-RU' : 'en-US';
  const includeYear = first.getFullYear() !== last.getFullYear() || first.getFullYear() !== localNow.getFullYear();
  const date = (value: Date) =>
    new Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      day: 'numeric',
      month: 'long',
      ...(includeYear ? { year: 'numeric' as const } : {}),
    })
      .format(value)
      .replace(/\s*г\.$/, '');
  const calendar = ru
    ? scope === 'group'
      ? 'в календаре этой группы'
      : input.delegated
        ? 'в выбранном календаре'
        : 'в твоём календаре'
    : scope === 'group'
      ? "in this group's calendar"
      : input.delegated
        ? 'in the selected calendar'
        : 'in your calendar';
  const wholeDay =
    firstDay === lastDay && format(first, 'HH:mm:ss') === '00:00:00' && format(last, 'HH:mm:ss') === '23:59:59';
  if (wholeDay) {
    const relative =
      delta === 0
        ? ru
          ? 'сегодня'
          : 'today'
        : delta === 1
          ? ru
            ? 'завтра'
            : 'tomorrow'
          : delta === 2
            ? ru
              ? 'послезавтра'
              : 'the day after tomorrow'
            : delta === -1
              ? ru
                ? 'вчера'
                : 'yesterday'
              : null;
    const label = relative ? `${relative}, ${date(start)}` : date(start);
    return ru
      ? delta < 0
        ? `За ${label}${relative ? ',' : ''} ${calendar} нет записанных событий.`
        : `На ${label}${relative ? ',' : ''} ${calendar} пока ничего не запланировано.`
      : `No events ${delta < 0 ? 'are recorded' : 'are scheduled'} ${calendar} for ${label}.`;
  }
  if (firstDay === lastDay) {
    const times = `${format(first, 'HH:mm')}–${format(last, 'HH:mm')}`;
    return ru
      ? `${date(start)}, ${times}: ${calendar} нет событий, начинающихся в это время. Время указано в твоём часовом поясе.`
      : `No events ${calendar} start on ${date(start)} between ${times}, in your time zone.`;
  }
  return ru
    ? `С ${date(start)} по ${date(end)} ${calendar} пока нет записанных событий.`
    : `No events ${calendar} are recorded from ${date(start)} to ${date(end)}.`;
}
