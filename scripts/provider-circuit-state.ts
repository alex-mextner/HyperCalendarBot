// Inspect runtime sidecar: no provider request or forced clearing; schema setup may run.
import { existsSync } from 'node:fs';
import { loadConfig } from '../src/config/env.ts';
import { openProviderCircuitStore, providerCircuitKey } from '../src/services/ai/provider-circuit.ts';
import type { ProviderId } from '../src/services/ai/provider-ids.ts';

const config = loadConfig();
const path = `${config.DATABASE_PATH}.provider-state.sqlite`;
const accounts: [ProviderId, string, string][] = [
  ['zai', config.ZAI_BASE_URL, config.ZAI_API_KEY],
  ['groq', '', config.GROQ_API_KEY ?? ''],
  ['gemini', config.GEMINI_BASE_URL, config.GEMINI_API_KEY],
  ['hf', config.HF_BASE_URL, config.HF_TOKEN],
];
if (!existsSync(path)) console.log(JSON.stringify({ initialized: false, providers: [] }, null, 2));
else {
  const store = openProviderCircuitStore(path);
  try {
    const providers = accounts
      .filter(([, , key]) => Boolean(key))
      .map(([provider, url, key]) => {
        const row = store.read(providerCircuitKey(provider, url, key));
        return {
          provider,
          state: row?.state ?? 'closed',
          failureClass: row?.failure_class ?? null,
          status: row?.status ?? null,
          openedAt: row?.opened_at ? new Date(row.opened_at).toISOString() : null,
          nextProbeAt: row?.ready_at ? new Date(row.ready_at).toISOString() : null,
          noticeState: row?.notice_state ?? 'none',
        };
      });
    console.log(JSON.stringify({ initialized: true, providers }, null, 2));
  } finally {
    store.close();
  }
}
