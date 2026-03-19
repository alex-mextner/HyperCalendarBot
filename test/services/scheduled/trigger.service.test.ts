import { Database } from 'bun:sqlite';
import { describe, expect, mock, test } from 'bun:test';
import { migrations } from '../../../src/database/migrations.ts';
import { runMigrations } from '../../../src/database/schema.ts';
import { DomainEventBus } from '../../../src/services/scheduled/domain-event-bus.ts';
import { TriggerRepository } from '../../../src/services/scheduled/trigger.repository.ts';
import { TriggerService } from '../../../src/services/scheduled/trigger.service.ts';

function makeSetup() {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  const bus = new DomainEventBus();
  const repo = new TriggerRepository(db);
  const push = mock(async () => {});
  const service = new TriggerService(bus, repo, push);
  service.subscribe();
  return { bus, repo, push };
}

describe('TriggerService', () => {
  test('fires action when topic matches and no condition', async () => {
    const { bus, repo, push } = makeSetup();
    repo.create({
      userId: 1,
      topic: 'myCalendar.newEvent',
      action: 'call me',
      label: null,
      condition: null,
      once: false,
    });
    bus.emit('myCalendar.newEvent', { userId: 1, newEvent: { id: 1, title: 'X' } as never });
    await Promise.resolve();
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(expect.objectContaining({ userId: 1, message: 'call me', source: 'trigger' }));
  });

  test('does not fire when condition is false', async () => {
    const { bus, repo, push } = makeSetup();
    repo.create({
      userId: 1,
      topic: 'myCalendar.newEvent',
      action: 'x',
      label: null,
      condition: 'newEvent.id == 99',
      once: false,
    });
    bus.emit('myCalendar.newEvent', { userId: 1, newEvent: { id: 1, title: 'X' } as never });
    await Promise.resolve();
    expect(push).not.toHaveBeenCalled();
  });

  test('fires when condition is true', async () => {
    const { bus, repo, push } = makeSetup();
    repo.create({
      userId: 1,
      topic: 'myCalendar.newEvent',
      action: 'x',
      label: null,
      condition: 'newEvent.id == 1',
      once: false,
    });
    bus.emit('myCalendar.newEvent', { userId: 1, newEvent: { id: 1, title: 'X' } as never });
    await Promise.resolve();
    expect(push).toHaveBeenCalledTimes(1);
  });

  test('once trigger is disabled after fire', async () => {
    const { bus, repo, push } = makeSetup();
    repo.create({ userId: 1, topic: 'myCalendar.newEvent', action: 'x', label: null, condition: null, once: true });
    bus.emit('myCalendar.newEvent', { userId: 1, newEvent: { id: 1, title: 'X' } as never });
    await Promise.resolve();
    expect(push).toHaveBeenCalledTimes(1);
    // Second emit should not fire
    bus.emit('myCalendar.newEvent', { userId: 1, newEvent: { id: 2, title: 'Y' } as never });
    await Promise.resolve();
    expect(push).toHaveBeenCalledTimes(1);
    expect(repo.findEnabled(1, 'myCalendar.newEvent')).toHaveLength(0);
  });

  test('skips trigger with invalid condition (fail-closed)', async () => {
    const { bus, repo, push } = makeSetup();
    repo.create({
      userId: 1,
      topic: 'myCalendar.newEvent',
      action: 'x',
      label: null,
      condition: '!!! invalid !!!',
      once: false,
    });
    bus.emit('myCalendar.newEvent', { userId: 1, newEvent: { id: 1, title: 'X' } as never });
    await Promise.resolve();
    expect(push).not.toHaveBeenCalled();
  });

  test('once trigger stays disabled if push throws', async () => {
    const db = new Database(':memory:');
    runMigrations(db, migrations);
    const bus = new DomainEventBus();
    const repo = new TriggerRepository(db);
    const pushFail = mock(async () => {
      throw new Error('Redis down');
    });
    const service = new TriggerService(bus, repo, pushFail);
    service.subscribe();
    repo.create({ userId: 1, topic: 'myCalendar.newEvent', action: 'x', label: null, condition: null, once: true });
    bus.emit('myCalendar.newEvent', { userId: 1, newEvent: { id: 1, title: 'X' } as never });
    await Promise.resolve();
    // Trigger is disabled even though push failed
    expect(repo.findEnabled(1, 'myCalendar.newEvent')).toHaveLength(0);
  });
});
