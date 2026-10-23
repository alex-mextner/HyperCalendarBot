// test/bot/commands/ai-stats.test.ts
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, type Mock, mock, test } from 'bun:test';
import { handleAiStats } from '../../../src/bot/commands/ai-stats.ts';
import type { BotCommandContext } from '../../../src/bot/types.ts';
import { migrations } from '../../../src/database/migrations.ts';
import { type AiUsageEvent, AiUsageRepository } from '../../../src/database/repositories/ai-usage.repository.ts';
import { runMigrations } from '../../../src/database/schema.ts';

const ADMIN_ID = 42;
const DAY_MS = 24 * 60 * 60 * 1000;

interface FakeContext {
  dbUser: { telegram_id: number; language: 'en' | 'ru' } | undefined;
  send: Mock<(text: string, options?: { parse_mode?: string }) => Promise<void>>;
  args: string | null;
}

function makeCtx(
  overrides: { telegram_id?: number; language?: 'en' | 'ru'; args?: string | null; noUser?: boolean } = {},
): FakeContext {
  return {
    dbUser: overrides.noUser
      ? undefined
      : { telegram_id: overrides.telegram_id ?? ADMIN_ID, language: overrides.language ?? 'en' },
    send: mock(async (_text: string, _options?: { parse_mode?: string }) => {}),
    args: overrides.args ?? null,
  };
}

/** The handler reads only `dbUser`, `args` and `send`; this is the one place the partial context is presented as a full one. */
function asContext(fake: FakeContext): BotCommandContext {
  return fake as unknown as BotCommandContext;
}

function event(overrides: Partial<AiUsageEvent> = {}): AiUsageEvent {
  return {
    at: Date.now() - DAY_MS,
    provider: 'groq',
    model: 'openai/gpt-oss-120b',
    chain: 'smart',
    purpose: 'agent',
    outcome: 'ok',
    errorClass: null,
    httpStatus: null,
    skipReason: null,
    durationMs: 400,
    promptTokens: 100,
    completionTokens: 10,
    reasoningTokens: null,
    cachedTokens: null,
    requestId: null,
    ...overrides,
  };
}

function sent(ctx: FakeContext): string[] {
  return ctx.send.mock.calls.map((call) => call[0]);
}

describe('handleAiStats', () => {
  let db: Database;
  let repo: AiUsageRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    repo = new AiUsageRepository(db);
  });

  test('fails closed for anyone who is not the admin, in their own language, without reading any data', async () => {
    const spy = mock(() => repo.iterateSince(0));
    const guarded = { iterateSince: spy };
    const english = makeCtx({ telegram_id: 7, language: 'en' });
    const russian = makeCtx({ telegram_id: 7, language: 'ru' });

    await handleAiStats(asContext(english), guarded, ADMIN_ID);
    await handleAiStats(asContext(russian), guarded, ADMIN_ID);

    expect(sent(english)).toEqual(['Admin only.']);
    expect(sent(russian)).toEqual(['Только для админа.']);
    expect(spy).not.toHaveBeenCalled();
  });

  test('fails closed when no admin is configured, even for a caller whose id would match', async () => {
    const ctx = makeCtx({ telegram_id: 0 });

    await handleAiStats(asContext(ctx), repo, undefined);

    expect(sent(ctx)).toEqual(['Admin only.']);
  });

  test('sends nothing when the caller is unknown', async () => {
    const ctx = makeCtx({ noUser: true });

    await handleAiStats(asContext(ctx), repo, ADMIN_ID);

    expect(ctx.send).not.toHaveBeenCalled();
  });

  test('answers the admin with the report as an HTML monospace block, a week by default', async () => {
    repo.insertMany([event(), event()]);
    const ctx = makeCtx();

    await handleAiStats(asContext(ctx), repo, ADMIN_ID);

    const [text] = sent(ctx);
    expect(text).toStartWith('<pre>');
    expect(text).toEndWith('</pre>');
    expect(text).toContain('AI usage, last 7 d · attempts: 2');
    expect(text).toContain('claude: no traffic in window');
    expect(ctx.send.mock.calls[0]?.[1]).toEqual({ parse_mode: 'HTML' });
  });

  test('answers in Russian for a Russian admin', async () => {
    const ctx = makeCtx({ language: 'ru' });

    await handleAiStats(asContext(ctx), repo, ADMIN_ID);

    expect(sent(ctx)[0]).toContain('claude: за период запросов нет');
  });

  test('honours the days argument, so older rows drop out of the window', async () => {
    repo.insertMany([event({ at: Date.now() - 10 * DAY_MS }), event()]);
    const week = makeCtx();
    const month = makeCtx({ args: ' 30 ' });

    await handleAiStats(asContext(week), repo, ADMIN_ID);
    await handleAiStats(asContext(month), repo, ADMIN_ID);

    expect(sent(week)[0]).toContain('last 7 d · attempts: 1');
    expect(sent(month)[0]).toContain('last 30 d · attempts: 2');
  });

  test.each(['0', '181', 'abc', '-1', '2.5'])('refuses days %s with the usage line and reads nothing', async (args) => {
    const spy = mock(() => repo.iterateSince(0));
    const ctx = makeCtx({ args });

    await handleAiStats(asContext(ctx), { iterateSince: spy }, ADMIN_ID);

    expect(sent(ctx)).toEqual(['Usage: /ai_stats [days, 1–180]']);
    expect(spy).not.toHaveBeenCalled();
  });

  test('escapes provider and model names so the HTML message cannot be broken', async () => {
    repo.insertMany([event({ provider: 'p<b>', model: 'm&n' })]);
    const ctx = makeCtx();

    await handleAiStats(asContext(ctx), repo, ADMIN_ID);

    expect(sent(ctx)[0]).toContain('p&lt;b&gt;:m&amp;n');
    expect(sent(ctx)[0]).not.toContain('p<b>');
  });

  test('a long report is split into messages that each fit Telegram, every part a closed <pre> block', async () => {
    repo.insertMany(Array.from({ length: 60 }, (_, index) => event({ model: `model-${index}-${'x'.repeat(40)}` })));
    const ctx = makeCtx();

    await handleAiStats(asContext(ctx), repo, ADMIN_ID);

    const parts = sent(ctx);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(4096);
      expect(part.split('<pre>').length).toBe(part.split('</pre>').length);
    }
    expect(parts.join('')).toContain('model-59-');
  });

  test('a database that cannot be read is raised to the command error handling, not swallowed', async () => {
    const broken = {
      iterateSince: () => {
        throw new Error('no such table: ai_usage_events');
      },
    };
    const ctx = makeCtx();

    await expect(handleAiStats(asContext(ctx), broken, ADMIN_ID)).rejects.toThrow('no such table');
  });
});
