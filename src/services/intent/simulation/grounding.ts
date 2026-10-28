// Grounding check for a simulated intent reply: every clock time (HH:MM) and numeric date
// (YYYY-MM-DD, two-digit DD.MM, DD.MM.YYYY) the reply states must come from the same run — a tool result,
// an event in the calendar after the run, or the case clock — read in the case's own zone.
// Tool results carry UTC instants while replies are rendered in the user's zone, so instants are
// converted before comparison; wall-clock values a tool printed verbatim count as they are.
// Dates compare by month and day. Titles and worded dates ("11 сентября") are not checked.

export interface GroundingSources {
  /** Output text and serialized data of every tool call in the run. */
  toolTexts: string[];
  /** ISO instants known to the run, e.g. calendar events after it. */
  instants: string[];
  timezone: string;
  /** The case clock. */
  now: string;
}

const TIME = /(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d])/g;
const ISO_DATE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g;
// Two digits on both sides, so amounts and versions ("1.5 часа", "3.12") are not read as dates.
const DOTTED_DATE = /(?<![\d.])(\d{2})\.(\d{2})(?:\.(\d{2}|\d{4}))?(?!\d)/g;
const INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/g;

const pad = (value: string) => value.padStart(2, '0');

/** Clock times and month-day dates stated in a text, as `t:HH:MM` and `d:MM-DD` tokens. */
function statedTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const [, hour, minute] of text.matchAll(TIME)) tokens.push(`t:${pad(hour!)}:${minute}`);
  for (const [, , month, day] of text.matchAll(ISO_DATE)) tokens.push(`d:${month}-${day}`);
  for (const [, day, month] of text.matchAll(DOTTED_DATE)) {
    const monthNumber = Number(month);
    const dayNumber = Number(day);
    if (monthNumber >= 1 && monthNumber <= 12 && dayNumber >= 1 && dayNumber <= 31) tokens.push(`d:${month}-${day}`);
  }
  return tokens;
}

function zonedTokens(instant: string, timezone: string): string[] {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) return [];
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return [`t:${part('hour')}:${part('minute')}`, `d:${part('month')}-${part('day')}`];
}

export function checkGrounding(reply: string, sources: GroundingSources): { grounded: boolean; ungrounded: string[] } {
  const known = new Set<string>();
  const instants = [...sources.instants, sources.now];
  for (const text of sources.toolTexts) {
    // Raw instants are only meaningful converted into the zone; their UTC wall clock is not.
    for (const token of statedTokens(text.replace(INSTANT, ' '))) known.add(token);
    instants.push(...(text.match(INSTANT) ?? []));
  }
  for (const instant of instants) for (const token of zonedTokens(instant, sources.timezone)) known.add(token);
  const ungrounded: string[] = [];
  for (const token of statedTokens(reply)) {
    if (known.has(token)) continue;
    const shown = token.slice(2);
    if (!ungrounded.includes(shown)) ungrounded.push(shown);
  }
  return { grounded: ungrounded.length === 0, ungrounded };
}
