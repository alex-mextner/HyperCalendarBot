// Inspect runtime sidecar: no provider request or forced clearing; schema setup may run.
// One row per circuit: an `account` row (the whole credential: spent credit or a rejected key) and, for
// OpenRouter, one `model` row per configured model (rate limits and outages of that model's upstream).
import { existsSync } from 'node:fs';
import { loadConfig } from '../src/config/env.ts';
import { presetById } from '../src/services/ai/model-presets.ts';
import { openProviderCircuitStore, providerCircuitKey } from '../src/services/ai/provider-circuit.ts';
import type { ProviderId } from '../src/services/ai/provider-ids.ts';
import { openrouterCircuitScope } from '../src/services/ai/streaming.ts';

const config = loadConfig();
const path = `${config.DATABASE_PATH}.provider-state.sqlite`;

interface Circuit {
  provider: ProviderId;
  /** `account`: the whole credential; `model`: one model behind it. */
  scope: 'account' | 'model';
  model: string | null;
  key: string;
}

const accounts: [ProviderId, string, string][] = [
  ['zai', config.ZAI_BASE_URL, config.ZAI_API_KEY],
  ['hf', config.HF_BASE_URL, config.HF_TOKEN],
  ['claude', '', config.CLAUDE_API_TOKEN ?? ''],
  ['openrouter', config.OPENROUTER_BASE_URL, config.OPENROUTER_API_KEY ?? ''],
];

/** Every OpenRouter model a chain can name: the two configured ones and the model of each role-chain entry. */
const openrouterModels = [
  ...new Set(
    [
      config.OPENROUTER_MODEL,
      config.OPENROUTER_FAST_MODEL,
      ...Object.values(config.AI_ROLE_CHAINS)
        .flat()
        .filter((entry) => entry.provider === 'openrouter')
        .map((entry) => (entry.presetId ? presetById(entry.presetId)?.models.openrouter : config.OPENROUTER_MODEL)),
    ].filter((model): model is string => Boolean(model)),
  ),
];

const circuits: Circuit[] = accounts
  .filter(([, , apiKey]) => Boolean(apiKey))
  .flatMap(([provider, baseUrl, apiKey]): Circuit[] => [
    { provider, scope: 'account', model: null, key: providerCircuitKey(provider, baseUrl, apiKey) },
    ...(provider === 'openrouter'
      ? openrouterModels.map(
          (model): Circuit => ({
            provider,
            scope: 'model',
            model,
            key: providerCircuitKey(provider, openrouterCircuitScope(baseUrl, model), apiKey),
          }),
        )
      : []),
  ]);

if (!existsSync(path)) console.log(JSON.stringify({ initialized: false, providers: [] }, null, 2));
else {
  const store = openProviderCircuitStore(path);
  try {
    const providers = circuits.map(({ provider, scope, model, key }) => {
      const row = store.read(key);
      return {
        provider,
        scope,
        model,
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
