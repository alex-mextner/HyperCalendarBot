> Part 2 of 3 of [Voice Call Reminders — Implementation Plan](../2026-03-16-voice-call-reminders.md) — previous: [01-overview-tasks-1-4.md](01-overview-tasks-1-4.md) · next: [03-tasks-7-12.md](03-tasks-7-12.md)

## Chunk 2: ntgcalls FFI Bindings + MTProto Signaling

### Task 5: Download ntgcalls binaries + create FFI bindings

**Files:**

- Create: `src/services/voice/ntgcalls-ffi.ts`
- Create: `test/services/voice/ntgcalls-ffi.test.ts`
- Create: `scripts/download-ntgcalls.sh`

- [ ] **Step 1: Create download script for ntgcalls prebuilt binaries**

```bash
#!/bin/bash
# scripts/download-ntgcalls.sh
# Downloads ntgcalls prebuilt shared library for current platform

set -e

VERSION="v2.1.0"
OUTDIR="lib"
mkdir -p "$OUTDIR"

OS=$(uname -s)
ARCH=$(uname -m)

if [ "$OS" = "Darwin" ] && [ "$ARCH" = "arm64" ]; then
  URL="https://github.com/pytgcalls/ntgcalls/releases/download/${VERSION}/ntgcalls.macos-arm64-shared_libs.zip"
  LIB_NAME="ntgcalls.dylib"
elif [ "$OS" = "Linux" ] && [ "$ARCH" = "x86_64" ]; then
  URL="https://github.com/pytgcalls/ntgcalls/releases/download/${VERSION}/ntgcalls.linux-x86_64-shared_libs.zip"
  LIB_NAME="ntgcalls.so"
elif [ "$OS" = "Linux" ] && [ "$ARCH" = "aarch64" ]; then
  URL="https://github.com/pytgcalls/ntgcalls/releases/download/${VERSION}/ntgcalls.linux-arm64-shared_libs.zip"
  LIB_NAME="ntgcalls.so"
else
  echo "Unsupported platform: $OS/$ARCH"
  exit 1
fi

echo "Downloading ntgcalls $VERSION for $OS/$ARCH..."
curl -L -o /tmp/ntgcalls.zip "$URL"
unzip -o /tmp/ntgcalls.zip -d "$OUTDIR"
rm /tmp/ntgcalls.zip

echo "ntgcalls library ready at $OUTDIR/"
ls -la "$OUTDIR/"
```

- [ ] **Step 2: Download the library**

```bash
chmod +x scripts/download-ntgcalls.sh
./scripts/download-ntgcalls.sh
echo "lib/" >> .gitignore
```

- [ ] **Step 3: Write FFI binding tests**

```typescript
// test/services/voice/ntgcalls-ffi.test.ts
import { describe, expect, test } from 'bun:test';
import { NtgCalls, isNtgCallsAvailable } from '../../../src/services/voice/ntgcalls-ffi';

describe('NtgCalls FFI', () => {
  test('isNtgCallsAvailable returns boolean', () => {
    const available = isNtgCallsAvailable();
    expect(typeof available).toBe('boolean');
  });

  // Only run these if lib is present
  const describeIfAvailable = isNtgCallsAvailable() ? describe : describe.skip;

  describeIfAvailable('with library loaded', () => {
    test('init creates instance', () => {
      const ntg = new NtgCalls();
      expect(ntg).toBeDefined();
      ntg.destroy();
    });

    test('createP2P returns connection id', () => {
      const ntg = new NtgCalls();
      // This would need a valid chat_id — just testing it doesn't crash
      ntg.destroy();
    });
  });
});
```

- [ ] **Step 4: Implement FFI bindings**

```typescript
// src/services/voice/ntgcalls-ffi.ts
import { dlopen, FFIType, ptr, suffix, JSCallback } from 'bun:ffi';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

const LIB_PATHS = [
  join(import.meta.dir, '../../../lib/ntgcalls.' + suffix),
  join(import.meta.dir, '../../../lib/libntgcalls.' + suffix),
];

let lib: ReturnType<typeof dlopen> | null = null;

export function isNtgCallsAvailable(): boolean {
  if (lib) return true;
  try {
    loadLibrary();
    return true;
  } catch {
    return false;
  }
}

function loadLibrary() {
  if (lib) return lib;
  for (const path of LIB_PATHS) {
    if (!existsSync(path)) continue;
    try {
      lib = dlopen(path, {
        ntg_init: { returns: FFIType.ptr },
        ntg_destroy: { args: [FFIType.ptr], returns: FFIType.void },
        ntg_create_p2p: { args: [FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
        ntg_connect_p2p: { args: [FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.bool, FFIType.ptr], returns: FFIType.i32 },
        ntg_set_stream_sources: { args: [FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
        ntg_stop: { args: [FFIType.ptr, FFIType.i64, FFIType.ptr], returns: FFIType.i32 },
        ntg_get_state: { args: [FFIType.ptr, FFIType.i64], returns: FFIType.i32 },
        ntg_init_exchange: { args: [FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
        ntg_exchange_keys: { args: [FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      });
      return lib;
    } catch (err) {
      continue;
    }
  }
  throw new Error('ntgcalls shared library not found. Run scripts/download-ntgcalls.sh');
}

export class NtgCalls {
  private handle: number;

  constructor() {
    const l = loadLibrary();
    this.handle = l.symbols.ntg_init() as number;
  }

  destroy(): void {
    const l = loadLibrary();
    l.symbols.ntg_destroy(this.handle);
  }

  // Additional methods will be added as we implement the call flow
  // For now, this is the minimal skeleton to verify FFI works
}
```

> ⚠️ **IMPORTANT — C shim required.** Direct Bun FFI won't work because:
> 1. ntgcalls passes `ntg_async_struct` and `ntg_media_description_struct` **by value** — Bun FFI doesn't support struct-by-value
> 2. ntgcalls calls callbacks from C++ threads — Bun `JSCallback({ threadsafe: true })` crashes (issue #28113)
>
> **Solution:** Write a thin C shim (~100 LOC) that:
> - Wraps each ntgcalls function, accepting/returning pointers instead of struct-by-value
> - Replaces callbacks with atomic polling: shim allocates a result struct, JS polls `ntg_shim_poll()` with `Bun.sleep(1)`
> - Compile: `cc -shared -o lib/ntgcalls_shim.dylib shim.c -L lib -lntgcalls`
>
> See `docs/plans/ntgcalls-ffi-research.md` for complete shim source code and Bun FFI bindings with correct signatures.

- [ ] **Step 5: Run test — confirm PASS**

Run: `bun test test/services/voice/ntgcalls-ffi.test.ts`
Expected: PASS (basic tests pass; skip block runs if lib present)

- [ ] **Step 6: Commit**

```bash
git add src/services/voice/ntgcalls-ffi.ts test/services/voice/ntgcalls-ffi.test.ts scripts/download-ntgcalls.sh .gitignore
git commit -m "feat(voice): add ntgcalls FFI bindings skeleton + download script"
```

---

### Task 6: MTProto userbot client with @mtcute

**Files:**

- Create: `src/services/voice/mtproto-client.ts`
- Create: `src/services/voice/call-signaling.ts`
- Create: `test/services/voice/call-signaling.test.ts`

- [ ] **Step 1: Install @mtcute/bun**

```bash
bun add @mtcute/bun @mtcute/tl
```

- [ ] **Step 2: Write call signaling tests**

```typescript
// test/services/voice/call-signaling.test.ts
import { describe, expect, mock, test } from 'bun:test';
import { CallSignaling, type CallSignalingDeps } from '../../../src/services/voice/call-signaling';

describe('CallSignaling', () => {
  test('initiateCall validates user_id', async () => {
    const deps: CallSignalingDeps = {
      callRaw: mock(() => Promise.reject(new Error('should not be called'))),
    };
    const signaling = new CallSignaling(deps);
    await expect(signaling.initiateCall(0)).rejects.toThrow('Invalid user_id');
  });

  test('initiateCall calls phone.requestCall', async () => {
    const deps: CallSignalingDeps = {
      callRaw: mock(() => Promise.resolve({
        _: 'phone.phoneCall',
        phone_call: {
          _: 'phoneCallWaiting',
          id: 12345n,
          access_hash: 67890n,
        },
      })),
    };
    const signaling = new CallSignaling(deps);
    const result = await signaling.initiateCall(100);
    expect(result.callId).toBeDefined();
    expect(deps.callRaw).toHaveBeenCalled();
  });

  test('discardCall sends phone.discardCall', async () => {
    const deps: CallSignalingDeps = {
      callRaw: mock(() => Promise.resolve({ _: 'updates' })),
    };
    const signaling = new CallSignaling(deps);
    await signaling.discardCall(12345n, 67890n);
    expect(deps.callRaw).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Implement MTProto client wrapper**

```typescript
// src/services/voice/mtproto-client.ts
import { BunClient } from '@mtcute/bun';
import { voiceLogger } from './types';

export interface MtprotoClientConfig {
  apiId: number;
  apiHash: string;
  sessionString: string;
}

export async function createMtprotoClient(config: MtprotoClientConfig): Promise<BunClient> {
  const client = new BunClient({
    apiId: config.apiId,
    apiHash: config.apiHash,
    storage: `mtproto-session`,
  });

  await client.importSession(config.sessionString);
  await client.connect();

  voiceLogger.info('MTProto userbot client connected');
  return client;
}
```

> ⚠️ The exact @mtcute API may differ. The implementer must:
> 1. Read @mtcute/bun docs for session import/creation
> 2. Verify `importSession` vs `start` vs string session approach
> 3. May need interactive auth first to generate session string
> 4. Session string can be stored as env var `MTPROTO_SESSION`

- [ ] **Step 4: Implement call signaling (uses DH exchange module)**

The DH exchange is already implemented in `src/services/voice-call/dh-exchange.ts`. The call signaling module wraps it with @mtcute transport:

```typescript
// src/services/voice/call-signaling.ts
import { VoiceCallOrchestrator } from '../voice-call/dh-exchange';

export interface CallSignalingDeps {
  callRaw: (method: Record<string, unknown>) => Promise<unknown>;
}

interface CallInfo {
  callId: bigint;
  accessHash: bigint;
}

export class CallSignaling {
  private orchestrator: VoiceCallOrchestrator;

  constructor(private deps: CallSignalingDeps) {
    this.orchestrator = new VoiceCallOrchestrator({
      callRaw: deps.callRaw,
    });
  }

  async initiateCall(userId: number): Promise<CallInfo> {
    if (!userId || userId <= 0) throw new Error('Invalid user_id');

    const result = await this.deps.callRaw({
      _: 'phone.requestCall',
      user_id: { _: 'inputUser', user_id: userId, access_hash: 0n },
      random_id: randomId,
      g_a_hash: gAHash,
      protocol: {
        _: 'phoneCallProtocol',
        udp_p2p: true,
        udp_reflector: true,
        min_layer: 92,
        max_layer: 92,
        library_versions: ['7.0.0'],
      },
    });

    const phoneCall = (result as { phone_call: { id: bigint; access_hash: bigint } }).phone_call;
    return {
      callId: phoneCall.id,
      accessHash: phoneCall.access_hash,
    };
  }

  async discardCall(callId: bigint, accessHash: bigint): Promise<void> {
    await this.deps.callRaw({
      _: 'phone.discardCall',
      peer: {
        _: 'inputPhoneCall',
        id: callId,
        access_hash: accessHash,
      },
      duration: 0,
      reason: { _: 'phoneCallDiscardReasonHangup' },
      connection_id: 0n,
    });
  }
}
```

> ⚠️ **Critical:** The DH key exchange (`phone.requestCall` → `phone.acceptCall` → `phone.confirmCall`) is complex. The `g_a_hash` above is a placeholder. The real implementation needs proper Diffie-Hellman parameter generation per Telegram's E2E call protocol. The implementer should reference:
> - https://core.telegram.org/api/end-to-end/voice-calls
> - pytgcalls source for the Python version of this exchange
> - The GramJS gist linked in the research

- [ ] **Step 5: Run test — confirm PASS**

Run: `bun test test/services/voice/call-signaling.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/voice/mtproto-client.ts src/services/voice/call-signaling.ts test/services/voice/call-signaling.test.ts package.json bun.lock
git commit -m "feat(voice): add MTProto client + call signaling (phone.requestCall)"
```

---

