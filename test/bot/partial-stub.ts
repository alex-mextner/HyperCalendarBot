// Typed partial test doubles for handler tests.
//
// A test supplies only the members the code path under test touches, and the compiler checks every supplied
// member against the REAL member type of the target — parameters and return values included — so a mock whose
// method takes or returns the wrong shape does not compile. (An object literal passed directly also gets
// TypeScript's excess-property check; a variable holding extra members is accepted, but the members that
// do match the target are still checked.) The double is a Proxy that throws on use of any member the test
// did not supply, so a code path that reaches past what the test arranged fails loudly instead of reading
// `undefined`. A member that is intentionally absent must be listed as `member: undefined`.

/** Thrown when code under test touches a member that the test did not stub. */
export class UnstubbedMemberError extends Error {
  constructor(member: string) {
    super(`test double member "${member}" was used but never stubbed; add it to the stub or list it as undefined`);
    this.name = 'UnstubbedMemberError';
  }
}

/**
 * Presents a typechecked partial mock as the full type `T` expected at the call site.
 *
 * `T` is taken from the surrounding position (parameter or annotated variable) and never inferred from the
 * argument, so the argument is checked against the real type rather than defining it. Reading a member that
 * was not supplied throws {@link UnstubbedMemberError}; symbols, `then` and `toJSON` are answered with
 * `undefined` because the runtime itself probes them (promise resolution, inspection, JSON serialization),
 * not the code under test.
 */
export function stub<T>(partial: NoInfer<Partial<NonNullable<T>>>): NonNullable<T> {
  const guarded = new Proxy(partial, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'toJSON') return undefined;
      throw new UnstubbedMemberError(prop);
    },
  });
  // The one cast: `NonNullable<T>` is assignable to `Partial<NonNullable<T>>`, and every member of `partial`
  // was checked against its real type at the call site.
  return guarded as NonNullable<T>;
}
