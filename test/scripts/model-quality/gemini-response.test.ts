import { expect, test } from 'bun:test';
import { nativeResponseSchema } from '../../../scripts/model-quality/gemini-response.ts';

test('native length response may omit content parts but must retain finish and usage', () => {
  const result = nativeResponseSchema.safeParse({
    candidates: [{ content: { role: 'model' }, finishReason: 'MAX_TOKENS' }],
    usageMetadata: { promptTokenCount: 100, thoughtsTokenCount: 127, totalTokenCount: 227 },
  });
  expect(result.success).toBe(true);
  if (result.success) expect(result.data.candidates?.[0]?.finishReason).toBe('MAX_TOKENS');
});
