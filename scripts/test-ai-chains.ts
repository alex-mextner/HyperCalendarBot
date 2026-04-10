/**
 * Test script for all AI provider chains via OpenAI SDK.
 *
 * Usage:
 *   bun scripts/test-ai-chains.ts
 *
 * Required env vars (from .env, auto-loaded by Bun):
 *   ANTHROPIC_API_KEY  — z.ai API key
 *   HF_TOKEN           — HuggingFace token
 *   GEMINI_API_KEY     — Google Gemini API key
 *   AI_MODEL           — primary model (default: glm-5.1)
 *   AI_FAST_MODEL      — light model (default: glm-flash)
 */
import OpenAI from 'openai';

// ── Config ──────────────────────────────────────────────────────────────────

const ZAI_BASE_URL = 'https://api.z.ai/api/paas/v4';
const HF_BASE_URL = 'https://router.huggingface.co/v1';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';

const AI_MODEL = process.env.AI_MODEL || 'glm-5.1';
const AI_FAST_MODEL = process.env.AI_FAST_MODEL || 'glm-flash';

const PLACEHOLDER_KEY = 'missing';

// ── Clients ─────────────────────────────────────────────────────────────────

const zaiClient = new OpenAI({
  apiKey: process.env.ANTHROPIC_API_KEY || PLACEHOLDER_KEY,
  baseURL: ZAI_BASE_URL,
  timeout: 30_000,
  maxRetries: 0,
});

const hfClient = new OpenAI({
  apiKey: process.env.HF_TOKEN || PLACEHOLDER_KEY,
  baseURL: HF_BASE_URL,
  timeout: 30_000,
  maxRetries: 0,
});

const geminiClient = new OpenAI({
  apiKey: process.env.GEMINI_API_KEY || PLACEHOLDER_KEY,
  baseURL: GEMINI_BASE_URL,
  timeout: 30_000,
  maxRetries: 0,
});

// ── Test tools ──────────────────────────────────────────────────────────────

const TEST_TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: 'Get current date and time in a given timezone',
      parameters: {
        type: 'object',
        properties: {
          timezone: {
            type: 'string',
            description: 'IANA timezone, e.g. Europe/Belgrade',
          },
        },
        required: ['timezone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_event',
      description: 'Create a calendar event',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Event title' },
          date: { type: 'string', description: 'ISO date string' },
          duration_minutes: { type: 'number', description: 'Duration in minutes' },
        },
        required: ['title', 'date'],
      },
    },
  },
];

const MESSAGES_WITH_TOOLS: OpenAI.ChatCompletionMessageParam[] = [
  { role: 'system', content: 'You are a calendar assistant. Use tools when appropriate. Reply in Russian.' },
  { role: 'user', content: 'Какое сейчас время в Белграде?' },
];

const MESSAGES_SIMPLE: OpenAI.ChatCompletionMessageParam[] = [
  { role: 'system', content: 'You are a helpful assistant. Reply briefly in Russian.' },
  { role: 'user', content: 'Привет! Скажи одно предложение о погоде.' },
];

// ── Provider definitions ────────────────────────────────────────────────────

interface ProviderTest {
  name: string;
  client: OpenAI;
  model: string;
}

const MAIN_PROVIDERS: ProviderTest[] = [
  { name: 'z.ai (GLM 5.1)', client: zaiClient, model: AI_MODEL },
  { name: 'HF (DeepSeek-R1)', client: hfClient, model: 'deepseek-ai/DeepSeek-R1-0528' },
  { name: 'Gemini 2.5 Pro', client: geminiClient, model: 'gemini-2.5-pro' },
];

const LIGHT_PROVIDERS: ProviderTest[] = [
  { name: 'z.ai (GLM Flash)', client: zaiClient, model: AI_FAST_MODEL },
  { name: 'Gemini 2.5 Flash', client: geminiClient, model: 'gemini-2.5-flash' },
  { name: 'HF (Llama 3.3 70B)', client: hfClient, model: 'meta-llama/Llama-3.3-70B-Instruct' },
];

// ── Test functions ──────────────────────────────────────────────────────────

function isBalanceError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('insufficient balance') ||
    msg.includes('no resource package') ||
    msg.includes('billing') ||
    msg.includes('quota exceeded') ||
    msg.includes('exceeded your current quota') ||
    msg.includes('payment required')
  );
}

async function testCompletion(provider: ProviderTest): Promise<{ ok: boolean; text: string; ms: number }> {
  const start = Date.now();
  try {
    const response = await provider.client.chat.completions.create({
      model: provider.model,
      messages: MESSAGES_SIMPLE,
      max_tokens: 100,
      temperature: 0.3,
    });
    const text = response.choices[0]?.message?.content?.trim() ?? '(empty)';
    return { ok: true, text, ms: Date.now() - start };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const prefix = isBalanceError(err) ? '💸 BALANCE: ' : '';
    return { ok: false, text: `${prefix}${msg.slice(0, 200)}`, ms: Date.now() - start };
  }
}

async function testToolCalling(
  provider: ProviderTest,
): Promise<{ ok: boolean; toolCalls: string[]; text: string; ms: number }> {
  const start = Date.now();
  try {
    const response = await provider.client.chat.completions.create({
      model: provider.model,
      messages: MESSAGES_WITH_TOOLS,
      tools: TEST_TOOLS,
      max_tokens: 200,
      temperature: 0.3,
    });
    const choice = response.choices[0];
    const toolCalls =
      choice?.message?.tool_calls
        ?.filter((tc): tc is OpenAI.ChatCompletionMessageToolCall & { type: 'function' } => tc.type === 'function')
        .map((tc) => `${tc.function.name}(${tc.function.arguments})`) ?? [];
    const text = choice?.message?.content?.trim() ?? '';
    const finishReason = choice?.finish_reason ?? 'unknown';
    const ok = toolCalls.length > 0 || finishReason === 'tool_calls';
    return { ok, toolCalls, text: text || `finish_reason=${finishReason}`, ms: Date.now() - start };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, toolCalls: [], text: msg.slice(0, 200), ms: Date.now() - start };
  }
}

async function testStreaming(
  provider: ProviderTest,
): Promise<{ ok: boolean; chunks: number; text: string; ms: number }> {
  const start = Date.now();
  try {
    const stream = await provider.client.chat.completions.create({
      model: provider.model,
      messages: MESSAGES_SIMPLE,
      max_tokens: 100,
      temperature: 0.3,
      stream: true,
    });

    let text = '';
    let chunks = 0;
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        text += delta;
        chunks++;
      }
    }
    return { ok: chunks > 0, chunks, text: text.trim().slice(0, 100), ms: Date.now() - start };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, chunks: 0, text: msg.slice(0, 200), ms: Date.now() - start };
  }
}

async function testStreamingWithTools(
  provider: ProviderTest,
): Promise<{ ok: boolean; toolCalls: string[]; text: string; ms: number }> {
  const start = Date.now();
  try {
    const stream = await provider.client.chat.completions.create({
      model: provider.model,
      messages: MESSAGES_WITH_TOOLS,
      tools: TEST_TOOLS,
      max_tokens: 200,
      temperature: 0.3,
      stream: true,
    });

    let text = '';
    const toolCallsMap = new Map<number, { id: string; name: string; args: string }>();
    let finishReason = 'stop';

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) text += delta.content;

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = toolCallsMap.get(tc.index);
          if (existing) {
            existing.args += tc.function?.arguments ?? '';
            if (tc.id && !existing.id) existing.id = tc.id;
            if (tc.function?.name && !existing.name) existing.name = tc.function.name;
          } else {
            toolCallsMap.set(tc.index, {
              id: tc.id ?? '',
              name: tc.function?.name ?? '',
              args: tc.function?.arguments ?? '',
            });
          }
        }
      }

      if (chunk.choices[0]?.finish_reason) {
        finishReason = chunk.choices[0].finish_reason;
      }
    }

    const toolCalls = [...toolCallsMap.values()].map((tc) => `${tc.name}(${tc.args})`);
    const ok = toolCalls.length > 0;
    return { ok, toolCalls, text: text || `finish_reason=${finishReason}`, ms: Date.now() - start };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, toolCalls: [], text: msg.slice(0, 200), ms: Date.now() - start };
  }
}

// ── Runner ──────────────────────────────────────────────────────────────────

function icon(ok: boolean): string {
  return ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
}

async function runProviderTests(chainName: string, providers: ProviderTest[]) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${chainName}`);
  console.log(`${'═'.repeat(60)}`);

  for (const provider of providers) {
    console.log(`\n  ── ${provider.name} (${provider.model}) ──\n`);

    // 1) Simple completion
    const comp = await testCompletion(provider);
    console.log(`  ${icon(comp.ok)} Completion (${comp.ms}ms): ${comp.text.slice(0, 80)}`);

    // 2) Tool calling
    const tools = await testToolCalling(provider);
    console.log(
      `  ${icon(tools.ok)} Tool calling (${tools.ms}ms): ${tools.toolCalls.length > 0 ? tools.toolCalls.join(', ') : tools.text.slice(0, 80)}`,
    );

    // 3) Streaming
    const str = await testStreaming(provider);
    console.log(`  ${icon(str.ok)} Streaming (${str.ms}ms, ${str.chunks} chunks): ${str.text.slice(0, 80)}`);

    // 4) Streaming with tools
    const strTools = await testStreamingWithTools(provider);
    console.log(
      `  ${icon(strTools.ok)} Stream+Tools (${strTools.ms}ms): ${strTools.toolCalls.length > 0 ? strTools.toolCalls.join(', ') : strTools.text.slice(0, 80)}`,
    );
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Testing AI provider chains via OpenAI SDK');
  console.log(`AI_MODEL=${AI_MODEL}, AI_FAST_MODEL=${AI_FAST_MODEL}`);
  console.log(`ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ? 'set' : 'MISSING'}`);
  console.log(`HF_TOKEN=${process.env.HF_TOKEN ? 'set' : 'MISSING'}`);
  console.log(`GEMINI_API_KEY=${process.env.GEMINI_API_KEY ? 'set' : 'MISSING'}`);

  await runProviderTests('STREAMING / TEXT CHAIN (main)', MAIN_PROVIDERS);
  await runProviderTests('LIGHT CHAIN', LIGHT_PROVIDERS);

  console.log(`\n${'═'.repeat(60)}`);
  console.log('  Done!');
  console.log(`${'═'.repeat(60)}\n`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
