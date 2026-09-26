// test/services/ai/provider-circuit.test.ts
// The durable, provider-generic circuit: classification, the sidecar file, the
// half-open lease and the one-notice-per-incident contract.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  admitProvider,
  CIRCUIT_LEASE_MS,
  circuitBackoffMs,
  classifyCircuitFailure,
  configureProviderCircuit,
  flushProviderCircuitNotices,
  openProviderCircuitStore,
  providerCircuitClock,
  providerCircuitKey,
  resetProviderCircuit,
  settleAnswered,
  settleFailure,
  settleInconclusive,
  TRANSIENT_OPEN_THRESHOLD,
} from '../../../src/services/ai/provider-circuit.ts';
import {
  initProviderAlerts,
  reportProviderAnswered,
  resetProviderAlertState,
} from '../../../src/utils/ai-provider-alert.ts';

const MINUTE = 60_000;
const T0 = 1_700_000_000_000;

let dir: string;
let dbPath: string;
let clock: number;
let sent: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'provider-circuit-'));
  dbPath = join(dir, 'calendar.db.provider-state.sqlite');
  clock = T0;
  sent = [];
  providerCircuitClock.now = () => clock;
  resetProviderCircuit();
  resetProviderAlertState();
  initProviderAlerts({
    botToken: 't',
    adminId: 1,
    send: (html) => {
      sent.push(html);
    },
    now: () => clock,
  });
  clock += 2 * MINUTE; // past the alert layer's startup grace
});

afterEach(() => {
  resetProviderCircuit();
  resetProviderAlertState();
  providerCircuitClock.now = () => Date.now();
  rmSync(dir, { recursive: true, force: true });
});

function ctx(
  provider: 'zai' | 'groq' | 'gemini' | 'hf',
  chain: 'smart' | 'fast' = 'smart',
  apiKey = `${provider}-key`,
) {
  return {
    key: providerCircuitKey(provider, 'https://example.test/v1', apiKey),
    provider,
    label: `${provider} (model-x)`,
    chain,
  };
}

const CREDITS = { status: 402, message: 'Payment Required: SECRET-BODY-TEXT', providerDown: false };

describe('classifyCircuitFailure', () => {
  test('402, quota-worded 429 and 401/403 are account-scope failures', () => {
    expect(classifyCircuitFailure(CREDITS, T0)?.failureClass).toBe('quota_exhausted');
    expect(
      classifyCircuitFailure({ status: 429, message: 'Weekly/Monthly Limit Exhausted', providerDown: false }, T0)
        ?.failureClass,
    ).toBe('quota_exhausted');
    expect(classifyCircuitFailure({ status: 401, message: 'Invalid API key', providerDown: false }, T0)).toMatchObject({
      failureClass: 'auth_failed',
    });
    expect(
      classifyCircuitFailure({ status: 403, message: 'credit balance is too low', providerDown: false }, T0)
        ?.failureClass,
    ).toBe('quota_exhausted');
  });

  test('generic rate limits open the circuit, but request-specific failures do not', () => {
    expect(
      classifyCircuitFailure({ status: 429, message: 'Rate limit reached', providerDown: false }, T0)?.failureClass,
    ).toBe('quota_exhausted');
    expect(
      classifyCircuitFailure(
        { status: 429, message: 'Request too large for this context window', providerDown: false },
        T0,
      ),
    ).toBeNull();
    expect(
      classifyCircuitFailure({ status: 400, message: 'invalid user text: payment required', providerDown: false }, T0),
    ).toBeNull();
    expect(classifyCircuitFailure({ status: 413, message: 'Request too large', providerDown: false }, T0)).toBeNull();
    expect(classifyCircuitFailure({ status: 400, message: 'bad tool schema', providerDown: false }, T0)).toBeNull();
    expect(classifyCircuitFailure({ status: 404, message: 'model not found', providerDown: false }, T0)).toBeNull();
  });

  test('message text without a status is never enough — echoed request text must not open a circuit', () => {
    expect(
      classifyCircuitFailure({ status: undefined, message: 'payment required, unauthorized', providerDown: false }, T0),
    ).toBeNull();
  });

  test('5xx and connection failures are availability faults', () => {
    expect(classifyCircuitFailure({ status: 503, message: 'x', providerDown: true }, T0)?.failureClass).toBe(
      'unavailable',
    );
    expect(classifyCircuitFailure({ status: undefined, message: 'ECONNRESET', providerDown: true }, T0)).toMatchObject({
      failureClass: 'unavailable',
    });
  });

  test('Retry-After and a zoned reset timestamp are trusted; a zoneless one is only displayed', () => {
    const retry = classifyCircuitFailure({ ...CREDITS, headers: { 'Retry-After': '90' } }, T0);
    expect(retry?.retryAtMs).toBe(T0 + 90_000);

    const zoned = classifyCircuitFailure(
      { status: 402, message: 'balance empty, reset at 2026-09-20T10:00:00Z', providerDown: false },
      Date.parse('2026-09-19T10:00:00Z'),
    );
    expect(zoned?.retryAtMs).toBe(Date.parse('2026-09-20T10:00:00Z'));

    const zoneless = classifyCircuitFailure(
      { status: 402, message: 'balance empty, reset at 2026-09-20 10:00:00', providerDown: false },
      Date.parse('2026-09-19T10:00:00Z'),
    );
    expect(zoneless?.retryAtMs).toBeNull();
    expect(zoneless?.resetHint).toBe('2026-09-20 10:00:00');
  });
});

describe('circuitBackoffMs', () => {
  test('grows exponentially and is bounded', () => {
    const first = circuitBackoffMs('quota_exhausted', 0);
    expect(circuitBackoffMs('quota_exhausted', 1)).toBe(first * 2);
    expect(circuitBackoffMs('quota_exhausted', 40)).toBeLessThanOrEqual(6 * 60 * MINUTE);
    expect(circuitBackoffMs('unavailable', 40)).toBeLessThanOrEqual(10 * MINUTE);
  });
});

// One open file per inspection: stat and read act on the same descriptor, not a re-resolved path.
function throughDescriptor<T>(path: string, inspect: (fd: number) => T): T {
  const fd = openSync(path, 'r');
  try {
    return inspect(fd);
  } finally {
    closeSync(fd);
  }
}

describe('sidecar file', () => {
  test('is created 0600, survives a restart and never stores keys or error bodies', () => {
    const c = ctx('zai', 'smart', 'sk-very-secret-key');
    configureProviderCircuit(dbPath);
    settleFailure(c, admitProvider(c), CREDITS);
    expect(throughDescriptor(dbPath, (fd) => fstatSync(fd).mode & 0o777)).toBe(0o600);

    resetProviderCircuit();
    configureProviderCircuit(dbPath);
    expect(admitProvider(c).kind).toBe('skip');

    resetProviderCircuit();
    const raw = throughDescriptor(dbPath, (fd) => readFileSync(fd).toString('latin1'));
    expect(raw).not.toContain('sk-very-secret-key');
    expect(raw).not.toContain('SECRET-BODY-TEXT');
  });

  test('an unusable path degrades to an in-memory circuit instead of throwing', () => {
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'a file, not a directory');
    const c = ctx('groq');
    expect(() => configureProviderCircuit(join(blocker, 'nested', 'state.sqlite'))).not.toThrow();
    settleFailure(c, admitProvider(c), CREDITS);
    expect(admitProvider(c).kind).toBe('skip');
  });
});

describe('half-open lease', () => {
  test('an open circuit skips until its retry time, then admits exactly one probe', () => {
    const c = ctx('zai');
    configureProviderCircuit(dbPath);
    settleFailure(c, admitProvider(c), CREDITS);

    expect(admitProvider(c).kind).toBe('skip');
    clock += circuitBackoffMs('quota_exhausted', 0);
    expect(admitProvider(c).kind).toBe('probe');
    expect(admitProvider(c).kind).toBe('skip');
  });

  test('two processes racing for the probe: exactly one wins', () => {
    const c = ctx('zai');
    const a = openProviderCircuitStore(dbPath);
    const b = openProviderCircuitStore(dbPath);
    const verdict = classifyCircuitFailure(CREDITS, T0);
    if (!verdict) throw new Error('expected a verdict');
    a.recordFailure(c, verdict, null, T0);
    const readyAt = T0 + circuitBackoffMs('quota_exhausted', 0);

    const kinds = [a.admit(c.key, readyAt).kind, b.admit(c.key, readyAt).kind].sort();
    expect(kinds).toEqual(['probe', 'skip']);
    a.close();
    b.close();
  });

  test('a crashed probe frees the lease when it expires, not before', () => {
    const c = ctx('zai');
    configureProviderCircuit(dbPath);
    settleFailure(c, admitProvider(c), CREDITS);
    clock += circuitBackoffMs('quota_exhausted', 0);
    expect(admitProvider(c).kind).toBe('probe'); // holder crashes here, never settles

    clock += CIRCUIT_LEASE_MS - 1;
    expect(admitProvider(c).kind).toBe('skip');
    clock += 2;
    expect(admitProvider(c).kind).toBe('probe');
  });

  test('the deadline alone never closes the circuit', () => {
    const c = ctx('zai');
    const store = openProviderCircuitStore(dbPath);
    const verdict = classifyCircuitFailure({ ...CREDITS, headers: { 'retry-after': '60' } }, T0);
    if (!verdict) throw new Error('expected a verdict');
    store.recordFailure(c, verdict, null, T0);

    store.admit(c.key, T0 + 10 * 24 * 60 * MINUTE);
    expect(store.read(c.key)?.state).toBe('open');
    store.close();
  });

  test('a failed probe re-opens with a longer backoff and does not re-notify', () => {
    const c = ctx('zai');
    configureProviderCircuit(dbPath);
    settleFailure(c, admitProvider(c), CREDITS);
    expect(sent).toHaveLength(1);

    clock += circuitBackoffMs('quota_exhausted', 0);
    const probe = admitProvider(c);
    settleFailure(c, probe, CREDITS);
    expect(admitProvider(c).kind).toBe('skip');
    clock += circuitBackoffMs('quota_exhausted', 0);
    expect(admitProvider(c).kind).toBe('skip'); // step 1 is longer than step 0
    clock += circuitBackoffMs('quota_exhausted', 1);
    expect(admitProvider(c).kind).toBe('probe');
    expect(sent).toHaveLength(1);
  });

  test('an inconclusive probe (caller abort, per-request error) releases the lease without penalty', () => {
    const c = ctx('zai');
    configureProviderCircuit(dbPath);
    settleFailure(c, admitProvider(c), CREDITS);
    clock += circuitBackoffMs('quota_exhausted', 0);
    const probe = admitProvider(c);
    settleInconclusive(c, probe, { pushBack: false });
    expect(admitProvider(c).kind).toBe('probe');
  });
});

describe('closing and re-opening', () => {
  test('a provider answer closes the circuit and the next incident is a new one', () => {
    const c = ctx('zai');
    configureProviderCircuit(dbPath);
    settleFailure(c, admitProvider(c), CREDITS);
    settleAnswered(c);
    reportProviderAnswered(c.label, c.chain); // what the streaming layer does on every answer
    expect(admitProvider(c).kind).toBe('allow');

    clock += 30 * MINUTE; // beyond the alert layer's flap guard
    settleFailure(c, admitProvider(c), CREDITS);
    expect(sent.filter((m) => m.includes('исчерпан лимит'))).toHaveLength(2);
  });

  test('healthy traffic writes nothing', () => {
    const c = ctx('zai');
    const store = openProviderCircuitStore(dbPath);
    expect(store.recordSuccess(c.key)).toBe(false);
    expect(store.read(c.key)).toBeNull();
    store.close();
  });

  test('availability faults open only after consecutive failures and notify once', () => {
    const c = ctx('gemini');
    configureProviderCircuit(dbPath);
    const down = { status: 503, message: 'upstream', providerDown: true };
    for (let i = 0; i < TRANSIENT_OPEN_THRESHOLD - 1; i++) settleFailure(c, admitProvider(c), down);
    expect(admitProvider(c).kind).toBe('allow');

    settleAnswered(c);
    for (let i = 0; i < TRANSIENT_OPEN_THRESHOLD - 1; i++) settleFailure(c, admitProvider(c), down);
    expect(admitProvider(c).kind).toBe('allow'); // the answer reset the streak

    settleFailure(c, admitProvider(c), down);
    expect(admitProvider(c).kind).toBe('skip');
    expect(sent).toHaveLength(1);
  });
});

describe('admin notice', () => {
  test('one notice per incident, across probes and restarts', () => {
    const c = ctx('groq');
    configureProviderCircuit(dbPath);
    settleFailure(c, admitProvider(c), { status: 401, message: 'Invalid API key', providerDown: false });
    expect(sent).toHaveLength(1);

    resetProviderCircuit();
    resetProviderAlertState();
    initProviderAlerts({ botToken: 't', adminId: 1, send: (h) => void sent.push(h), now: () => clock });
    clock += 2 * MINUTE;
    configureProviderCircuit(dbPath);
    expect(admitProvider(c).kind).toBe('skip');
    clock += 12 * 60 * MINUTE;
    settleFailure(c, admitProvider(c), { status: 401, message: 'Invalid API key', providerDown: false });
    expect(admitProvider(c).kind).toBe('skip');
    expect(sent).toHaveLength(1);
  });

  test('a notice the alert layer could not deliver stays pending and is retried on the next skip', () => {
    const c = ctx('zai');
    configureProviderCircuit(dbPath);
    resetProviderAlertState(); // no alert transport: what an isolated probe script looks like
    settleFailure(c, admitProvider(c), CREDITS);
    expect(admitProvider(c).kind).toBe('skip');

    initProviderAlerts({ botToken: 't', adminId: 1, send: (h) => void sent.push(h), now: () => clock });
    clock += 2 * MINUTE;
    expect(admitProvider(c).kind).toBe('skip');
    expect(sent).toHaveLength(1);
    admitProvider(c);
    expect(sent).toHaveLength(1);
  });

  test('a notice sent inside the alert startup grace is not lost', () => {
    const c = ctx('zai');
    configureProviderCircuit(dbPath);
    resetProviderAlertState();
    initProviderAlerts({ botToken: 't', adminId: 1, send: (h) => void sent.push(h), now: () => clock });
    settleFailure(c, admitProvider(c), CREDITS); // 0 s after init: inside the grace window
    expect(sent).toHaveLength(1);

    clock += 2 * MINUTE;
    admitProvider(c);
    expect(sent).toHaveLength(1);
  });

  test('a throwing transport is contained and the notice is retried', () => {
    const c = ctx('zai');
    configureProviderCircuit(dbPath);
    resetProviderAlertState();
    let broken = true;
    initProviderAlerts({
      botToken: 't',
      adminId: 1,
      send: (h) => {
        if (broken) throw new Error('telegram down');
        sent.push(h);
      },
      now: () => clock,
    });
    clock += 2 * MINUTE;
    expect(() => settleFailure(c, admitProvider(c), CREDITS)).not.toThrow();
    expect(sent).toHaveLength(0);

    broken = false;
    clock += MINUTE;
    admitProvider(c);
    expect(sent).toHaveLength(1);
  });

  test('the notice carries no raw provider error body', () => {
    const c = ctx('zai');
    configureProviderCircuit(dbPath);
    settleFailure(c, admitProvider(c), {
      status: 429,
      message: 'Weekly limit exhausted SECRET-BODY-TEXT, resets at 2026-09-21 12:00:00',
      providerDown: false,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).not.toContain('SECRET-BODY-TEXT');
    expect(sent[0]).toContain('2026-09-21 12:00:00');
  });
});

describe('key', () => {
  test('changes with the credential and the endpoint, and contains neither', () => {
    const a = providerCircuitKey('zai', 'https://a.test', 'key-1');
    expect(providerCircuitKey('zai', 'https://a.test', 'key-2')).not.toBe(a);
    expect(providerCircuitKey('zai', 'https://b.test', 'key-1')).not.toBe(a);
    expect(a).not.toContain('key-1');
  });
});

describe('one actual account incident across models and chains', () => {
  test('success on another chain resets the flag without a flap-suppression delay', () => {
    configureProviderCircuit(dbPath);
    const fast = ctx('zai', 'fast');
    const smart = ctx('zai', 'smart');
    settleFailure(fast, admitProvider(fast), CREDITS);
    expect(sent).toHaveLength(1);
    clock += 6 * MINUTE;
    settleAnswered(smart);
    settleFailure(fast, admitProvider(fast), CREDITS);
    expect(sent).toHaveLength(2);
  });
  test('an availability circuit emits one opening notice, not a repeated outage timer', () => {
    configureProviderCircuit(dbPath);
    const context = ctx('gemini');
    const down = { status: 503, message: 'Temporary outage', providerDown: true };
    for (let i = 0; i < TRANSIENT_OPEN_THRESHOLD; i++) settleFailure(context, admitProvider(context), down);
    expect(sent).toHaveLength(1);
    clock += MINUTE;
    settleFailure(context, admitProvider(context), down);
    expect(sent).toHaveLength(1);
  });
});

test('asynchronous notification failure is contained, backed off, then delivered once', async () => {
  configureProviderCircuit(dbPath);
  let attempts = 0;
  initProviderAlerts({
    botToken: 'synthetic',
    adminId: 1,
    now: () => clock,
    send: async (text) => {
      attempts++;
      if (attempts === 1) throw new Error('Synthetic unavailable transport');
      sent.push(text);
    },
  });
  const context = ctx('gemini');
  settleFailure(context, admitProvider(context), CREDITS);
  await flushProviderCircuitNotices();
  expect(attempts).toBe(1);
  expect(sent).toHaveLength(0);
  admitProvider(context);
  expect(attempts).toBe(1);
  clock += MINUTE;
  admitProvider(context);
  await flushProviderCircuitNotices();
  expect(attempts).toBe(2);
  expect(sent).toHaveLength(1);
  clock += MINUTE;
  admitProvider(context);
  await flushProviderCircuitNotices();
  expect(sent).toHaveLength(1);
});
test('a crashed notice sender leaves a renewable lease, not an eternal lost message', () => {
  const circuit = openProviderCircuitStore(dbPath);
  const context = ctx('groq');
  circuit.recordFailure(
    context,
    { failureClass: 'auth_failed', status: 401, retryAtMs: null, resetHint: null },
    null,
    clock,
  );
  const first = circuit.claimNotice(context.key, clock)!;
  expect(circuit.claimNotice(context.key, clock + 1)).toBeNull();
  clock += CIRCUIT_LEASE_MS;
  const second = circuit.claimNotice(context.key, clock)!;
  expect(second.notice_owner).not.toBe(first.notice_owner);
  circuit.finishNotice(context.key, first.notice_owner!, true, clock);
  expect(circuit.read(context.key)?.notice_owner).toBe(second.notice_owner);
  circuit.finishNotice(context.key, second.notice_owner!, true, clock);
  expect(circuit.claimNotice(context.key, clock + 86400000)).toBeNull();
  circuit.close();
});

test('SQLite state and WAL stay private even with a permissive process umask', () => {
  const previous = process.umask(0o022);
  const circuit = openProviderCircuitStore(dbPath);
  try {
    circuit.recordFailure(
      ctx('groq'),
      { failureClass: 'auth_failed', status: 401, retryAtMs: null, resetHint: null },
      null,
      clock,
    );
    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) expect(statSync(path).mode & 0o077).toBe(0);
  } finally {
    circuit.close();
    process.umask(previous);
  }
});
