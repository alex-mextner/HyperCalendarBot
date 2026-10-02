/** Canonical decimal ID normalization shared by validation and outcome identity. */
export function normalizeNumericId(value: unknown): unknown {
  if (typeof value !== 'string' || !/^(?:0|-?[1-9][0-9]*)$/.test(value)) return value;
  const id = parseInt(value, 10);
  return Number.isSafeInteger(id) ? id : value;
}
