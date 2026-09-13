import { z } from 'zod';
export interface RateSnapshot {
  rates: Record<string, string>;
  asOf: string;
  source: string;
}
const URL = 'https://open.er-api.com/v6/latest/EUR';
const MAX_AGE = 48 * 60 * 60 * 1000;
const feedSchema = z.object({
  result: z.literal('success'),
  base_code: z.literal('EUR'),
  time_last_update_unix: z.number().int().positive(),
  rates: z.record(z.string().regex(/^[A-Z]{3}$/), z.number().finite().positive()),
});
/** Public rates only: no user amount, expression or identity is sent to the provider. */
export function createRateSource(
  fetcher: (url: string, init?: RequestInit) => Promise<Response> = fetch,
  now: () => number = Date.now,
) {
  let retryAfter = 0;
  let cache: RateSnapshot | null = null,
    validUntil = 0,
    pending: Promise<RateSnapshot> | null = null;
  async function load(): Promise<RateSnapshot> {
    const response = await fetcher(URL, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error('EXCHANGE_RATES_UNAVAILABLE');
    }
    if (!response.body) throw new Error('EXCHANGE_RATES_UNAVAILABLE');
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let text = '',
      bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > 65536) throw new Error('EXCHANGE_RATE_RESPONSE_TOO_LARGE');
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const data = feedSchema.parse(JSON.parse(text));
    const timestamp = data.time_last_update_unix * 1000;
    if (
      timestamp > now() + 300000 ||
      now() - timestamp > MAX_AGE ||
      data.rates.EUR !== 1 ||
      Object.keys(data.rates).length > 300
    )
      throw new Error('INVALID_EXCHANGE_RATES');
    cache = {
      rates: Object.fromEntries(Object.entries(data.rates).map(([code, value]) => [code, String(value)])),
      asOf: new Date(timestamp).toISOString(),
      source: 'https://www.exchangerate-api.com',
    };
    validUntil = Math.min(now() + 24 * 60 * 60 * 1000, timestamp + MAX_AGE);
    return cache;
  }
  return {
    async get(): Promise<RateSnapshot> {
      if (cache && now() < validUntil) return structuredClone(cache);
      if (now() < retryAfter) throw new Error('EXCHANGE_RATES_COOLDOWN');
      pending ??= load()
        .catch((error) => {
          retryAfter = now() + 60000;
          throw error;
        })
        .finally(() => {
          pending = null;
        });
      return structuredClone(await pending);
    },
  };
}
export const currencyRates = createRateSource();
