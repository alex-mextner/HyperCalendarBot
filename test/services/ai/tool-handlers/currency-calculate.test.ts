import { describe, expect, test } from 'bun:test';
import {
  evaluateCurrency,
  handleCalculateWithCurrency,
} from '../../../../src/services/ai/tool-handlers/currency-calculate.ts';
import { createRateSource } from '../../../../src/services/currency/rates.ts';

const rates = { EUR: '1', USD: '1.25', RSD: '125' };
describe('currency calculations', () => {
  test.each([
    ['100 USD - 30 EUR', '50'],
    ['1500 RSD + 10€', '22'],
    ['100$ * 3', '240'],
    ['(100 USD + 50 EUR) / 2', '65'],
    ['100 EUR - 10%', '90'],
    ['1,005 EUR * 3', '3.015'],
    ['100 EUR / 20 EUR', '5'],
  ])('%s', (expr, expected) => expect(evaluateCurrency(expr, 'EUR', rates).value).toBe(expected));
  test('keeps dimensionless ratios dimensionless', () =>
    expect(evaluateCurrency('100 EUR / 20 EUR', 'EUR', rates).currency).toBeNull());
  test.each([
    '100 USD * 20 EUR',
    '100 EUR + 2',
    '1 / 20 EUR',
    '100 EUR / 0',
    '100 XXX',
    '10EUR trailing',
    '()',
    ''.padEnd(501, '1'),
  ])('rejects %s', (expr) => expect(() => evaluateCurrency(expr, 'EUR', rates)).toThrow());
  test('missing rates never become parity', () =>
    expect(() => evaluateCurrency('100 CHF', 'EUR', rates)).toThrow('MISSING_RATE'));
  test('same currency needs no exchange rate', () =>
    expect(evaluateCurrency('5 GBP + 10 GBP', 'GBP', {}).value).toBe('15'));
});
describe('live rate source', () => {
  const now = 1789246800000;
  const data = {
    result: 'success',
    base_code: 'EUR',
    time_last_update_unix: Math.floor(now / 1000) - 60,
    rates: { EUR: 1, USD: 1.25, RSD: 125 },
  };
  test('singleflight cache exposes timestamp and valid rates', async () => {
    let calls = 0;
    const source = createRateSource(
      async () => {
        calls++;
        return Response.json(data);
      },
      () => now,
    );
    const [a, b] = await Promise.all([source.get(), source.get()]);
    expect(a.rates.RSD).toBe('125');
    expect(b.asOf).toBe(a.asOf);
    expect(calls).toBe(1);
    a.rates.RSD = '0';
    expect((await source.get()).rates.RSD).toBe('125');
  });
  test.each([
    { ...data, base_code: 'USD' },
    { ...data, time_last_update_unix: 1 },
    { ...data, rates: { EUR: 1, USD: 0 } },
    { ...data, rates: { EUR: 1, USD: -2 } },
  ])('rejects untrustworthy feed', async (body) => {
    const source = createRateSource(
      async () => Response.json(body),
      () => now,
    );
    await expect(source.get()).rejects.toThrow();
  });
  test('API failure is explicit, not hardcoded fallback', async () => {
    const source = createRateSource(
      async () => new Response('', { status: 503 }),
      () => now,
    );
    await expect(source.get()).rejects.toThrow();
  });
});

describe('calculate wrapper', () => {
  test('preserves numeric path', async () =>
    expect((await handleCalculateWithCurrency({ expression: '1.005 * 3' })).output).toBe('3.015'));
  test('same-currency expressions need no HTTP request', async () => {
    let called = false;
    const r = await handleCalculateWithCurrency({ expression: '10 EUR + 20 EUR', target_currency: 'EUR' }, async () => {
      called = true;
      throw new Error('offline');
    });
    expect(r.success).toBe(true);
    expect(called).toBe(false);
  });
  test('attaches quote timestamp and attribution', async () => {
    const r = await handleCalculateWithCurrency({ expression: '100 USD', target_currency: 'EUR' }, async () => ({
      rates,
      asOf: '2026-09-12T00:00:00Z',
      source: 'https://www.exchangerate-api.com',
    }));
    expect(r.success).toBe(true);
    expect(JSON.parse(r.output!).value).toBe('80');
    expect(r.output).toContain('2026-09-12');
    expect(r.agentHint).toContain('source');
  });
  test('network errors never yield a made-up conversion', async () =>
    expect(
      (
        await handleCalculateWithCurrency({ expression: '100 USD', target_currency: 'EUR' }, async () => {
          throw new Error('offline');
        })
      ).success,
    ).toBe(false));
});

describe('review regressions', () => {
  test('unsupported same currency never passes the offline shortcut', () =>
    expect(() => evaluateCurrency('10 XYZ + 20 XYZ', 'XYZ', {})).toThrow());
  test('accepted precision never silently underflows', () =>
    expect(() => evaluateCurrency('0.000000000000000000001 USD * 1000000000000000000000', 'EUR', rates)).toThrow());
  test('sequential failures use a bounded negative cache', async () => {
    let calls = 0,
      clock = 1789246800000;
    const source = createRateSource(
      async () => {
        calls++;
        return new Response('', { status: 503 });
      },
      () => clock,
    );
    await expect(source.get()).rejects.toThrow();
    await expect(source.get()).rejects.toThrow();
    expect(calls).toBe(1);
    clock += 61000;
    await expect(source.get()).rejects.toThrow();
    expect(calls).toBe(2);
  });
});

test('division rounding is not amplified by later multiplication', () => {
  const expr = '0.000000000000000001 EUR / 6000000000000000000000 * 6000000000000000000000 * 1000000000000000000';
  expect(evaluateCurrency(expr, 'EUR', {}).value).toBe('1');
});
test('invalid dimensions or syntax do not fetch rates', async () => {
  for (const expression of ['1 USD + 2', '1 USD trailing', '1 USD * 1 EUR']) {
    let calls = 0;
    const result = await handleCalculateWithCurrency({ expression, target_currency: 'EUR' }, async () => {
      calls++;
      return { rates, asOf: 'synthetic', source: 'synthetic' };
    });
    expect(result.success).toBe(false);
    expect(calls).toBe(0);
  }
});
test('non-success HTTP bodies are cancelled', async () => {
  let cancels = 0;
  const source = createRateSource(
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(65537));
          },
          cancel() {
            cancels++;
          },
        }),
        { status: 503 },
      ),
  );
  await expect(source.get()).rejects.toThrow();
  expect(cancels).toBe(1);
});

test('the ordinary numeric path shares exact intermediate ratios', async () => {
  expect((await handleCalculateWithCurrency({ expression: '1 / 3 * 3' })).output).toBe('1');
  expect(
    (
      await handleCalculateWithCurrency({
        expression: '0.000000000000000001 / 6000000000000000000000 * 6000000000000000000000 * 1000000000000000000',
      })
    ).output,
  ).toBe('1');
});
