/**
 * One line, whatever the caller was given.
 *
 * The prompt sections built from a user's own data render one item per line, so
 * an item carrying its own newlines would break the accounting their size caps
 * depend on — and worse, a line reading "## Schedule Context" inside an item is
 * a section boundary to the model rather than something a user said. Shared so
 * that a write gate and the render it feeds cannot drift apart: they have to
 * collapse by the same rule for the guarantee to hold.
 */
export function collapseToOneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
