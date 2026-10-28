import { describe, expect, test } from 'bun:test';
import {
  createShutdown,
  createShutdownWithTimeout,
  LATE_AGENT_DRAIN_SETTLE_MS,
  type ShutdownDeps,
} from '../../src/bootstrap/shutdown.ts';
import { AGENT_DRAIN_SETTLE_MS } from '../../src/services/ai/agent.ts';

/** Every shutdown collaborator appends its name to one list, so the test reads the real close order. */
function harness(overrides: Partial<ShutdownDeps> = {}) {
  const events: string[] = [];
  const exits: number[] = [];
  const fatals: string[] = [];
  const closable = (name: string) => ({
    close: async () => {
      events.push(name);
    },
  });

  const webServerDeps: { telegramUpdatesClosed?: boolean } = {};
  const deps: ShutdownDeps = {
    bot: {
      stop: async () => {
        events.push(`bot.stop(updatesClosed=${webServerDeps.telegramUpdatesClosed ?? false})`);
      },
    },
    agent: {
      drain: async (settleMs) => {
        events.push(`agent.drain(${settleMs})`);
      },
    },
    resources: {
      aiMessagesQueue: closable('aiMessages'),
      eventCheckerQueue: closable('eventChecker'),
      notificationQueue: closable('notification'),
      botTasksQueue: closable('botTasks'),
      syncQueue: closable('sync'),
      imageQueue: closable('image'),
      broadcastQueue: closable('broadcast'),
      callQueue: closable('call'),
      voiceAgent: {
        drain: async (settleMs) => {
          events.push(`voiceAgent.drain(${settleMs})`);
        },
      },
      googleRedisClient: { close: () => events.push('googleRedis') },
    },
    summarizerRedis: { close: () => events.push('summarizerRedis') },
    webServerHandle: { stop: () => events.push('webServer') },
    webServerDeps,
    database: { close: () => events.push('db') },
    flushAiUsageRecording: () => events.push('flushAiUsage'),
    timeoutMs: 50,
    logger: { fatal: (_obj: unknown, message: string) => fatals.push(message) },
    exit: (code) => exits.push(code),
    ...overrides,
  };
  return { deps, events, exits, fatals, webServerDeps };
}

describe('createShutdown', () => {
  test('closes everything in the documented order', async () => {
    const { deps, events } = harness();

    await createShutdown(deps)();

    expect(events).toEqual([
      'bot.stop(updatesClosed=false)',
      `agent.drain(${AGENT_DRAIN_SETTLE_MS})`,
      `voiceAgent.drain(${AGENT_DRAIN_SETTLE_MS})`,
      'aiMessages',
      'eventChecker',
      'notification',
      'botTasks',
      'sync',
      'image',
      'broadcast',
      'call',
      `agent.drain(${LATE_AGENT_DRAIN_SETTLE_MS})`,
      `voiceAgent.drain(${LATE_AGENT_DRAIN_SETTLE_MS})`,
      'googleRedis',
      'summarizerRedis',
      'webServer',
      'flushAiUsage',
      'db',
    ]);
  });

  test('skips the resources that no phase created', async () => {
    const { deps, events } = harness({
      resources: {},
      webServerHandle: undefined,
    });

    await createShutdown(deps)();

    expect(events).toEqual([
      'bot.stop(updatesClosed=false)',
      `agent.drain(${AGENT_DRAIN_SETTLE_MS})`,
      `agent.drain(${LATE_AGENT_DRAIN_SETTLE_MS})`,
      'summarizerRedis',
      'flushAiUsage',
      'db',
    ]);
  });
});

describe('createShutdownWithTimeout', () => {
  test('refuses webhook updates before anything stops, then exits cleanly without forcing', async () => {
    const { deps, events, exits, webServerDeps } = harness();

    await createShutdownWithTimeout(deps)();

    expect(webServerDeps.telegramUpdatesClosed).toBe(true);
    expect(events[0]).toBe('bot.stop(updatesClosed=true)');
    expect(events.at(-1)).toBe('db');
    expect(exits).toEqual([]);
  });

  test('a shutdown that outlives the deadline logs fatal and forces exit 1', async () => {
    const { deps, exits, fatals } = harness({
      bot: { stop: () => Promise.withResolvers<void>().promise },
    });

    await createShutdownWithTimeout(deps)();

    expect(fatals).toEqual(['Shutdown timed out, forcing exit']);
    expect(exits).toEqual([1]);
  });

  test('a close that throws is also fatal', async () => {
    const { deps, exits, fatals } = harness({
      database: {
        close: () => {
          throw new Error('locked');
        },
      },
    });

    await createShutdownWithTimeout(deps)();

    expect(fatals).toEqual(['Shutdown timed out, forcing exit']);
    expect(exits).toEqual([1]);
  });
});
