// Typed partial collaborators for AI tool-handler tests. A test supplies only the members the code
// under test touches; each supplied member is checked against the REAL member type of T (method
// parameters AND return type), and any member the test did not supply throws when it is read, so a
// handler that reaches past what the test arranged fails loudly instead of seeing `undefined`.

/**
 * A member as the test must supply it. Methods are re-declared as function types: a method-syntax
 * member is compared bivariantly by TypeScript (a narrower parameter would still compile), a
 * function-typed one strictly, parameters and return type alike.
 */
type Strict<Member> = Member extends (...args: infer Args) => infer Result ? (...args: Args) => Result : Member;

/** The members of T a test supplies: exactly T's own member types, each one optional. */
export type Supplied<T> = { [K in keyof T]?: Strict<T[K]> };

/**
 * A T backed only by `members`. Reading any own member that was not supplied throws naming `label`
 * (inherited Object.prototype names such as `toString` count as unsupplied too). Symbol reads
 * (inspection, `Symbol.toPrimitive`, `Symbol.iterator`) and the protocol probes `then` (awaiting)
 * and `toJSON` (JSON.stringify) are not members and fall through to the plain object. The single
 * cast lives here: the Proxy is built from a `Supplied<T>` the compiler has already checked, and
 * its get trap guarantees an unsupplied member is never observed as a value of the wrong type.
 */
export function partialOf<T>(label: string, members: Supplied<T> = {}): T {
  const guarded = new Proxy(members, {
    get(target, prop, receiver) {
      // Runtime protocol probes, not members of T: `await` reads `then`, `JSON.stringify` reads `toJSON`.
      const isProtocolProbe = prop === 'then' || prop === 'toJSON';
      if (typeof prop === 'symbol' || isProtocolProbe || Object.hasOwn(target, prop)) {
        return Reflect.get(target, prop, receiver);
      }
      throw new Error(`${label}.${prop} was used but the test did not stub it`);
    },
  });
  return guarded as T;
}
