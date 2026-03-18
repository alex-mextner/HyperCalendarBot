type Scope = 'personal' | 'group';

export function resolveScope(input: { scope?: string }, ctx: { isGroup: boolean }): Scope {
  return (input.scope ?? (ctx.isGroup ? 'group' : 'personal')) as Scope;
}
