import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import type { ToolResult } from '../../../src/services/ai/types.ts';
import {
  EventReferenceStore,
  REFERENCE_LIMITS,
  referenceEvidenceFrom,
} from '../../../src/services/intent/event-reference-store.ts';
import type { EventSummary } from '../../../src/services/intent/variable-resolver.ts';

const summary = (id: number): EventSummary => ({
  id,
  title: `E${id}`,
  date: '2026-10-05',
  time: '10:00',
  all_day: false,
});
const scope = { actorId: 1, chatId: 1 };
const NOW = Date.parse('2026-09-19T08:00:00Z');
const all = (id: number) => summary(id);

describe('referenceEvidenceFrom', () => {
  test('uses only structured data of a successful result', () => {
    expect(referenceEvidenceFrom('get_event', { success: true, data: summary(4) })).toEqual({
      kind: 'mentioned',
      tool: 'get_event',
      eventIds: [4],
    });
    expect(referenceEvidenceFrom('create_event', { success: true, data: summary(5) })?.kind).toBe('created');
    expect(referenceEvidenceFrom('search_events', { success: true, data: [summary(1), summary(2)] })).toEqual({
      kind: 'list',
      tool: 'search_events',
      eventIds: [1, 2],
    });
    expect(
      referenceEvidenceFrom('delete_event', { success: true, data: summary(4), effect: { kind: 'event_deleted' } }),
    ).toEqual({ kind: 'deleted', tool: 'delete_event', eventIds: [4] });
  });

  test('a failure, prose output, an empty list or a declined attendance is not evidence', () => {
    const cases: ToolResult[] = [
      { success: false, error: 'Event 9 not found', data: summary(9) },
      { success: true, output: 'id: 9, title: X' },
      { success: true, data: [] },
      { success: true, effect: { kind: 'attendance_declined' }, output: 'declined' },
      { success: true, data: { telegram_id: 5, name: 'x' } },
    ];
    for (const result of cases) expect(referenceEvidenceFrom('get_event', result)).toBeNull();
  });
});

describe('EventReferenceStore', () => {
  const fresh = () => new EventReferenceStore(new Database(':memory:'));

  test('creating the table twice is harmless and keeps rows', () => {
    const db = new Database(':memory:');
    const first = new EventReferenceStore(db);
    first.record(scope, { kind: 'mentioned', tool: 'get_event', eventIds: [3] }, { source: 'ai_tool' }, NOW);
    const second = new EventReferenceStore(db);
    expect(second.resolve(scope, all, { now: NOW }).it).toEqual({ status: 'one', event: summary(3) });
  });

  test('"it" is the newest evidence, "created" the newest creation, and the list keeps its order', () => {
    const store = fresh();
    store.record(scope, { kind: 'created', tool: 'create_event', eventIds: [1] }, { source: 'ai_tool' }, NOW);
    store.record(scope, { kind: 'list', tool: 'get_events', eventIds: [7, 6] }, { source: 'intent' }, NOW + 1);
    const refs = store.resolve(scope, all, { now: NOW + 2 });
    expect(refs.created).toEqual({ status: 'one', event: summary(1) });
    expect(refs.it).toEqual({ status: 'choices', events: [summary(7), summary(6)] });
    expect(refs.list?.map((event) => event?.id)).toEqual([7, 6]);
  });

  test('the verifier decides: an unreadable event is gone, never passed through', () => {
    const store = fresh();
    store.record(scope, { kind: 'list', tool: 'get_events', eventIds: [7, 6] }, { source: 'intent' }, NOW);
    const refs = store.resolve(scope, (id) => (id === 6 ? summary(6) : null), { now: NOW });
    expect(refs.it).toEqual({ status: 'one', event: summary(6) });
    expect(refs.list).toEqual([null, summary(6)]);
    expect(store.resolve(scope, () => null, { now: NOW }).it).toEqual({ status: 'gone' });
  });

  test('scopes never mix: another actor, chat or topic sees nothing', () => {
    const store = fresh();
    store.record(
      { actorId: 1, chatId: -5, threadId: 3 },
      { kind: 'mentioned', tool: 'get_event', eventIds: [2] },
      { source: 'ai_tool' },
      NOW,
    );
    expect(store.resolve({ actorId: 2, chatId: -5, threadId: 3 }, all, { now: NOW })).toEqual({});
    expect(store.resolve({ actorId: 1, chatId: -6, threadId: 3 }, all, { now: NOW })).toEqual({});
    expect(store.resolve({ actorId: 1, chatId: -5 }, all, { now: NOW })).toEqual({});
    expect(store.resolve({ actorId: 1, chatId: -5, threadId: 3 }, all, { now: NOW }).it?.status).toBe('one');
  });

  test('singular references expire after a day and lists after two hours', () => {
    const store = fresh();
    store.record(scope, { kind: 'mentioned', tool: 'get_event', eventIds: [2] }, { source: 'ai_tool' }, NOW);
    store.record(scope, { kind: 'list', tool: 'get_events', eventIds: [3, 4] }, { source: 'ai_tool' }, NOW);
    const later = store.resolve(scope, all, { now: NOW + REFERENCE_LIMITS.listTtlMs + 1 });
    expect(later.list).toBeUndefined();
    expect(later.it).toEqual({ status: 'one', event: summary(2) });
    expect(store.resolve(scope, all, { now: NOW + REFERENCE_LIMITS.singularTtlMs + 1 })).toEqual({});
  });

  test('a deletion forgets singular references to that event', () => {
    const store = fresh();
    store.record(scope, { kind: 'created', tool: 'create_event', eventIds: [2] }, { source: 'ai_tool' }, NOW);
    store.record(scope, { kind: 'deleted', tool: 'delete_event', eventIds: [2] }, { source: 'ai_tool' }, NOW + 1);
    expect(store.resolve(scope, all, { now: NOW + 2 })).toEqual({});
  });

  test('rows per scope are capped', () => {
    const store = fresh();
    for (let i = 1; i <= REFERENCE_LIMITS.rowsPerScope + 10; i++)
      store.record(scope, { kind: 'mentioned', tool: 'get_event', eventIds: [i] }, { source: 'ai_tool' }, NOW + i);
    const db = Reflect.get(store, 'db') as Database;
    const count = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM event_references').get()!.n;
    expect(count).toBe(REFERENCE_LIMITS.rowsPerScope);
  });

  test('a reply to a tagged bot message names what it showed; an unknown message is reported, not guessed', () => {
    const store = fresh();
    store.record(scope, { kind: 'mentioned', tool: 'get_event', eventIds: [1] }, { source: 'intent' }, NOW);
    store.tagBotMessage(scope, 900, NOW);
    store.record(scope, { kind: 'mentioned', tool: 'get_event', eventIds: [2] }, { source: 'ai_tool' }, NOW + 5);
    expect(store.resolve(scope, all, { now: NOW + 6, replyToMessageId: 900 }).it).toEqual({
      status: 'one',
      event: summary(1),
    });
    const unknown = store.resolve(scope, all, { now: NOW + 6, replyToMessageId: 901 });
    expect(unknown.replyUnmapped).toBe(true);
    expect(unknown.it).toBeUndefined();
  });
});
