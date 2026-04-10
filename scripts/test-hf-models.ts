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

async function testModel(model: string) {
  console.log(`\n  ── ${model} ──\n`);

  // Completion
  try {
    const start = Date.now();
    const res = await hfClient.chat.completions.create({
      model,
      messages: SIMPLE,
      max_tokens: 100,
      temperature: 0.3,
    });
    const text = res.choices[0]?.message?.content?.trim() ?? '(empty)';
    console.log(`  ${icon(!!text)} Completion (${Date.now() - start}ms): ${text.slice(0, 100)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ${icon(false)} Completion: ${msg.slice(0, 120)}`);
  }

  // Tool calling
  try {
    const start = Date.now();
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
    console.log(
      `  ${icon(tc.length > 0)} Tools (${Date.now() - start}ms): ${tc.length > 0 ? tc.join(', ') : text.slice(0, 100) || `finish=${res.choices[0]?.finish_reason}`}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ${icon(false)} Tools: ${msg.slice(0, 120)}`);
  }

  // Streaming
  try {
    const start = Date.now();
    const stream = await hfClient.chat.completions.create({
      model,
      messages: SIMPLE,
      max_tokens: 100,
      temperature: 0.3,
      stream: true,
    });
    let text = '';
    let chunks = 0;
    for await (const chunk of stream) {
      const d = chunk.choices[0]?.delta?.content;
      if (d) {
        text += d;
        chunks++;
      }
    }
    console.log(
      `  ${icon(chunks > 0)} Streaming (${Date.now() - start}ms, ${chunks} chunks): ${text.trim().slice(0, 80)}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ${icon(false)} Streaming: ${msg.slice(0, 120)}`);
  }

  // Streaming + tools
  try {
    const start = Date.now();
    const stream = await hfClient.chat.completions.create({
      model,
      messages: MESSAGES,
      tools: TEST_TOOLS,
      max_tokens: 200,
      temperature: 0.3,
      stream: true,
    });
    let text = '';
    const tcMap = new Map<number, { id: string; name: string; args: string }>();
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      if (delta.content) text += delta.content;
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const ex = tcMap.get(tc.index);
          if (ex) {
            ex.args += tc.function?.arguments ?? '';
          } else {
            tcMap.set(tc.index, { id: tc.id ?? '', name: tc.function?.name ?? '', args: tc.function?.arguments ?? '' });
          }
        }
      }
    }
    const toolCalls = [...tcMap.values()].map((t) => `${t.name}(${t.args})`);
    console.log(
      `  ${icon(toolCalls.length > 0)} Stream+Tools (${Date.now() - start}ms): ${toolCalls.length > 0 ? toolCalls.join(', ') : text.slice(0, 80) || '(empty)'}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ${icon(false)} Stream+Tools: ${msg.slice(0, 120)}`);
  }
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

main().catch(console.error);
