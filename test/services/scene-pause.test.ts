import { beforeEach, describe, expect, test } from 'bun:test';
import { pauseStateFromGramioRecord, ScenePauseService, type ScenePauseState } from '../../src/services/scene-pause.ts';

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
      sceneName: 'add_event',
      step: 2,
      sceneState: { title: 'Team meeting', startAt: '2026-03-20T10:00:00Z' },
    };

    await service.save(123, state);
    const result = await service.get(123);

    expect(result).toEqual(state);
  });

  test('clear → get returns null', async () => {
    const state: ScenePauseState = {
      sceneName: 'onboarding',
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
      sceneName: 'add_event',
      step: 1,
      sceneState: { title: 'Meeting' },
    };
    const stateB: ScenePauseState = {
      sceneName: 'timezone',
      step: 0,
      sceneState: { detectedTz: 'Europe/Kyiv' },
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

describe('pauseStateFromGramioRecord', () => {
  test('maps a stored scene record to its pause state, keeping step and state', () => {
    const record = JSON.stringify({ name: 'timezone', step: 2, state: { detectedTz: 'Europe/Berlin' } });

    expect(pauseStateFromGramioRecord(record)).toEqual({
      sceneName: 'timezone',
      step: 2,
      sceneState: { detectedTz: 'Europe/Berlin' },
    });
  });

  test.each(['add_event', 'onboarding', 'edit_value', 'import'] as const)('recognises the %s scene', (name) => {
    expect(pauseStateFromGramioRecord(JSON.stringify({ name, step: 1, state: {} }))).toEqual({
      sceneName: name,
      step: 1,
      sceneState: {},
    });
  });

  test('an unknown scene name becomes add_event but keeps step and state', () => {
    const record = JSON.stringify({ name: 'mystery', step: 3, state: { title: 'Lunch' } });

    expect(pauseStateFromGramioRecord(record)).toEqual({
      sceneName: 'add_event',
      step: 3,
      sceneState: { title: 'Lunch' },
    });
  });

  test('a record without name, step or state gets the defaults', () => {
    expect(pauseStateFromGramioRecord('{}')).toEqual({ sceneName: 'add_event', step: 0, sceneState: {} });
  });

  test('a record that the storage adapter already parsed into an object is read like its JSON form', () => {
    expect(pauseStateFromGramioRecord({ name: 'timezone', step: 1, state: { detectedTz: 'UTC' } })).toEqual({
      sceneName: 'timezone',
      step: 1,
      sceneState: { detectedTz: 'UTC' },
    });
  });

  test.each([
    ['malformed JSON', 'not json'],
    ['a JSON array', '[1,2]'],
    ['a JSON null', 'null'],
    ['a number', 42],
  ])('%s becomes a fresh add_event pause', (_label, record) => {
    expect(pauseStateFromGramioRecord(record)).toEqual({ sceneName: 'add_event', step: 0, sceneState: {} });
  });

  test('fields of the wrong type fall back individually instead of rejecting the record', () => {
    const record = JSON.stringify({ name: 'timezone', step: '2', state: ['not', 'an', 'object'] });

    expect(pauseStateFromGramioRecord(record)).toEqual({ sceneName: 'timezone', step: 0, sceneState: {} });
  });

  test('the converted state round-trips through the pause service', async () => {
    const store = new Map<string, unknown>();
    const service = new ScenePauseService({
      get: async (key) => store.get(key) ?? null,
      set: async (key, value) => {
        store.set(key, value);
      },
      delete: async (key) => store.delete(key),
    });
    const state = pauseStateFromGramioRecord(JSON.stringify({ name: 'add_event', step: 4, state: { title: 'Team' } }));

    await service.save(5, state);

    expect(await service.get(5)).toEqual({ sceneName: 'add_event', step: 4, sceneState: { title: 'Team' } });
  });
});
