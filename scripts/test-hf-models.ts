/**
 * Test strong HF models for main chain fallback (tool calling required).
 * Also tests light models for light chain.
 */
import OpenAI from 'openai';

const HF_BASE_URL = 'https://router.huggingface.co/v1';

const hfClient = new OpenAI({
  apiKey: process.env.HF_TOKEN || 'missing',
  baseURL: HF_BASE_URL,
  timeout: 60_000,
  maxRetries: 0,
});

const TEST_TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: 'Get current date and time in a given timezone',
      parameters: {
        type: 'object',
        properties: {
          timezone: { type: 'string', description: 'IANA timezone, e.g. Europe/Belgrade' },
        },
        required: ['timezone'],
      },
    },
  },
];

const MESSAGES: OpenAI.ChatCompletionMessageParam[] = [
  { role: 'system', content: 'You are a calendar assistant. Use tools when needed. Reply in Russian.' },
  { role: 'user', content: 'Какое сейчас время в Белграде?' },
];

const SIMPLE: OpenAI.ChatCompletionMessageParam[] = [
  { role: 'system', content: 'Reply briefly in Russian.' },
  { role: 'user', content: 'Привет! Одно предложение о погоде.' },
];

// Strong models for main chain
const STRONG_MODELS = [
  'Qwen/Qwen3-235B-A22B',
  'meta-llama/Llama-3.1-405B-Instruct',
  'meta-llama/Llama-3.3-70B-Instruct',
  'deepseek-ai/DeepSeek-R1-0528',
  'mistralai/Mistral-Large-Instruct-2411',
];

// Light models for light chain
const LIGHT_MODELS = [
  'meta-llama/Llama-3.3-70B-Instruct',
  'mistralai/Mistral-Small-3.1-24B-Instruct-2503',
  'Qwen/Qwen2.5-72B-Instruct',
  'microsoft/Phi-4-reasoning-plus',
];

function icon(ok: boolean): string {
  return ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
}

/** What one capability probe found; `meta` is extra detail appended to the timing, e.g. ", 3 chunks". */
interface ProbeOutcome {
  ok: boolean;
  meta?: string;
  detail: string;
}

/** Runs one probe, timing it; a thrown error is the probe's failure line, not the script's. */
async function runProbe(label: string, probe: () => Promise<ProbeOutcome>): Promise<void> {
  try {
    const start = Date.now();
    const outcome = await probe();
    console.log(`  ${icon(outcome.ok)} ${label} (${Date.now() - start}ms${outcome.meta ?? ''}): ${outcome.detail}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ${icon(false)} ${label}: ${msg.slice(0, 120)}`);
  }
}

/** Folds one streamed tool-call fragment into the call it belongs to: later fragments only extend the arguments. */
function mergeToolCallDelta(
  calls: Map<number, { id: string; name: string; args: string }>,
  fragment: OpenAI.ChatCompletionChunk.Choice.Delta.ToolCall,
): void {
  const existing = calls.get(fragment.index);
  if (existing) {
    existing.args += fragment.function?.arguments ?? '';
  } else {
    calls.set(fragment.index, {
      id: fragment.id ?? '',
      name: fragment.function?.name ?? '',
      args: fragment.function?.arguments ?? '',
    });
  }
}

/** Drains a plain streamed completion: the text and how many chunks carried content. */
export async function readTextStream(
  stream: AsyncIterable<OpenAI.ChatCompletionChunk>,
): Promise<{ text: string; chunks: number }> {
  let text = '';
  let chunks = 0;
  for await (const chunk of stream) {
    const d = chunk.choices[0]?.delta?.content;
    if (d) {
      text += d;
      chunks++;
    }
  }
  return { text, chunks };
}

/** Drains a streamed completion that may call tools: the text and each assembled call as `name(args)`. */
export async function readToolStream(
  stream: AsyncIterable<OpenAI.ChatCompletionChunk>,
): Promise<{ text: string; toolCalls: string[] }> {
  let text = '';
  const calls = new Map<number, { id: string; name: string; args: string }>();
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta;
    if (!delta) continue;
    if (delta.content) text += delta.content;
    for (const fragment of delta.tool_calls ?? []) mergeToolCallDelta(calls, fragment);
  }
  return { text, toolCalls: [...calls.values()].map((t) => `${t.name}(${t.args})`) };
}

async function probeCompletion(model: string): Promise<ProbeOutcome> {
  const res = await hfClient.chat.completions.create({
    model,
    messages: SIMPLE,
    max_tokens: 100,
    temperature: 0.3,
  });
  const text = res.choices[0]?.message?.content?.trim() ?? '(empty)';
  return { ok: !!text, detail: text.slice(0, 100) };
}

async function probeToolCalling(model: string): Promise<ProbeOutcome> {
  const res = await hfClient.chat.completions.create({
    model,
    messages: MESSAGES,
    tools: TEST_TOOLS,
    max_tokens: 200,
    temperature: 0.3,
  });
  const tc =
    res.choices[0]?.message?.tool_calls
      ?.filter((t): t is OpenAI.ChatCompletionMessageToolCall & { type: 'function' } => t.type === 'function')
      .map((t) => `${t.function.name}(${t.function.arguments})`) ?? [];
  const text = res.choices[0]?.message?.content?.trim() ?? '';
  return {
    ok: tc.length > 0,
    detail: tc.length > 0 ? tc.join(', ') : text.slice(0, 100) || `finish=${res.choices[0]?.finish_reason}`,
  };
}

async function probeStreaming(model: string): Promise<ProbeOutcome> {
  const stream = await hfClient.chat.completions.create({
    model,
    messages: SIMPLE,
    max_tokens: 100,
    temperature: 0.3,
    stream: true,
  });
  const { text, chunks } = await readTextStream(stream);
  return { ok: chunks > 0, meta: `, ${chunks} chunks`, detail: text.trim().slice(0, 80) };
}

async function probeStreamingTools(model: string): Promise<ProbeOutcome> {
  const stream = await hfClient.chat.completions.create({
    model,
    messages: MESSAGES,
    tools: TEST_TOOLS,
    max_tokens: 200,
    temperature: 0.3,
    stream: true,
  });
  const { text, toolCalls } = await readToolStream(stream);
  return {
    ok: toolCalls.length > 0,
    detail: toolCalls.length > 0 ? toolCalls.join(', ') : text.slice(0, 80) || '(empty)',
  };
}

async function testModel(model: string) {
  console.log(`\n  ── ${model} ──\n`);
  await runProbe('Completion', () => probeCompletion(model));
  await runProbe('Tools', () => probeToolCalling(model));
  await runProbe('Streaming', () => probeStreaming(model));
  await runProbe('Stream+Tools', () => probeStreamingTools(model));
}

async function main() {
  console.log('Testing HF Router models\n');
  console.log(`HF_TOKEN=${process.env.HF_TOKEN ? 'set' : 'MISSING'}`);

  console.log(`\n${'═'.repeat(60)}`);
  console.log('  STRONG MODELS (for main chain)');
  console.log(`${'═'.repeat(60)}`);
  for (const m of STRONG_MODELS) await testModel(m);

  console.log(`\n${'═'.repeat(60)}`);
  console.log('  LIGHT MODELS (for light chain)');
  console.log(`${'═'.repeat(60)}`);
  for (const m of LIGHT_MODELS) await testModel(m);

  console.log(`\n${'═'.repeat(60)}`);
  console.log('  Done!');
  console.log(`${'═'.repeat(60)}\n`);
}

if (import.meta.main) main().catch(console.error);
