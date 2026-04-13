/**
 * Drop-in replacement for bullmq's UnrecoverableError.
 *
 * bullmq's Worker checks `err.name == 'UnrecoverableError'` (not just instanceof),
 * so a custom class with the matching name works identically. We avoid importing
 * UnrecoverableError from bullmq because Bun's CJS interop can't resolve it
 * through bullmq's deep tslib.__exportStar chain on Linux (CI).
 */
export class UnrecoverableError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'UnrecoverableError';
  }
}
