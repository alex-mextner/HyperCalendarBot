export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function truncateMessage(text: string, maxLen = 4000): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
}

export function formatUtcOffset(timezone: string): string {
  const d = new Date();
  const formatter = new Intl.DateTimeFormat('en', { timeZone: timezone, timeZoneName: 'shortOffset' });
  const parts = formatter.formatToParts(d);
  const tzPart = parts.find((p) => p.type === 'timeZoneName');
  const raw = tzPart?.value ?? timezone;
  // Normalize GMT+X to UTC+X
  return raw.replace(/^GMT/, 'UTC');
}
