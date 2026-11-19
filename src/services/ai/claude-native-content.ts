// Keep native assistant content private while preserving signed tool-loop prefixes.
import { createHash } from 'node:crypto';
import type OpenAI from 'openai';
import { z } from 'zod';
import type { NativeRequest, NativeTool } from './claude-native-request.ts';
import type { ConsumedStream } from './streaming/stream-reader.ts';

// Keep opaque blocks and their original ordering. Never expose them as text, log fields,
// chat-history rows, or JSON fields sent to another provider.
export const nativeAssistantBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).catchall(z.json()),
  z
    .object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.record(z.string(), z.json()) })
    .catchall(z.json()),
  z.object({ type: z.literal('thinking'), thinking: z.string(), signature: z.string() }).catchall(z.json()),
  z.object({ type: z.literal('redacted_thinking'), data: z.string() }).catchall(z.json()),
]);
export type NativeAssistantBlock = z.infer<typeof nativeAssistantBlockSchema>;
export interface NativeReplay {
  request: NativeRequest;
  sourcePrefixHash: string;
  activeTools: NativeTool[];
  content: NativeAssistantBlock[];
}
const chunks = new WeakMap<OpenAI.ChatCompletionChunk, NativeReplay>();
const consumedStreams = new WeakMap<ConsumedStream, NativeReplay>();
const messages = new WeakMap<OpenAI.ChatCompletionMessageParam, NativeReplay>();

export function sourcePrefixHash(source: readonly OpenAI.ChatCompletionMessageParam[]): string {
  return createHash('sha256').update(JSON.stringify(source)).digest('hex');
}
export function rememberNativeChunk(chunk: OpenAI.ChatCompletionChunk, replay: NativeReplay): void {
  chunks.set(chunk, replay);
}
export function nativeChunkReplay(chunk: OpenAI.ChatCompletionChunk): NativeReplay | undefined {
  return chunks.get(chunk);
}
export function rememberNativeConsumed(consumed: ConsumedStream, replay: NativeReplay | undefined): void {
  if (replay) consumedStreams.set(consumed, replay);
}
export function nativeConsumedReplay(consumed: ConsumedStream): NativeReplay | undefined {
  return consumedStreams.get(consumed);
}
export function rememberNativeAssistant(
  message: OpenAI.ChatCompletionMessageParam,
  replay: NativeReplay | undefined,
): OpenAI.ChatCompletionMessageParam {
  if (replay) messages.set(message, replay);
  return message;
}
export function nativeMessageReplay(message: OpenAI.ChatCompletionMessageParam): NativeReplay | undefined {
  return messages.get(message);
}
