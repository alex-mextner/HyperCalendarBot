// test/services/invite/conflict-service.test.ts
import { describe, expect, test } from 'bun:test';
import { ConflictService } from '../../../src/services/invite/conflict-service.ts';

const EVENT_START = '2026-03-20T10:00:00.000Z';
const EVENT_END = '2026-03-20T11:00:00.000Z';
// Window: 2026-03-20T08:00:00Z to 2026-03-20T13:00:00Z

function makeEventRepo(
  events: Record<number, { id: number; title: string; start_at: string; end_at: string | null }[]>,
) {
  return {
    findVisibleOverlapping: (userId: number, startUtc: string, endUtc: string) => {
      return (events[userId] ?? []).filter((e) => {
        const eStart = e.start_at;
        const eEnd = e.end_at ?? new Date(new Date(e.start_at).getTime() + 30 * 60 * 1000).toISOString();
        return eStart < endUtc && eEnd > startUtc;
      });
    },
    isParticipant: (_eventId: number, _userId: number) => false,
  };
}

function makeUserRepo(
  users: Record<number, { telegram_id: number; username: string | null; first_name: string | null }>,
) {
  return {
    findByTelegramId: (id: number) => users[id] ?? null,
  };
}

describe('ConflictService.checkConflicts', () => {
  test('returns no conflicts when invitees are free', () => {
    const eventRepo = makeEventRepo({ 200: [] });
    const userRepo = makeUserRepo({
      200: { telegram_id: 200, username: 'bob', first_name: 'Bob' },
    });
    const svc = new ConflictService(eventRepo as never, userRepo as never);
    const results = svc.checkConflicts(100, [200], EVENT_START, EVENT_END, 'UTC');
    expect(results).toHaveLength(1);
    expect(results[0]!.hasConflict).toBe(false);
    expect(results[0]!.conflictingEvents).toHaveLength(0);
  });

  test('detects conflict when invitee has overlapping event', () => {
    const eventRepo = makeEventRepo({
      200: [{ id: 10, title: 'Standing', start_at: '2026-03-20T09:30:00.000Z', end_at: '2026-03-20T10:30:00.000Z' }],
    });
    const userRepo = makeUserRepo({
      200: { telegram_id: 200, username: 'bob', first_name: 'Bob' },
    });
    const svc = new ConflictService(eventRepo as never, userRepo as never);
    const results = svc.checkConflicts(100, [200], EVENT_START, EVENT_END, 'UTC');
    expect(results[0]!.hasConflict).toBe(true);
    expect(results[0]!.conflictingEvents).toHaveLength(1);
  });

  test('hides invitee event title (privacy)', () => {
    const eventRepo = makeEventRepo({
      200: [
        { id: 10, title: 'Secret Meeting', start_at: '2026-03-20T09:30:00.000Z', end_at: '2026-03-20T10:30:00.000Z' },
      ],
    });
    const userRepo = makeUserRepo({
      200: { telegram_id: 200, username: 'bob', first_name: 'Bob' },
    });
    const svc = new ConflictService(eventRepo as never, userRepo as never);
    const results = svc.checkConflicts(100, [200], EVENT_START, EVENT_END, 'UTC');
    expect(results[0]!.conflictingEvents[0]!.title).toBeNull();
  });

  test('shows title when organizer is participant of conflicting event', () => {
    const eventRepo = {
      findVisibleOverlapping: () => [
        { id: 10, title: 'Shared', start_at: '2026-03-20T09:30:00.000Z', end_at: '2026-03-20T10:30:00.000Z' },
      ],
      isParticipant: (eventId: number, userId: number) => eventId === 10 && userId === 100,
    };
    const userRepo = makeUserRepo({
      200: { telegram_id: 200, username: 'bob', first_name: 'Bob' },
    });
    const svc = new ConflictService(eventRepo as never, userRepo as never);
    const results = svc.checkConflicts(100, [200], EVENT_START, EVENT_END, 'UTC');
    expect(results[0]!.conflictingEvents[0]!.title).toBe('Shared');
  });

  test('includes username in result', () => {
    const eventRepo = makeEventRepo({ 200: [] });
    const userRepo = makeUserRepo({
      200: { telegram_id: 200, username: 'bob', first_name: 'Bob' },
    });
    const svc = new ConflictService(eventRepo as never, userRepo as never);
    const results = svc.checkConflicts(100, [200], EVENT_START, EVENT_END, 'UTC');
    expect(results[0]!.username).toBe('bob');
    expect(results[0]!.userId).toBe(200);
  });

  test('handles multiple invitees independently', () => {
    const eventRepo = makeEventRepo({
      200: [],
      201: [{ id: 20, title: 'Busy', start_at: '2026-03-20T10:00:00.000Z', end_at: '2026-03-20T10:30:00.000Z' }],
    });
    const userRepo = makeUserRepo({
      200: { telegram_id: 200, username: 'alice', first_name: 'Alice' },
      201: { telegram_id: 201, username: 'charlie', first_name: 'Charlie' },
    });
    const svc = new ConflictService(eventRepo as never, userRepo as never);
    const results = svc.checkConflicts(100, [200, 201], EVENT_START, EVENT_END, 'UTC');
    expect(results).toHaveLength(2);
    expect(results.find((r) => r.userId === 200)!.hasConflict).toBe(false);
    expect(results.find((r) => r.userId === 201)!.hasConflict).toBe(true);
  });

  test('window spans 2h before to 2h after event start', () => {
    const captured: { startUtc: string; endUtc: string }[] = [];
    const eventRepo = {
      findVisibleOverlapping: (_userId: number, startUtc: string, endUtc: string) => {
        captured.push({ startUtc, endUtc });
        return [];
      },
      isParticipant: () => false,
    };
    const userRepo = makeUserRepo({ 200: { telegram_id: 200, username: 'bob', first_name: 'Bob' } });
    const svc = new ConflictService(eventRepo as never, userRepo as never);
    svc.checkConflicts(100, [200], EVENT_START, EVENT_END, 'UTC');
    // window: EVENT_START - 2h = 08:00, EVENT_END + 2h = 13:00
    expect(captured[0]!.startUtc).toBe('2026-03-20T08:00:00.000Z');
    expect(captured[0]!.endUtc).toBe('2026-03-20T13:00:00.000Z');
  });
});
