import { z } from 'zod';
import { jsonCodec } from '../utils/json-codec.ts';

const reservedKeys = new Set(['__proto__', 'prototype', 'constructor']);
const modelName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_./-]+$/)
  .refine((name) => !reservedKeys.has(name));
const limitsCodec = jsonCodec(
  z.preprocess(
    (input, ctx) => {
      if (input && typeof input === 'object' && !Array.isArray(input)) {
        const keys = Object.keys(input);
        if (keys.length > 32 || keys.some((key) => reservedKeys.has(key))) {
          ctx.addIssue({ code: 'custom', message: 'Invalid model limit keys' });
          return z.NEVER;
        }
      }
      return input;
    },
    z.record(modelName, z.number().int().positive().max(1_000_000_000)),
  ),
);

export type GroqTokenLimits = Readonly<{ [model: string]: number }>;

/** Operator-verified per-model throughput; not a context-window or spend limit. */
export function parseGroqTokenLimits(raw: string | undefined): GroqTokenLimits | undefined {
  if (raw === undefined) return undefined;
  if (raw.length > 4096) throw new Error('GROQ_TPM_LIMITS exceeds the configuration size limit');
  const parsed = limitsCodec.safeParse(raw);
  if (!parsed.success) throw new Error('GROQ_TPM_LIMITS must map up to 32 model IDs to positive integer token limits');
  return Object.freeze(parsed.data);
}
