/** Limits apply to an authored workflow, never to a whole seed catalogue. */
export const WORKFLOW_LIMITS = {
  depth: 12,
  nodes: 4096,
  stringChars: 32768,
  totalChars: 131072,
  steps: 64,
  translationDepth: 16,
  resolutionSteps: 8192,
} as const;
export type WorkflowInputValue =
  | string
  | number
  | boolean
  | null
  | WorkflowInputValue[]
  | { [key: string]: WorkflowInputValue };
export const FORBIDDEN_WORKFLOW_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

interface PendingJson {
  value: unknown;
  depth: number;
  /** Marks the end of a container's children: the container leaves the cycle-detection path. */
  leave?: boolean;
}

/** Running totals of one `isBoundedJson` traversal. */
interface JsonBudget {
  nodes: number;
  chars: number;
}

/** Primitives are judged here; anything that may be a container is handed on. */
function checkScalar(v: unknown, budget: JsonBudget): 'ok' | 'reject' | 'container' {
  if (v === null || typeof v === 'boolean') return 'ok';
  if (typeof v === 'number') return Number.isFinite(v) ? 'ok' : 'reject';
  if (typeof v === 'string') {
    budget.chars += v.length;
    return v.length > WORKFLOW_LIMITS.stringChars || budget.chars > WORKFLOW_LIMITS.totalChars ? 'reject' : 'ok';
  }
  return typeof v === 'object' ? 'container' : 'reject';
}

/** Only plain arrays and plain (or null-prototype) objects: no class instances or exotic prototypes. */
function hasStandardPrototype(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return Array.isArray(v) ? proto === Array.prototype : proto === Object.prototype || proto === null;
}

/**
 * Sparse arrays have few keys but may force an unbounded recursive parser loop.
 * JSON arrays are dense and cannot carry named properties.
 */
function isDenseArrayShape(v: unknown[], keys: (string | symbol)[], nodes: number): boolean {
  const length: unknown = Object.getOwnPropertyDescriptor(v, 'length')?.value;
  if (
    typeof length !== 'number' ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > WORKFLOW_LIMITS.nodes - nodes
  )
    return false;
  if (keys.length !== length + 1) return false;
  return keys.every(
    (key) => key === 'length' || (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < length),
  );
}

/** Queue every own value of a container; accessors, hidden and forbidden keys are rejected. */
function enqueueChildren(
  v: object,
  keys: (string | symbol)[],
  depth: number,
  pending: PendingJson[],
  budget: JsonBudget,
): boolean {
  for (const key of keys) {
    if (Array.isArray(v) && key === 'length') continue;
    if (typeof key !== 'string' || FORBIDDEN_WORKFLOW_KEYS.has(key)) return false;
    budget.chars += key.length;
    if (budget.chars > WORKFLOW_LIMITS.totalChars) return false;
    const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
    if (!('value' in descriptor) || !descriptor.enumerable) return false;
    pending.push({ value: descriptor.value, depth: depth + 1 });
  }
  return true;
}

function enterContainer(
  v: object,
  depth: number,
  path: WeakSet<object>,
  pending: PendingJson[],
  budget: JsonBudget,
): boolean {
  if (!hasStandardPrototype(v)) return false;
  if (path.has(v)) return false;
  const keys = Reflect.ownKeys(v);
  if (Array.isArray(v) && !isDenseArrayShape(v, keys, budget.nodes)) return false;
  if (keys.length > WORKFLOW_LIMITS.nodes - budget.nodes) return false;
  path.add(v);
  pending.push({ value: v, depth, leave: true });
  return enqueueChildren(v, keys, depth, pending, budget);
}

/** Validate before recursive parsing: no getters, cycles or unbounded traversal. */
export function isBoundedJson(value: unknown): boolean {
  const path = new WeakSet<object>();
  const pending: PendingJson[] = [{ value, depth: 0 }];
  const budget: JsonBudget = { nodes: 0, chars: 0 };
  while (pending.length) {
    const item = pending.pop()!;
    const v = item.value;
    if (item.leave) {
      path.delete(v as object);
      continue;
    }
    if (++budget.nodes > WORKFLOW_LIMITS.nodes || item.depth > WORKFLOW_LIMITS.depth) return false;
    const scalar = checkScalar(v, budget);
    if (scalar === 'reject') return false;
    if (scalar === 'ok') continue;
    if (!enterContainer(v as object, item.depth, path, pending, budget)) return false;
  }
  return true;
}

export class WorkflowInputError extends Error {
  constructor(
    readonly code:
      | 'UNRESOLVED_TEMPLATE'
      | 'INVALID_INPUT'
      | 'INVALID_WORKFLOW'
      | 'INVALID_RESUME'
      | 'INTERACTION_UNAVAILABLE',
  ) {
    super(code);
    this.name = 'WorkflowInputError';
  }
}

/** Reading a version must not invoke accessors; v1 remains the default. */
export function readWorkflowVersion(value: unknown): 1 | 2 | 'invalid' {
  if (value === null || typeof value !== 'object') return 'invalid';
  const field = Object.getOwnPropertyDescriptor(value, 'version');
  if (field && !('value' in field)) return 'invalid';
  if (field?.value === undefined || field.value === 1) return 1;
  return field.value === 2 ? 2 : 'invalid';
}
