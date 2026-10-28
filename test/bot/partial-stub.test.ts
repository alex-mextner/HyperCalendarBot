// Pins the two guarantees of the partial test double: a supplied member must match the real member type
// (parameters and return value; verified by `@ts-expect-error`, which `tsc` fails on when the line stops
// erroring), and a member the test did not supply throws instead of reading as `undefined`.
import { describe, expect, test } from 'bun:test';
import { stub, UnstubbedMemberError } from './partial-stub.ts';

interface Account {
  id: number;
  name: string;
  nickname?: string;
}

interface AccountRepo {
  find(id: number): Account | null;
  rename(id: number, name: string): Promise<Account>;
  count(): number;
  readonly label: string;
}

describe('stub: supplied members are typechecked against the real type', () => {
  test('accepts members that match the real signatures, returns included', () => {
    const repo = stub<AccountRepo>({
      find: (id) => ({ id, name: 'Ann' }),
      rename: (id, name) => Promise.resolve({ id, name }),
      label: 'accounts',
    });

    expect(repo.find(7)).toEqual({ id: 7, name: 'Ann' });
    expect(repo.label).toBe('accounts');
  });

  test('rejects a method that takes the wrong parameter type', () => {
    // @ts-expect-error find takes a number id, not a string
    stub<AccountRepo>({ find: (id: string) => ({ id: Number(id), name: 'Ann' }) });
  });

  test('rejects a method that returns the wrong shape', () => {
    // @ts-expect-error find returns an Account or null, not a bare string
    stub<AccountRepo>({ find: () => 'Ann' });
  });

  test('rejects a returned entity that lacks required fields', () => {
    // @ts-expect-error the returned Account has no name
    stub<AccountRepo>({ find: () => ({ id: 1 }) });
  });

  test('rejects an async method that resolves to the wrong shape', () => {
    // @ts-expect-error rename resolves to an Account, not void
    stub<AccountRepo>({ rename: () => Promise.resolve() });
  });

  test('rejects a data member of the wrong type', () => {
    // @ts-expect-error label is a string
    stub<AccountRepo>({ label: 3 });
  });

  test('rejects a member the real type does not have', () => {
    // @ts-expect-error AccountRepo has no remove member
    stub<AccountRepo>({ remove: () => true });
  });
});

describe('stub: unstubbed members fail loudly', () => {
  test('reading a method the test did not stub throws', () => {
    const repo = stub<AccountRepo>({ count: () => 3 });

    expect(repo.count()).toBe(3);
    expect(() => repo.find(1)).toThrow(UnstubbedMemberError);
    expect(() => repo.find(1)).toThrow('"find"');
  });

  test('reading a data member the test did not stub throws', () => {
    const repo = stub<AccountRepo>({ count: () => 3 });

    expect(() => repo.label).toThrow(UnstubbedMemberError);
  });

  test('a member deliberately listed as undefined reads as undefined', () => {
    const account = stub<Account>({ id: 1, name: 'Ann', nickname: undefined });

    expect(account.nickname).toBeUndefined();
  });

  test('membership probes do not throw and reflect what was stubbed', () => {
    const repo = stub<AccountRepo>({ count: () => 3 });

    expect('count' in repo).toBe(true);
    expect('find' in repo).toBe(false);
  });

  test('awaiting a double does not trip over the promise `then` probe', async () => {
    const repo = stub<AccountRepo>({ count: () => 3 });

    expect(await Promise.resolve(repo)).toBe(repo);
  });

  test('serializing a double does not trip over the `toJSON` probe', () => {
    const account = stub<Account>({ id: 1, name: 'Ann' });

    expect(JSON.stringify(account)).toBe('{"id":1,"name":"Ann"}');
  });

  test('members every object inherits stay usable; only domain members are guarded', () => {
    const repo = stub<AccountRepo>({ count: () => 3 });

    expect(typeof repo.toString()).toBe('string');
    expect(Object.hasOwn(repo, 'count')).toBe(true);
    expect(Object.hasOwn(repo, 'find')).toBe(false);
  });
});
