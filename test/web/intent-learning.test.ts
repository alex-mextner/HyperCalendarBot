import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { migrations } from '../../src/database/migrations.ts';
import { runMigrations } from '../../src/database/schema.ts';
import { INTENT_LEARNING_ROUTE_PREFIX, MAX_BODY_BYTES } from '../../src/services/intent-learning/constants.ts';
import { IntentLearningService } from '../../src/services/intent-learning/service.ts';
import { handleIntentLearningRequest, type IntentLearningRouteOptions } from '../../src/web/intent-learning.ts';

/** Obviously fake bearer placeholders, long enough for the route's minimum length. */
const WORKER = 'FAKE-WORKER-BEARER-FOR-TESTS-ONLY-0001';
const ADMIN = 'FAKE-ADMIN-BEARER-FOR-TESTS-ONLY-00002';
const ALERT = 'FAKE-ALERT-BEARER-FOR-TESTS-ONLY-00003';

let db: Database;
let service: IntentLearningService;
let options: IntentLearningRouteOptions;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db, migrations);
  service = IntentLearningService.open({ mainDb: db, sidecarPath: ':memory:', adminId: 1 });
  options = { service, workerToken: WORKER, adminToken: ADMIN, alertToken: ALERT };
});
afterEach(() => {
  service.close();
  db.close();
});

function call(
  path: string,
  init: { method?: string; token?: string; body?: string; contentType?: string } = {},
  routeOptions = options,
) {
  const headers: { [key: string]: string } = { 'Content-Type': init.contentType ?? 'application/json' };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  const request = new Request(`http://localhost${INTENT_LEARNING_ROUTE_PREFIX}${path}`, {
    method: init.method ?? 'POST',
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  return handleIntentLearningRequest(request, routeOptions);
}

const enqueueBody = JSON.stringify({
  actorId: 7,
  chatId: 7,
  request: 'bot version please',
  previousAiResponse: 'v1',
  toolCalls: [{ name: 'get_bot_info', input: {} }],
});

describe('route contract', () => {
  test('paths outside the prefix are left to the parent server', async () => {
    const response = await handleIntentLearningRequest(new Request('http://localhost/admin/alerts'), options);
    expect(response).toBeNull();
  });

  test('responses carry no-store and no CORS headers', async () => {
    const response = await call('/status', { method: 'GET', token: ADMIN });
    expect(response?.status).toBe(200);
    expect(response?.headers.get('Cache-Control')).toBe('no-store');
    expect(response?.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const text = await response!.text();
    expect(text).not.toContain(ADMIN);
    expect(text).not.toContain(WORKER);
  });

  test('schema is served to the worker', async () => {
    const response = await call('/schema', { method: 'GET', token: WORKER });
    expect(response?.status).toBe(200);
    expect(Object.keys(await response!.json())).toEqual(['instructions', 'proposal', 'review']);
  });

  test('idle claim answers 204; a queued job is leased with the fixed model contract', async () => {
    const idle = await call('/claim', { token: WORKER, body: JSON.stringify({ workerId: 'w1' }) });
    expect(idle?.status).toBe(204);
    expect((await call('/enqueue', { token: ADMIN, body: enqueueBody }))?.status).toBe(200);
    const claimed = await call('/claim', { token: WORKER, body: JSON.stringify({ workerId: 'w1' }) });
    expect(claimed?.status).toBe(200);
    expect(await claimed!.json()).toMatchObject({
      stage: 'generate',
      round: 1,
      model: 'claude-opus-5',
      permissionMode: 'auto',
    });
  });
});

describe('authentication and privilege separation', () => {
  test('missing or wrong bearer is 401', async () => {
    expect((await call('/status', { method: 'GET' }))?.status).toBe(401);
    expect((await call('/status', { method: 'GET', token: ALERT }))?.status).toBe(401);
  });

  test('the worker cannot use admin routes and the admin cannot act as a worker', async () => {
    const approve = JSON.stringify({ id: 1, expectedHash: 'a'.repeat(64) });
    expect((await call('/approve', { token: WORKER, body: approve }))?.status).toBe(403);
    expect((await call('/enqueue', { token: WORKER, body: enqueueBody }))?.status).toBe(403);
    expect((await call('/status', { method: 'GET', token: WORKER }))?.status).toBe(403);
    expect((await call('/claim', { token: ADMIN, body: JSON.stringify({ workerId: 'w' }) }))?.status).toBe(403);
  });

  test('shared or reused tokens disable the route; unconfigured tokens hide it', async () => {
    const shared = { ...options, adminToken: WORKER };
    expect((await call('/status', { method: 'GET', token: WORKER }, shared))?.status).toBe(503);
    const alertReuse = { ...options, adminToken: ALERT };
    expect((await call('/status', { method: 'GET', token: ALERT }, alertReuse))?.status).toBe(503);
    const hidden = { service };
    expect((await call('/status', { method: 'GET', token: ADMIN }, hidden))?.status).toBe(404);
    const short = { service, adminToken: 'short' };
    expect((await call('/status', { method: 'GET', token: 'short' }, short))?.status).toBe(404);
  });

  test('approval by the admin bearer still requires an existing proposal and its hash', async () => {
    const response = await call('/approve', {
      token: ADMIN,
      body: JSON.stringify({ id: 99, expectedHash: 'a'.repeat(16) }),
    });
    expect(response?.status).toBe(404);
  });
});

describe('request hygiene', () => {
  test('wrong method is 405 and non-JSON content is 415', async () => {
    expect((await call('/claim', { method: 'GET', token: WORKER }))?.status).toBe(405);
    const text = await call('/claim', { token: WORKER, body: 'workerId=w', contentType: 'text/plain' });
    expect(text?.status).toBe(415);
  });

  test('bodies over 1 MiB are 413, malformed JSON is 400, schema violations are 422', async () => {
    const huge = await call('/enqueue', { token: ADMIN, body: `"${'x'.repeat(MAX_BODY_BYTES)}"` });
    expect(huge?.status).toBe(413);
    expect((await call('/claim', { token: WORKER, body: '{"workerId":' }))?.status).toBe(400);
    const extra = JSON.stringify({ workerId: 'w', approve: true });
    expect((await call('/claim', { token: WORKER, body: extra }))?.status).toBe(422);
  });

  test('draft bodies cannot carry approval or status flags', async () => {
    const proposal = {
      action: 'create',
      proposal: {
        summary: 'x',
        operations: [
          {
            kind: 'create',
            sourceNames: [],
            intents: [
              {
                canonical_name: 'x',
                pattern: '^x$',
                workflow: { version: 2, steps: [{ call: 'get_bot_info', input: {} }] },
                phrases: ['x'],
                trigger_words: ['x'],
                source_message: 'x',
                status: 'approved',
              },
            ],
            reason: 'r',
          },
        ],
      },
    };
    const response = await call('/proposals', { token: ADMIN, body: JSON.stringify(proposal) });
    expect(response?.status).toBe(422);
    expect(service.listProposals()).toHaveLength(0);
  });
});
