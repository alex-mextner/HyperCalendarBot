import { describe, expect, test } from 'bun:test';
import { createAddEventScene } from '../../../src/bot/scenes/add-event.scene.ts';
import type { EventService } from '../../../src/services/event/event-service.ts';

describe('createAddEventScene', () => {
  test('creates scene with name "add_event"', () => {
    const mockEventService = {} as unknown as EventService;
    const scene = createAddEventScene(mockEventService);
    expect(scene.name).toBe('add_event');
    expect(scene.stepsCount).toBe(3);
  });
});
