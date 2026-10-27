// Pins the contract of partialOf: supplied members are typechecked against the real signatures
// (parameters and return type) and an unsupplied member throws on access instead of reading undefined.
import { describe, expect, test } from 'bun:test';
import { partialOf } from './partial-stubs.ts';

interface Repo {
  find(id: number): { id: number; name: string } | null;
  count(): number;
  readonly label: string;
}

describe('partialOf: compile-time checks on supplied members', () => {
  test('a supplied method keeps its real parameter and return types', () => {
    const repo = partialOf<Repo>('repo', { find: (id) => (id === 1 ? { id, name: 'one' } : null) });
    expect(repo.find(1)).toEqual({ id: 1, name: 'one' });
    expect(repo.find(2)).toBeNull();
  });

  // The assertions here are the `@ts-expect-error` lines: `tsc --noEmit` fails if any of these
  // stops being a type error. The function is never called, so nothing runs.
  function shapesTheCompilerMustReject(): void {
    // @ts-expect-error find must take a number, not a string
    partialOf<Repo>('repo', { find: (id: string) => ({ id: Number(id), name: 'x' }) });
    // @ts-expect-error find must accept every number, not only the literal 1 (no bivariant narrowing)
    partialOf<Repo>('repo', { find: (id: 1) => (id === 1 ? { id, name: 'one' } : null) });
    // @ts-expect-error find must return a full row or null, not a partial row
    partialOf<Repo>('repo', { find: () => ({ id: 1 }) });
    // @ts-expect-error count must return a number
    partialOf<Repo>('repo', { count: () => 'three' });
    // @ts-expect-error label is a string, not a function
    partialOf<Repo>('repo', { label: () => 'x' });
    // @ts-expect-error unknown members are rejected
    partialOf<Repo>('repo', { missing: () => 1 });
  }

  test('the rejected shapes are declared in shapesTheCompilerMustReject', () => {
    expect(shapesTheCompilerMustReject).toBeInstanceOf(Function);
  });
});

describe('partialOf: unstubbed members fail loudly', () => {
  test('reading an unsupplied method throws and names the collaborator and member', () => {
    const repo = partialOf<Repo>('repo', { count: () => 3 });
    expect(repo.count()).toBe(3);
    expect(() => repo.find(1)).toThrow('repo.find was used but the test did not stub it');
  });

  test('reading an unsupplied value member throws too', () => {
    const repo = partialOf<Repo>('repo', {});
    expect(() => repo.label).toThrow('repo.label was used but the test did not stub it');
  });

  test('inherited Object.prototype names are not supplied members either', () => {
    const repo = partialOf<Repo>('repo', {});
    expect(() => repo.constructor).toThrow('repo.constructor was used but the test did not stub it');
    expect(() => repo.toString()).toThrow('repo.toString was used but the test did not stub it');
  });

  test('a supplied member holding undefined is still the test’s explicit choice', () => {
    const repo = partialOf<{ note?: string }>('opt', { note: undefined });
    expect(repo.note).toBeUndefined();
  });

  test('a stub can be awaited and serialized: then and toJSON are protocol probes, not members', async () => {
    const repo = partialOf<Repo>('repo', { count: () => 3 });
    const awaited = await Promise.resolve(repo);
    expect(awaited.count()).toBe(3);
    expect(JSON.stringify(repo)).toBe('{}');
  });
});
