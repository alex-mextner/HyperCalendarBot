// test/services/ai/tool-handlers/scenes.test.ts
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { handleCancelScene, handleResumeScene } from '../../../../src/services/ai/tool-handlers/scenes.ts';
import type { AgentContext } from '../../../../src/services/ai/types.ts';
import { ScenePauseService, type ScenePauseState } from '../../../../src/services/scene-pause.ts';

function makeStorage() {
  const store = new Map<string, unknown>();
  return {
    async get(key: string): Promise<unknown> {
      return store.get(key) ?? null;
    },
    async set(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
  };
}

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    user: { telegram_id: 42, language: 'en' } as AgentContext['user'],
    chatId: 42,
    messageText: '',
    isGroup: false,
    eventService: {} as never,
    holidayService: {} as never,
    chatHistory: {} as never,
    conversationLogger: {} as never,
    userRepo: {} as never,
    reminderRepo: {} as never,
    ...overrides,
  };
}

describe('handleResumeScene', () => {
  let storage: ReturnType<typeof makeStorage>;
  let service: ScenePauseService;
  let ctx: AgentContext;

  beforeEach(async () => {
    storage = makeStorage();
    service = new ScenePauseService(storage);
    const state: ScenePauseState = { sceneName: 'add_event', step: 1, sceneState: {} };
    await service.save(42, state);
    ctx = makeCtx({ scene: { scenePauseState: undefined, scenePauseService: service } });
  });

  test('clears the pause state', async () => {
    await handleResumeScene(ctx, service);
    expect(await service.get(42)).toBeNull();
  });

  test('returns success with english output for en user', async () => {
    const result = await handleResumeScene(ctx, service);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Continue');
  });

  test('returns success with russian output for ru user', async () => {
    const ruCtx = makeCtx({
      user: { telegram_id: 42, language: 'ru' } as AgentContext['user'],
      scene: { scenePauseState: undefined, scenePauseService: service },
    });
    const result = await handleResumeScene(ruCtx, service);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Продолжай');
  });
});

describe('handleCancelScene', () => {
  let storage: ReturnType<typeof makeStorage>;
  let service: ScenePauseService;
  let ctx: AgentContext;

  beforeEach(async () => {
    storage = makeStorage();
    service = new ScenePauseService(storage);
    const state: ScenePauseState = { sceneName: 'add_event', step: 1, sceneState: {} };
    await service.save(42, state);
    ctx = makeCtx({ scene: { scenePauseState: undefined, scenePauseService: service } });
  });

  test('clears the pause state', async () => {
    await handleCancelScene(ctx, service);
    expect(await service.get(42)).toBeNull();
  });

  test('deletes scene storage key when sceneStorage is provided', async () => {
    const sceneStore = new Map<string, string>();
    sceneStore.set('@gramio/scenes:42', '{"name":"add_event","step":1}');
    const sceneStorage = {
      delete: mock(async (key: string) => {
        sceneStore.delete(key);
      }),
    };
    const ctxWithStorage = makeCtx({ scene: { scenePauseState: undefined, scenePauseService: service }, sceneStorage });
    await handleCancelScene(ctxWithStorage, service);
    expect(sceneStorage.delete).toHaveBeenCalledWith('@gramio/scenes:42');
  });

  test('does not throw when sceneStorage is not provided', async () => {
    const result = await handleCancelScene(ctx, service);
    expect(result.success).toBe(true);
  });

  test('returns english output for en user', async () => {
    const result = await handleCancelScene(ctx, service);
    expect(result.output).toContain('cancelled');
  });

  test('returns russian output for ru user', async () => {
    const ruCtx = makeCtx({
      user: { telegram_id: 42, language: 'ru' } as AgentContext['user'],
      scene: { scenePauseState: undefined, scenePauseService: service },
    });
    const result = await handleCancelScene(ruCtx, service);
    expect(result.output).toContain('отменён');
  });
});
