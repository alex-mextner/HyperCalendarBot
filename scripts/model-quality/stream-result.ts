import type OpenAI from 'openai';
export async function collectCompletion(
  chunks: AsyncIterable<OpenAI.ChatCompletionChunk>,
): Promise<OpenAI.ChatCompletion> {
  let id = '',
    model = '',
    created = 0,
    text = '',
    refusal = '',
    reasoning = '';
  let seen = false;
  let terminal = false;
  let finish: OpenAI.ChatCompletion.Choice['finish_reason'] = 'stop';
  let usage: OpenAI.CompletionUsage | undefined;
  const calls = new Map<number, OpenAI.ChatCompletionMessageFunctionToolCall>();
  for await (const chunk of chunks) {
    id = chunk.id;
    model = chunk.model;
    created = chunk.created;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices.find((c) => c.index === 0);
    if (!choice) continue;
    seen = true;
    if (choice.finish_reason) {
      finish = choice.finish_reason;
      terminal = true;
    }
    text += choice.delta.content ?? '';
    refusal += choice.delta.refusal ?? '';
    const thought: unknown = Reflect.get(choice.delta, 'reasoning_content');
    if (typeof thought === 'string') reasoning += thought;
    for (const fragment of choice.delta.tool_calls ?? []) {
      const call = calls.get(fragment.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (fragment.id) call.id = fragment.id;
      call.function.name += fragment.function?.name ?? '';
      call.function.arguments += fragment.function?.arguments ?? '';
      calls.set(fragment.index, call);
    }
  }
  if (seen && !terminal) throw new Error('UNTERMINATED_STREAM');
  const message: OpenAI.ChatCompletionMessage = {
    role: 'assistant',
    content: text || null,
    refusal: refusal || null,
    ...(calls.size ? { tool_calls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c) } : {}),
  };
  if (reasoning) Object.assign(message, { reasoning_content: reasoning });
  return {
    id,
    model,
    created,
    object: 'chat.completion',
    choices: seen ? [{ index: 0, finish_reason: finish, logprobs: null, message }] : [],
    ...(usage ? { usage } : {}),
  };
}
