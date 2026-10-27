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

export function splitMessage(text: string, maxLen = 4000, parseMode?: ParseMode): string[] {
  if (parseMode === 'HTML') return splitHtmlMessage(text, maxLen);
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

const OPENING_TAG = /^<([a-z][\w-]*)\b[^>]*>$/i;
const CLOSING_TAG = /^<\/([a-z][\w-]*)>$/i;

interface OpenHtmlTag {
  /** The tag exactly as written, replayed at the top of the next chunk. */
  start: string;
  end: string;
}

/** Entities, Unicode code points and tags as indivisible tokens; a stray `<` or `&` is a literal. */
const HTML_TOKEN = /<[^>]+>|&(?:#\d+|#x[\da-f]+|\w+);|[^<&]|[<&]/giu;

function closingTags(open: OpenHtmlTag[]): string {
  return open
    .toReversed()
    .map((tag) => tag.end)
    .join('');
}

/** The tag a token opens (null for text, entities and closing tags). */
function openedTag(token: string): OpenHtmlTag | null {
  const name = token.match(OPENING_TAG)?.[1];
  return name === undefined ? null : { start: token, end: `</${name}>` };
}

/** Length the closing tags will have once `token` is appended: it may open one more tag or close one. */
function closingLengthAfter(token: string, open: OpenHtmlTag[]): number {
  const opened = openedTag(token);
  const closes = CLOSING_TAG.test(token);
  return closingTags(open).length + (opened ? opened.end.length : 0) - (closes ? token.length : 0);
}

/** Seals `chunk` with its closing tags and returns the reopened prefix of the next chunk. */
function sealAndReopen(chunks: string[], chunk: string, open: OpenHtmlTag[]): string {
  chunks.push(chunk + closingTags(open));
  return open.map((tag) => tag.start).join('');
}

/** Keep escaped entities, Unicode code points and formatted spans intact across messages. */
function splitHtmlMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  const open: OpenHtmlTag[] = [];
  let chunk = '';
  for (const match of text.matchAll(HTML_TOKEN)) {
    const token = match[0];
    const closingLength = closingLengthAfter(token, open);
    if (chunk.length + token.length + closingLength > maxLen) {
      chunk = sealAndReopen(chunks, chunk, open);
      if (chunk.length + token.length + closingLength > maxLen) {
        throw new Error('HTML tag exceeds message chunk capacity');
      }
    }
    chunk += token;
    const opened = openedTag(token);
    if (opened) open.push(opened);
    if (CLOSING_TAG.test(token)) open.pop();
  }
  if (chunk) chunks.push(chunk + closingTags(open));
  return chunks;
}

export function formatUtcOffset(timezone: string): string {
  const d = new Date();
  const formatter = new Intl.DateTimeFormat('en', { timeZone: timezone, timeZoneName: 'shortOffset' });
  const parts = formatter.formatToParts(d);
  const tzPart = parts.find((p) => p.type === 'timeZoneName');
  const raw = tzPart?.value ?? timezone;
  // Normalize GMT+X to UTC+X, then collapse a zero offset (GMT+0 / GMT+00:00 on
  // some ICU builds) to bare UTC so it never renders as 'UTC+0'.
  return raw.replace(/^GMT/, 'UTC').replace(/^UTC[+-]0+(?::00)?$/, 'UTC');
}
