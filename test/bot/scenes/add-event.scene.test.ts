import { describe, expect, test } from 'bun:test';
import { Composer } from 'gramio';
import { CALLBACK_ONLY_STEPS } from '../../../src/bot/handlers/message.handler.ts';
import type { UserResolverComposer } from '../../../src/bot/middleware/user-resolver.ts';
import { createAddEventScene } from '../../../src/bot/scenes/add-event.scene.ts';
import { CB } from '../../../src/config/constants.ts';
import type { EventService } from '../../../src/services/event/event-service.ts';

const mockComposer = new Composer() as unknown as UserResolverComposer;

describe('createAddEventScene', () => {
  test('creates scene with name "add_event"', () => {
    const mockEventService = {} as unknown as EventService;
    const scene = createAddEventScene(mockEventService, mockComposer);
    expect(scene.name).toBe('add_event');
    expect(scene.stepsCount).toBe(7);
  });
});

describe('add_event recurrence callback data constants', () => {
  test('ADD_RECURRENCE prefix is defined', () => {
    expect(CB.ADD_RECURRENCE).toBeDefined();
    expect(typeof CB.ADD_RECURRENCE).toBe('string');
  });

  test('ADD_REC_END prefix is defined', () => {
    expect(CB.ADD_REC_END).toBeDefined();
    expect(typeof CB.ADD_REC_END).toBe('string');
  });

  test('ADD_RECURRENCE and ADD_REC_END are distinct', () => {
    expect(CB.ADD_RECURRENCE).not.toBe(CB.ADD_REC_END);
  });
});

describe('CALLBACK_ONLY_STEPS — add_event', () => {
  test('step 3 (recurrence selection) is registered as callback-only', () => {
    expect(CALLBACK_ONLY_STEPS.get('add_event')?.has(3)).toBe(true);
  });

  test('step 4 (recurrence end selection) is registered as callback-only', () => {
    expect(CALLBACK_ONLY_STEPS.get('add_event')?.has(4)).toBe(true);
  });

  test('text-input steps (0, 1, 2, 5, 6) are NOT callback-only', () => {
    const steps = CALLBACK_ONLY_STEPS.get('add_event');
    for (const s of [0, 1, 2, 5, 6]) {
      expect(steps?.has(s)).toBe(false);
    }
  });

  test('unknown scene is not registered', () => {
    expect(CALLBACK_ONLY_STEPS.has('unknown_scene')).toBe(false);
  });
});
