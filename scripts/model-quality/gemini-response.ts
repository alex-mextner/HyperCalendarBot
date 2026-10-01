import { z } from 'zod';
export const nativeResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        finishReason: z.string().optional(),
        content: z
          .object({
            parts: z
              .array(
                z.object({
                  text: z.string().optional(),
                  thought: z.boolean().optional(),
                  functionCall: z.object({ name: z.string(), args: z.record(z.string(), z.json()) }).optional(),
                }),
              )
              .optional(),
          })
          .optional(),
      }),
    )
    .optional(),
  usageMetadata: z
    .object({
      promptTokenCount: z.number().optional(),
      candidatesTokenCount: z.number().optional(),
      thoughtsTokenCount: z.number().optional(),
      totalTokenCount: z.number().optional(),
    })
    .optional(),
  error: z
    .object({ code: z.number().optional(), status: z.string().optional(), message: z.string().optional() })
    .optional(),
});
