// src/services/operations/registry.ts
//
// Shared operation registry (GH-652, §21/§27 of docs/superpowers/specs/2026-09-28-unified-
// calendar-dialogue-design.md in PR562). One declarative field/permission contract per
// operation, read by every entry point that can produce that operation instead of each
// entry point inventing its own description:
//   - src/bot/commands/add.ts (the /add command's full-field parser, GH-652)
//   - src/services/ai/tools.ts (the create_event AI tool schema — kept in exact sync via
//     `operationToToolInputSchema`, see that file for the wiring)
//   - the local natural-text "operation starter" (src/services/dialogue/*, GH-652)
//
// Per the 2026-09-28T17:22Z owner review on GH-554 (issuecomment-5875070277), this registry
// is created in THIS slice (GH-652), not deferred to the final rollout slice (GH-658) — every
// earlier slice reads from here rather than inventing its own operation shape.
//
// Scope: this module only knows about field NAMES, their required/optional-ness, and a kind
// tag used by the dialogue runtime to pick a parser/question for that field. It does not
// itself parse or validate field VALUES — value-level parsing lives in
// src/services/dialogue/full-field-parser.ts (deterministic text extraction) and
// src/services/calendar/wall-time-adapters.ts (the time-of-day axis, GH-650).

/**
 * What kind of value a field holds. The dialogue runtime uses this to decide which parser
 * and which clarifying question apply — it is not a value validator itself.
 */
export type OperationFieldKind = 'title' | 'schedule' | 'people' | 'place' | 'description' | 'recurrence';

export interface OperationFieldSpec {
  readonly kind: OperationFieldKind;
  /** A hard-required field blocks execution until resolved; ask/require it. */
  readonly required: boolean;
  /**
   * A field that, once the user explicitly supplies it, is an obligation to resolve or ask
   * about — never silently dropped because the schema also marks it `required: false`
   * (design §21, 2026-09-28T17:22Z owner review). This is a distinct axis from `required`:
   * `people`/`place`/`description` are never hard-required, but an EXPLICITLY supplied value
   * for any of them still must not be dropped just because the field itself is optional.
   */
  readonly explicitIsObligation: boolean;
}

export type OperationScope = 'personal' | 'group';

export interface OperationPermission {
  /** Scopes this operation can run under; the caller still supplies the actual scope/groupId. */
  readonly scopes: readonly OperationScope[];
}

export interface OperationDefinition {
  readonly name: string;
  readonly fields: Readonly<Record<string, OperationFieldSpec>>;
  readonly permission: OperationPermission;
}

const registry = new Map<string, OperationDefinition>();

/** Registers an operation once; re-registering the same name is a programming error, not silently ignored. */
export function registerOperation(definition: OperationDefinition): void {
  if (registry.has(definition.name)) {
    throw new Error(`Operation "${definition.name}" is already registered`);
  }
  registry.set(definition.name, definition);
}

export function getOperation(name: string): OperationDefinition | undefined {
  return registry.get(name);
}

export function listOperations(): readonly OperationDefinition[] {
  return [...registry.values()];
}

/** Every hard-required field name for an operation, in declaration order. */
export function requiredFields(definition: OperationDefinition): readonly string[] {
  return Object.entries(definition.fields)
    .filter(([, spec]) => spec.required)
    .map(([name]) => name);
}

export const EVENT_CREATE_FIELDS: Readonly<Record<string, OperationFieldSpec>> = {
  title: { kind: 'title', required: true, explicitIsObligation: true },
  schedule: { kind: 'schedule', required: true, explicitIsObligation: true },
  // Never hard-required — people can be the last step, added via a visible "Add people"
  // action rather than pinned immediately after time (design §6/§9/§23, corpus family
  // people-order). An explicitly supplied name is still an obligation to resolve or ask.
  people: { kind: 'people', required: false, explicitIsObligation: true },
  place: { kind: 'place', required: false, explicitIsObligation: true },
  description: { kind: 'description', required: false, explicitIsObligation: true },
  // Full RRULE semantics (BYHOUR/EXDATE/RDATE expansion, rollback capability-gating) are
  // GH-657's scope; this registry only carries the field's existence/obligation contract, a
  // raw RRULE string is accepted and passed through unexamined by this slice.
  recurrence: { kind: 'recurrence', required: false, explicitIsObligation: true },
};

export const EVENT_CREATE_OPERATION: OperationDefinition = {
  name: 'event.create',
  fields: EVENT_CREATE_FIELDS,
  permission: { scopes: ['personal', 'group'] },
};

registerOperation(EVENT_CREATE_OPERATION);
