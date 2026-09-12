import { z } from 'zod';
import { jsonCodec } from '../../utils/json-codec.ts';

const SessionIdentity = jsonCodec(z.object({ ok: z.literal(true), user_id: z.number().int().positive().safe() }));
export function isExpectedServiceSession(output: string, exitCode: number, expectedId?: number): boolean {
  if (exitCode !== 0 || expectedId === undefined || !Number.isSafeInteger(expectedId) || expectedId <= 0) return false;
  const parsed = SessionIdentity.safeParse(output.trim());
  return parsed.success && parsed.data.user_id === expectedId;
}
