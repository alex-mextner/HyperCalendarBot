/** Telegram bot API message formatting mode. */
export type ParseMode = 'HTML' | 'MarkdownV2' | 'Markdown';

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Strip all HTML tags, decode &amp; &lt; &gt; &quot; back to plain characters. */
export function stripHtml(html: string): string {
  // Strip tags to a fixpoint: one greedy, non-recursive pass can leave a partial or
  // overlapping `<...>` sequence behind, so repeat until the string stops shrinking.
  let stripped = html;
  let prev: string;
  do {
    prev = stripped;
    stripped = stripped.replace(/<[^>]*>/g, '');
  } while (stripped !== prev);
  return stripped
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

export function escapeMarkdown(text: string): string {
  // Escape backslash too (and first within the class) so a literal `\` in the
  // input can't neutralize the escaping of a following special character.
  return text.replace(/([\\_*`[\]])/g, '\\$1');
}

export function markdownToHtml(text: string): string {
  let result = escapeHtml(text);
  // **bold** → <b>bold</b>
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  // *italic* → <i>italic</i> (but not inside escaped **)
  result = result.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<i>$1</i>');
  // _italic_ → <i>italic</i>
  result = result.replace(/(?<!\w)_(.+?)_(?!\w)/g, '<i>$1</i>');
  // `code` → <code>code</code>
  result = result.replace(/`([^`]+)`/g, '<code>$1</code>');
  return result;
}

export function truncateMessage(text: string, maxLen = 4000): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
}

export function splitMessage(text: string, maxLen = 4000): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    const slice = remaining.slice(0, maxLen);

    // Try paragraph boundary
    const paraIdx = slice.lastIndexOf('\n\n');
    if (paraIdx > 0) {
      chunks.push(remaining.slice(0, paraIdx));
      remaining = remaining.slice(paraIdx + 2);
      continue;
    }

    // Try line boundary
    const lineIdx = slice.lastIndexOf('\n');
    if (lineIdx > 0) {
      chunks.push(remaining.slice(0, lineIdx));
      remaining = remaining.slice(lineIdx + 1);
      continue;
    }

    // Hard split
    chunks.push(slice);
    remaining = remaining.slice(maxLen);
  }

  return chunks;
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
