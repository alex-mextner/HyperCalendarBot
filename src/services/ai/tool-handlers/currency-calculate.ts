import Big from 'big.js';
import { SUPPORTED_CURRENCY_CODES } from '../../currency/codes.ts';

const supported: ReadonlySet<string> = new Set(SUPPORTED_CURRENCY_CODES);
const Decimal = Big();
Decimal.DP = 40;
function divide(a: Big, b: Big): Big {
  const result = a.div(b);
  if (!a.eq(0) && result.eq(0)) throw new Error('PRECISION_LIMIT');
  return result;
}

import { currencyRates, type RateSnapshot } from '../../currency/rates.ts';
import type { ToolHandlerMeta, ToolResult } from '../types.ts';
import { handleCalculate } from './calculate.ts';

interface Value {
  value: Big;
  money: boolean;
}
const aliases: Record<string, string> = { $: 'USD', '€': 'EUR', '£': 'GBP', '₽': 'RUB' };
/** Decimal arithmetic plus dimensional checks; no eval, invented rates or unlabelled mixed units. */
export function evaluateCurrency(
  expression: string,
  target: string,
  rates: Readonly<Record<string, string>>,
): { value: string; currency: string | null } {
  if (expression.length > 500 || !expression.trim() || !supported.has(target))
    throw new Error('INVALID_CURRENCY_EXPRESSION');
  const expr = expression.replace(/,/g, '.').replace(/×/g, '*').replace(/÷/g, '/');
  let pos = 0,
    depth = 0;
  function space() {
    while (pos < expr.length && /\s/.test(expr[pos]!)) pos++;
  }
  function code(): string | null {
    space();
    const token = expr.slice(pos).match(/^([$€£₽]|[A-Za-z]{3})(?![A-Za-z])/);
    if (!token) return null;
    pos += token[0].length;
    return aliases[token[0]] ?? token[0].toUpperCase();
  }
  function convert(value: Big, from: string): Big {
    if (!supported.has(from)) throw new Error('UNSUPPORTED_CURRENCY');
    if (from === target) return value;
    const a = rates[from],
      b = rates[target];
    if (!a || !b || !new Big(a).gt(0) || !new Big(b).gt(0)) throw new Error('MISSING_RATE');
    return divide(value.times(b), new Decimal(a));
  }
  function factor(): Value {
    space();
    if (++depth > 32) throw new Error('EXPRESSION_TOO_DEEP');
    try {
      if (expr[pos] === '+' || expr[pos] === '-') {
        const minus = expr[pos++] === '-';
        const r = factor();
        return { ...r, value: minus ? r.value.times(-1) : r.value };
      }
      if (expr[pos] === '(') {
        pos++;
        const r = sum();
        space();
        if (expr[pos++] !== ')') throw new Error('EXPECTED_CLOSE');
        return r;
      }
      const before = code();
      space();
      const number = expr.slice(pos).match(/^\d+(?:\.\d+)?/);
      if (!number || number[0].length > 30 || (number[0].split('.')[1]?.length ?? 0) > 18)
        throw new Error('EXPECTED_NUMBER');
      pos += number[0].length;
      const after = code();
      if (before && after) throw new Error('DUPLICATE_CURRENCY');
      const currency = before ?? after;
      const value = new Decimal(number[0]);
      return { value: currency ? convert(value, currency) : value, money: currency !== null };
    } finally {
      depth--;
    }
  }
  function product(): Value {
    let left = factor();
    while (true) {
      space();
      const op = expr[pos];
      if (op !== '*' && op !== '/') return left;
      pos++;
      const right = factor();
      if (op === '*' && left.money && right.money) throw new Error('MONEY_SQUARED');
      if (op === '/' && !left.money && right.money) throw new Error('INVERSE_MONEY');
      if (op === '/' && right.value.eq(0)) throw new Error('DIVISION_BY_ZERO');
      left = {
        value: op === '*' ? left.value.times(right.value) : divide(left.value, right.value),
        money: op === '*' ? left.money || right.money : left.money && !right.money,
      };
    }
  }
  function sum(): Value {
    let left = product();
    while (true) {
      space();
      const op = expr[pos];
      if (op !== '+' && op !== '-') return left;
      pos++;
      const right = product();
      space();
      if (expr[pos] === '%') {
        if (right.money) throw new Error('INVALID_PERCENT');
        pos++;
        const delta = divide(left.value.times(right.value), new Decimal(100));
        left = { ...left, value: op === '+' ? left.value.plus(delta) : left.value.minus(delta) };
        continue;
      }
      if (left.money !== right.money) throw new Error('MIXED_UNLABELLED_UNITS');
      left = { value: op === '+' ? left.value.plus(right.value) : left.value.minus(right.value), money: left.money };
    }
  }
  const result = sum();
  space();
  if (pos !== expr.length) throw new Error('TRAILING_INPUT');
  const value = result.value.toFixed();
  if (value.length > 1000) throw new Error('RESULT_TOO_LARGE');
  return { value, currency: result.money ? target : null };
}
export async function handleCalculateWithCurrency(
  input: { expression: string; target_currency?: string },
  getRates: () => Promise<RateSnapshot> = () => currencyRates.get(),
): Promise<ToolResult> {
  if (!input.target_currency) return handleCalculate(input);
  if (input.expression.length > 500 || !/^[A-Za-z]{3}$/.test(input.target_currency))
    return { success: false, error: 'INVALID_CURRENCY_INPUT' };
  try {
    const target = input.target_currency.toUpperCase();
    try {
      const same = evaluateCurrency(input.expression, target, {});
      return { success: true, output: JSON.stringify({ ...same, rate_kind: 'no conversion required' }) };
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'MISSING_RATE') throw error;
    }
    const snapshot = await getRates();
    const result = evaluateCurrency(input.expression, target, snapshot.rates);
    return {
      success: true,
      output: JSON.stringify({
        ...result,
        rate_as_of: snapshot.asOf,
        rate_source: snapshot.source,
        rate_kind: 'daily indicative; not a bank quote',
      }),
      agentHint:
        'Include the rate date and Rates By Exchange Rate API source link in the answer. Do not claim bank/exchange-office rates.',
    };
  } catch {
    return {
      success: false,
      error:
        'CURRENCY_CALCULATION_FAILED: check explicit currency codes/units and rate availability; no estimated or 1:1 fallback was used.',
    };
  }
}
handleCalculateWithCurrency.meta = { readonly: true, skipActionLog: true } satisfies ToolHandlerMeta;
