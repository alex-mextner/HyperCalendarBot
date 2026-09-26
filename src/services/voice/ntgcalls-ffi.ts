import { dlopen, FFIType, type Library, type Pointer, suffix } from 'bun:ffi';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { voiceLogger } from './types';

/**
 * ntgcalls FFI bindings — skeleton that loads the shared library
 * and exposes init/destroy lifecycle.
 *
 * Struct-by-value parameters (ntg_async_struct, ntg_media_description_struct)
 * are NOT supported by Bun FFI directly. A C shim is required for full
 * integration — see docs/plans/ntgcalls-ffi-research.md section 12.
 *
 * For now, only ntg_init / ntg_destroy / ntg_get_version work (no struct-by-value).
 */

const LIB_SEARCH_PATHS = [
  join(import.meta.dir, '../../../lib', `ntgcalls.${suffix}`),
  join(import.meta.dir, '../../../lib', `libntgcalls.${suffix}`),
];

// Schema extracted as const so Library<typeof FFI_SCHEMA> resolves to the correct symbol types
const FFI_SCHEMA = {
  ntg_init: {
    returns: FFIType.ptr,
    args: [],
  },
  ntg_destroy: {
    returns: FFIType.i32,
    args: [FFIType.ptr],
  },
  ntg_get_version: {
    returns: FFIType.i32,
    args: [FFIType.ptr],
  },
} as const;

type NtgCallsLib = Library<typeof FFI_SCHEMA>;

let cachedLib: NtgCallsLib | null = null;
let loadAttempted = false;
let loadError: string | null = null;

function findLibraryPath(): string | null {
  for (const candidate of LIB_SEARCH_PATHS) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function loadLibrary(): NtgCallsLib {
  if (cachedLib) return cachedLib;

  const libPath = findLibraryPath();
  if (!libPath) {
    throw new Error(
      `ntgcalls shared library not found. Searched: ${LIB_SEARCH_PATHS.join(', ')}. Run: scripts/download-ntgcalls.sh`,
    );
  }

  voiceLogger.info({ path: libPath }, 'Loading ntgcalls shared library');

  cachedLib = dlopen(libPath, FFI_SCHEMA);
  return cachedLib;
}

/**
 * Check whether the ntgcalls shared library is available and loadable.
 * Returns false if the binary is missing or fails to load — never throws.
 */
export function isNtgCallsAvailable(): boolean {
  if (cachedLib) return true;
  if (loadAttempted) return cachedLib !== null;

  loadAttempted = true;
  try {
    loadLibrary();
    return true;
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
    voiceLogger.warn({ error: loadError }, 'ntgcalls library not available');
    return false;
  }
}

/**
 * Returns the load error message, or null if no error occurred.
 */
export function getNtgCallsLoadError(): string | null {
  return loadError;
}

/**
 * Minimal ntgcalls wrapper — lifecycle only.
 *
 * Full call flow (create_p2p, key exchange, stream sources, connect)
 * requires a C shim to handle struct-by-value parameters.
 * That shim is follow-up work (Task 5 note in plan).
 */
// Bun 1.4 types an FFIType.ptr result as Pointer | bigint | null; null is rejected below, and the
// handle is only stored and passed back to ntg_destroy, which accepts either form.
type NtgHandle = Pointer | bigint;

export class NtgCalls {
  private handle: NtgHandle;
  private destroyed = false;

  constructor() {
    const lib = loadLibrary();
    const handle = lib.symbols.ntg_init();
    if (!handle) {
      throw new Error('ntg_init returned null handle');
    }
    this.handle = handle;
    voiceLogger.debug({ handle }, 'ntgcalls instance created');
  }

  /**
   * Release the ntgcalls instance. Must be called to avoid resource leaks.
   * Calling destroy() more than once is a no-op.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    const lib = loadLibrary();
    const result = lib.symbols.ntg_destroy(this.handle);
    voiceLogger.debug({ handle: this.handle, result }, 'ntgcalls instance destroyed');
  }

  /**
   * Returns the raw FFI handle (for passing to future C shim functions).
   */
  getHandle(): NtgHandle {
    if (this.destroyed) {
      throw new Error('NtgCalls instance already destroyed');
    }
    return this.handle;
  }

  /**
   * Whether this instance has been destroyed.
   */
  isDestroyed(): boolean {
    return this.destroyed;
  }
}
