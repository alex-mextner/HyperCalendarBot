import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config/env.ts';
import { configureProviderCircuit, resetProviderCircuit } from '../src/services/ai/provider-circuit.ts';
import { aiStreamRound, type StreamRoundOptions, type StreamRoundResult } from '../src/services/ai/streaming.ts';

const EXPECTED = 'HCB_RUNTIME_OK';
/** One synthetic request; no calendar tools, user messages or Telegram delivery. */
export async function probeAiChain(
  fast = true,
  stream: (options: StreamRoundOptions) => Promise<StreamRoundResult> = aiStreamRound,
) {
  const started = performance.now();
  try {
    const result = await stream({
      messages: [{ role: 'user', content: `Return exactly ${EXPECTED}. No tools or other text.` }],
      fast,
      maxTokens: 128,
      temperature: 0,
      signal: AbortSignal.timeout(30_000),
      requestId: `synthetic-runtime-${randomUUID()}`,
    });
    return {
      checkedAt: new Date().toISOString(),
      ok: result.text.trim() === EXPECTED && result.toolCalls.length === 0 && result.finishReason === 'stop',
      chain: fast ? 'fast' : 'smart',
      provider: result.providerUsed,
      durationMs: Math.round(performance.now() - started),
      metrics: result.metrics ?? null,
      scope: 'isolated process/provider probe, not Telegram end-to-end acceptance',
    };
  } catch (error) {
    return {
      checkedAt: new Date().toISOString(),
      ok: false,
      chain: fast ? 'fast' : 'smart',
      durationMs: Math.round(performance.now() - started),
      errorType: error instanceof Error ? error.name : 'UnknownError',
      provider: null,
      metrics: null,
      scope: 'isolated process/provider probe, not Telegram end-to-end acceptance',
    };
  }
}
if (import.meta.main) {
  const config = loadConfig();
  configureProviderCircuit(`${config.DATABASE_PATH}.provider-state.sqlite`);
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { smart: { type: 'boolean', default: false } },
    strict: true,
  });
  const result = await probeAiChain(!values.smart);
  console.log(`PROBE_JSON ${JSON.stringify(result)}`);
  resetProviderCircuit();
  if (!result.ok) process.exitCode = 1;
}
