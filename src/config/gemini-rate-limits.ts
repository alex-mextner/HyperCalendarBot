import { z } from 'zod';
import { jsonCodec } from '../utils/json-codec.ts';

const schema = z
  .object({
    scope: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    rpm: z.number().int().min(1).max(1000),
    tpm: z.number().int().min(1).max(10_000_000),
    rpd: z.number().int().min(1).max(100_000),
  })
  .strict();
export type GeminiRateLimits = z.infer<typeof schema>;
const codec = jsonCodec(schema);

/** Application budget, not a claim that Google grants these limits. */
export function parseGeminiRateLimits(raw: string | undefined): GeminiRateLimits | undefined {
  if (raw === undefined) return undefined;
  if (raw.length > 1024) throw new Error('GEMINI_RATE_LIMITS is too large');
  const parsed = codec.safeParse(raw);
  if (!parsed.success) throw new Error('GEMINI_RATE_LIMITS must contain scope and positive bounded rpm/tpm/rpd');
  return parsed.data;
}
