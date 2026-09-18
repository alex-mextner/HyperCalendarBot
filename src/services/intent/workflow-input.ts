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

/** Validate before recursive parsing: no getters, cycles or unbounded traversal. */
export function isBoundedJson(value: unknown): boolean {
  const path = new WeakSet<object>();
  const pending: { value: unknown; depth: number; leave?: boolean }[] = [{ value, depth: 0 }];
  let nodes = 0;
  let chars = 0;
  while (pending.length) {
    const item = pending.pop()!;
    const v = item.value;
    if (item.leave) {
      path.delete(v as object);
      continue;
    }
    if (++nodes > WORKFLOW_LIMITS.nodes || item.depth > WORKFLOW_LIMITS.depth) return false;
    if (v === null || typeof v === 'boolean') continue;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return false;
      continue;
    }
    if (typeof v === 'string') {
      chars += v.length;
      if (v.length > WORKFLOW_LIMITS.stringChars || chars > WORKFLOW_LIMITS.totalChars) return false;
      continue;
    }
    if (typeof v !== 'object') return false;
    const proto = Object.getPrototypeOf(v);
    if (Array.isArray(v) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return false;
    if (path.has(v)) return false;
    const keys = Reflect.ownKeys(v);
    if (Array.isArray(v)) {
      // Sparse arrays have few keys but may force an unbounded recursive parser loop.
      // JSON arrays are dense and cannot carry named properties.
      const length = Object.getOwnPropertyDescriptor(v, 'length')?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > WORKFLOW_LIMITS.nodes - nodes) return false;
      if (keys.length !== length + 1) return false;
      for (const key of keys) {
        if (key === 'length') continue;
        if (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) return false;
      }
    }
    if (keys.length > WORKFLOW_LIMITS.nodes - nodes) return false;
    path.add(v);
    pending.push({ value: v, depth: item.depth, leave: true });
    for (const key of keys) {
      if (Array.isArray(v) && key === 'length') continue;
      if (typeof key !== 'string' || FORBIDDEN_WORKFLOW_KEYS.has(key)) return false;
      chars += key.length;
      if (chars > WORKFLOW_LIMITS.totalChars) return false;
      const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
      if (!('value' in descriptor) || !descriptor.enumerable) return false;
      pending.push({ value: descriptor.value, depth: item.depth + 1 });
    }
  }
  return true;
}

export class WorkflowInputError extends Error {
  constructor(readonly code: 'UNRESOLVED_TEMPLATE' | 'INVALID_INPUT' | 'INVALID_WORKFLOW' | 'INVALID_RESUME') {
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
