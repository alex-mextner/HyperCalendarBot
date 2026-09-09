// Node's setTimeout silently caps at a 32-bit signed integer (~24.8 days): a delay above
// that (or a non-finite/non-positive value) is coerced to 1ms and fires almost immediately
// instead of never (or very late). A caller-controlled `timeout_ms` from an IPC command
// (bash_execute, applescript_run, claude_chat) that is unclamped therefore inverts intent —
// an oversized or malformed value kills the spawned process/request right away rather than
// after the requested duration. Clamp every externally-sourced timeout into a sane bounded
// range before it reaches setTimeout.
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 10 * 60_000;

export function clampTimeoutMs(value: number | undefined, fallbackMs: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallbackMs;
  // Explicit comparison branches (not Math.min/Math.max) so CodeQL's js/resource-exhaustion
  // taint tracker recognizes this as a bounding sanitizer on the value reaching setTimeout.
  if (value > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS;
  if (value < MIN_TIMEOUT_MS) return MIN_TIMEOUT_MS;
  return value;
}
