import { beforeEach, describe, expect, test } from 'bun:test';
import { ScenePauseService, type ScenePauseState } from '../../src/services/scene-pause.ts';

function makeStorage() {
  const store = new Map<string, unknown>();
  return {
    async get(key: string): Promise<unknown> {
      return store.get(key) ?? null;
    },
    async set(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<boolean | undefined> {
      store.delete(key);
      return undefined;
    },
    _store: store,
  };
}

describe('ScenePauseService', () => {
  let storage: ReturnType<typeof makeStorage>;
  let service: ScenePauseService;

  beforeEach(() => {
    storage = makeStorage();
    service = new ScenePauseService(storage);
  });

  test('save → get returns the saved state', async () => {
    const state: ScenePauseState = {
      sceneName: 'add-event',
      step: 2,
      sceneState: { title: 'Team meeting', date: '2026-03-20' },
    };

    await service.save(123, state);
    const result = await service.get(123);

    expect(result).toEqual(state);
  });

  test('clear → get returns null', async () => {
    const state: ScenePauseState = {
      sceneName: 'edit-value',
      step: 1,
      sceneState: {},
    };

    await service.save(456, state);
    await service.clear(456);
    const result = await service.get(456);

    expect(result).toBeNull();
  });

  test('malformed JSON in storage → get returns null', async () => {
    await storage.set('scene-pause:789', 'not valid json {{{');
    const result = await service.get(789);

    expect(result).toBeNull();
  });

  test('different userIds are independent', async () => {
    const stateA: ScenePauseState = {
      sceneName: 'add-event',
      step: 1,
      sceneState: { a: 1 },
    };
    const stateB: ScenePauseState = {
      sceneName: 'timezone',
      step: 0,
      sceneState: { b: 2 },
    };

    await service.save(1001, stateA);
    await service.save(1002, stateB);

    const resultA = await service.get(1001);
    const resultB = await service.get(1002);

    expect(resultA).toEqual(stateA);
    expect(resultB).toEqual(stateB);

    await service.clear(1001);
    expect(await service.get(1001)).toBeNull();
    expect(await service.get(1002)).toEqual(stateB);
  });
});
