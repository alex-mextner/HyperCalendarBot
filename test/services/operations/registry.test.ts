// test/services/operations/registry.test.ts
import { describe, expect, test } from 'bun:test';
import {
  EVENT_CREATE_OPERATION,
  getOperation,
  listOperations,
  registerOperation,
  requiredFields,
} from '../../../src/services/operations/registry.ts';

describe('event.create is registered once, read by every caller', () => {
  test('getOperation("event.create") returns the same object every call site reads', () => {
    const a = getOperation('event.create');
    const b = getOperation('event.create');
    expect(a).toBe(EVENT_CREATE_OPERATION);
    expect(b).toBe(EVENT_CREATE_OPERATION);
  });

  test('an unknown operation name returns undefined, not a throw', () => {
    expect(getOperation('event.delete')).toBeUndefined();
  });

  test('listOperations includes event.create', () => {
    expect(listOperations()).toContain(EVENT_CREATE_OPERATION);
  });
});

describe('event.create field contract', () => {
  test('title and schedule are the only hard-required fields', () => {
    expect(requiredFields(EVENT_CREATE_OPERATION)).toEqual(['title', 'schedule']);
  });

  test('people is never hard-required — it can be the last step, not pinned after time', () => {
    expect(EVENT_CREATE_OPERATION.fields.people?.required).toBe(false);
  });

  test('every optional field is still an explicit-is-obligation field', () => {
    for (const name of ['people', 'place', 'description', 'recurrence']) {
      expect(EVENT_CREATE_OPERATION.fields[name]?.explicitIsObligation).toBe(true);
    }
  });

  test('personal and group are both permitted scopes', () => {
    expect(EVENT_CREATE_OPERATION.permission.scopes).toEqual(['personal', 'group']);
  });
});

describe('re-registering the same operation name is a programming error, not silently ignored', () => {
  test('registerOperation throws on a duplicate name', () => {
    expect(() =>
      registerOperation({
        name: 'event.create',
        fields: {},
        permission: { scopes: ['personal'] },
      }),
    ).toThrow('already registered');
  });
});
