import { beforeEach, expect, test } from 'bun:test';
import { GroupSessionManager } from '../../../src/services/group/group-session';

let manager: GroupSessionManager;

beforeEach(() => {
  manager = new GroupSessionManager();
});

test('no session initially', () => {
  expect(manager.hasActiveSession(1)).toBe(false);
  expect(manager.getSession(1)).toBeUndefined();
});

test('activate() creates a session', () => {
  manager.activate(1, 42, 100);

  expect(manager.hasActiveSession(1)).toBe(true);

  const session = manager.getSession(1);
  expect(session).toBeDefined();
  expect(session!.chatId).toBe(1);
  expect(session!.activatedBy).toBe(42);
  expect(session!.remainingMessages).toBe(10);
  expect(session!.lastBotMessageId).toBe(100);
  expect(session!.expiresAt).toBeGreaterThan(Date.now());
});

test('tick() decrements remaining messages', () => {
  manager.activate(1, 42, 100);
  manager.tick(1);

  const session = manager.getSession(1);
  expect(session!.remainingMessages).toBe(9);
});

test('session closes after 10 ticks', () => {
  manager.activate(1, 42, 100);

  for (let i = 0; i < 10; i++) {
    manager.tick(1);
  }

  expect(manager.hasActiveSession(1)).toBe(false);
  expect(manager.getSession(1)).toBeUndefined();
});

test('refresh() resets counter and expiry', () => {
  manager.activate(1, 42, 100);

  for (let i = 0; i < 5; i++) {
    manager.tick(1);
  }

  const beforeRefresh = manager.getSession(1)!;
  expect(beforeRefresh.remainingMessages).toBe(5);

  const oldExpiry = beforeRefresh.expiresAt;
  manager.refresh(1, 200);

  const session = manager.getSession(1);
  expect(session!.remainingMessages).toBe(10);
  expect(session!.lastBotMessageId).toBe(200);
  expect(session!.expiresAt).toBeGreaterThanOrEqual(oldExpiry);
});

test('expired session is not active', () => {
  manager.activate(1, 42, 100);

  // Manually expire the session
  const session = manager.getSession(1)!;
  session.expiresAt = Date.now() - 1;

  expect(manager.hasActiveSession(1)).toBe(false);
});

test('close() removes session', () => {
  manager.activate(1, 42, 100);
  expect(manager.hasActiveSession(1)).toBe(true);

  manager.close(1);
  expect(manager.hasActiveSession(1)).toBe(false);
  expect(manager.getSession(1)).toBeUndefined();
});
