/**
 * Integration smoke test for the unified aiStreamRound helper.
 *
 * Usage:
 *   bun scripts/test-ai-chains.ts
 *
 * Hits real providers, so every env var loaded by src/config/env.ts must be set
 * (all ZAI_*, HF_*, GEMINI_* plus BOT_TOKEN — the BOT_TOKEN is only read to
 * satisfy loadConfig(), we don't actually talk to Telegram here).
 */
import { aiStreamRound } from '../src/services/ai/streaming.ts';

async function runCase(name: string, fn: () => Promise<void>) {
  const start = Date.now();
  try {
    await fn();
    console.log(`  ✓ ${name} (${Date.now() - start}ms)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ✗ ${name} (${Date.now() - start}ms): ${msg.slice(0, 200)}`);
  }
}

async function main() {
  console.log('Testing unified aiStreamRound() helper');
  console.log('='.repeat(60));

  // 1) Smart chain, streaming callbacks
  console.log('\n[1] SMART chain with streaming callbacks');
  await runCase('streams text deltas and resolves', async () => {
    let chunks = 0;
    const result = await aiStreamRound(
      {
        messages: [
          { role: 'system', content: 'Reply briefly in Russian.' },
          { role: 'user', content: 'Привет, скажи одно предложение о погоде.' },
        ],
        maxTokens: 100,
      },
      {
        onTextDelta: (t) => {
          chunks++;
          process.stdout.write(t);
        },
      },
    );
    process.stdout.write('\n');
    console.log(`    provider=${result.providerUsed} chunks=${chunks} text="${result.text.slice(0, 80)}"`);
    if (!result.text) throw new Error('empty text');
  });

  // 2) Smart chain, collect mode (no callbacks)
  console.log('\n[2] SMART chain in collect mode (no callbacks)');
  await runCase('collects full result', async () => {
    const result = await aiStreamRound({
      messages: [{ role: 'user', content: 'Say hello in one short sentence.' }],
      maxTokens: 60,
    });
    console.log(`    provider=${result.providerUsed} text="${result.text.slice(0, 80)}"`);
    if (!result.text) throw new Error('empty text');
  });

  // 3) Fast chain
  console.log('\n[3] FAST chain');
  await runCase('fast chain resolves', async () => {
    const result = await aiStreamRound({
      messages: [{ role: 'user', content: 'Привет!' }],
      maxTokens: 60,
      fast: true,
    });
    console.log(`    provider=${result.providerUsed} text="${result.text.slice(0, 80)}"`);
    if (!result.text) throw new Error('empty text');
  });

  // 4) Tool calling on the smart chain
  console.log('\n[4] Tool calling on the SMART chain');
  await runCase('returns a tool call for "what time is it in Belgrade"', async () => {
    const result = await aiStreamRound({
      messages: [{ role: 'user', content: 'What time is it in Belgrade?' }],
      maxTokens: 200,
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_current_time',
            description: 'Get the current time in a given IANA timezone.',
            parameters: {
              type: 'object',
              properties: {
                timezone: { type: 'string', description: 'IANA timezone, e.g. Europe/Belgrade' },
              },
              required: ['timezone'],
            },
          },
        },
      ],
    });
    console.log(`    provider=${result.providerUsed} toolCalls=${result.toolCalls.length}`);
    for (const tc of result.toolCalls) {
      console.log(`      → ${tc.name}(${tc.arguments})`);
    }
    if (result.toolCalls.length === 0 && !result.text.includes('time')) {
      throw new Error('no tool call and no helpful text');
    }
  });

  console.log(`\n${'='.repeat(60)}\nDone!\n`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
