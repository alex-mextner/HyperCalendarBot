# ntgcalls C API Research for Bun FFI

**Source**: https://github.com/pytgcalls/ntgcalls (v2.1.0)
**Prebuilt binary**: `ntgcalls.macos-arm64-shared_libs.zip` from GitHub releases

---

## 1. Exact C Function Signatures (from `include/ntgcalls.h`)

### Lifecycle

```c
uintptr_t ntg_init();
int ntg_destroy(uintptr_t ptr);
```

### P2P Call Creation & Key Exchange

```c
int ntg_create_p2p(uintptr_t ptr, int64_t userId, ntg_async_struct future);

int ntg_init_exchange(uintptr_t ptr, int64_t userId,
    ntg_dh_config_struct* dhConfig,
    const uint8_t* g_a_hash, int sizeGAHash,
    uint8_t** buffer, int* size,
    ntg_async_struct future);

int ntg_exchange_keys(uintptr_t ptr, int64_t userId,
    const uint8_t* g_a_or_b, int sizeGAB,
    int64_t fingerprint,
    ntg_auth_params_struct* buffer,
    ntg_async_struct future);

int ntg_skip_exchange(uintptr_t ptr, int64_t userId,
    const uint8_t* encryptionKey, int size,
    bool isOutgoing,
    ntg_async_struct future);
```

### P2P Connection

```c
int ntg_connect_p2p(uintptr_t ptr, int64_t userId,
    ntg_rtc_server_struct* servers, int serversSize,
    char** versions, int versionsSize,
    bool p2pAllowed,
    ntg_async_struct future);

int ntg_send_signaling_data(uintptr_t ptr, int64_t userId,
    uint8_t* buffer, int size,
    ntg_async_struct future);

int ntg_get_protocol(ntg_protocol_struct* buffer);
```

### Stream Sources & Playback

```c
int ntg_set_stream_sources(uintptr_t ptr, int64_t chatID,
    ntg_stream_mode_enum streamMode,
    ntg_media_description_struct desc,
    ntg_async_struct future);

int ntg_send_external_frame(uintptr_t ptr, int64_t chatID,
    ntg_stream_device_enum device,
    uint8_t* frame, int frameSize,
    ntg_frame_data_struct frameData,
    ntg_async_struct future);
```

### Control

```c
int ntg_pause(uintptr_t ptr, int64_t chatID, ntg_async_struct future);
int ntg_resume(uintptr_t ptr, int64_t chatID, ntg_async_struct future);
int ntg_mute(uintptr_t ptr, int64_t chatID, ntg_async_struct future);
int ntg_unmute(uintptr_t ptr, int64_t chatID, ntg_async_struct future);
int ntg_stop(uintptr_t ptr, int64_t chatID, ntg_async_struct future);
int ntg_time(uintptr_t ptr, int64_t chatID, ntg_stream_mode_enum streamMode,
    int64_t* time, ntg_async_struct future);
int ntg_get_state(uintptr_t ptr, int64_t chatID,
    ntg_media_state_struct* mediaState, ntg_async_struct future);
```

### Callbacks (Event Registration)

```c
int ntg_on_stream_end(uintptr_t ptr, ntg_stream_callback callback, void* userData);
int ntg_on_upgrade(uintptr_t ptr, ntg_upgrade_callback callback, void* userData);
int ntg_on_connection_change(uintptr_t ptr, ntg_connection_callback callback, void* userData);
int ntg_on_signaling_data(uintptr_t ptr, ntg_signaling_callback callback, void* userData);
int ntg_on_frames(uintptr_t ptr, ntg_frame_callback callback, void* userData);
int ntg_on_remote_source_change(uintptr_t ptr, ntg_remote_source_callback callback, void* userData);
```

### Logging & Version

```c
void ntg_register_logger(ntg_log_message_callback callback);
int ntg_get_version(char** buffer);
```

---

## 2. Key Struct Definitions

### Async Callback Pattern

```c
typedef void (*ntg_async_callback)(void*);

typedef struct {
    void* userData;          // opaque pointer, passed to callback
    int* errorCode;          // written by ntgcalls before calling callback
    char** errorMessage;     // written by ntgcalls on error
    ntg_async_callback promise; // called when operation completes
} ntg_async_struct;
```

**How it works** (from C++ source):
1. Caller sets `*errorCode = NTG_ERROR_ASYNC_NOT_READY` initially
2. Caller provides a function pointer in `promise`
3. ntgcalls performs the operation on an internal thread
4. On completion: writes `*errorCode = 0` (or error code), then calls `promise(userData)`
5. The Go binding uses a mutex: locks before call, `promise` unlocks it, caller waits on re-lock

### Audio Description

```c
typedef struct {
    ntg_media_source_enum mediaSource; // NTG_FILE, NTG_SHELL, NTG_EXTERNAL, etc.
    char* input;                        // file path or shell command
    uint32_t sampleRate;                // 48000 or 96000
    uint8_t channelCount;               // 1 or 2
    bool keepOpen;                      // keep stream open after EOF
} ntg_audio_description_struct;
```

### Media Description (container for 4 optional streams)

```c
typedef struct {
    ntg_audio_description_struct* microphone; // can be NULL
    ntg_audio_description_struct* speaker;    // can be NULL
    ntg_video_description_struct* camera;     // can be NULL
    ntg_video_description_struct* screen;     // can be NULL
} ntg_media_description_struct;
```

### RTC Server

```c
typedef struct {
    uint64_t id;
    char* ipv4;
    char* ipv6;
    char* username;
    char* password;
    uint16_t port;
    bool turn;
    bool stun;
    bool tcp;
    uint8_t* peerTag;
    int peerTagSize;
} ntg_rtc_server_struct;
```

### Frame Data (for external frames)

```c
typedef struct {
    int64_t absoluteCaptureTimestampMs;
    uint16_t width, height;
    uint16_t rotation;
} ntg_frame_data_struct;
```

### Auth Params (key exchange result)

```c
typedef struct {
    uint8_t* g_a_or_b;
    int sizeGAB;
    int64_t key_fingerprint;
} ntg_auth_params_struct;
```

### DH Config

```c
typedef struct {
    int32_t g;
    const uint8_t* p;
    int sizeP;
    const uint8_t* random;
    int sizeRandom;
} ntg_dh_config_struct;
```

### Protocol

```c
typedef struct {
    int32_t minLayer;
    int32_t maxLayer;
    bool udpP2P;
    bool udpReflector;
    char** libraryVersions;
    int libraryVersionsSize;
} ntg_protocol_struct;
```

### Callback Type Signatures

```c
typedef void (*ntg_stream_callback)(uintptr_t, int64_t, ntg_stream_type_enum,
    ntg_stream_device_enum, void*);
typedef void (*ntg_connection_callback)(uintptr_t, int64_t, ntg_network_info_struct, void*);
typedef void (*ntg_signaling_callback)(uintptr_t, int64_t, uint8_t*, int, void*);
typedef void (*ntg_upgrade_callback)(uintptr_t, int64_t, ntg_media_state_struct, void*);
```

---

## 3. Audio Format Requirements

From `audio_sink.cpp` source code:

```
PCM16L AUDIO CODEC SPECIFICATION
Frame Time: 10 ms
Max SampleRate: 96000
Max BitsPerSample: 16 (ALWAYS 16, hardcoded)
Max Channels: 2
```

**Frame size formula**: `sampleRate * 16 / 8 / 100 * channelCount`

| Config | Frame Size (bytes) |
|--------|-------------------|
| 48kHz mono | 960 |
| 48kHz stereo | 1920 |
| 96kHz stereo | 3840 |

**Input format**: Raw PCM, 16-bit signed little-endian (s16le). NOT MP3, NOT WAV.

When using `NTG_FILE`, the `input` field is a path to a raw PCM file.
When using `NTG_SHELL`, the `input` field is a shell command (e.g. `ffmpeg -i input.mp3 -f s16le -ac 2 -ar 48000 pipe:1`).
When using `NTG_EXTERNAL`, frames are sent via `ntg_send_external_frame`.

The `sendData` method in AudioStreamer:
```cpp
void AudioStreamer::sendData(uint8_t* sample, size_t size, const wrtc::FrameData additionalData) {
    auto event = wrtc::RTCOnDataEvent(sample, frameSize() / (2 * description->channelCount));
    event.channelCount = description->channelCount;
    event.sampleRate = description->sampleRate;
    event.bitsPerSample = 16;  // ALWAYS 16
    audio->OnData(event, additionalData);
}
```

---

## 4. Two Approaches to Play Audio

### Approach A: NTG_SHELL (simplest, recommended for MP3/WAV)

Use ffmpeg to decode to raw PCM and pipe it. ntgcalls reads from the pipe internally.

```typescript
// Set stream sources with shell command that decodes MP3 to PCM
await setStreamSources(ptr, chatId, NTG_STREAM_CAPTURE, {
  microphone: {
    mediaSource: NTG_SHELL,  // 1 << 1 = 2
    input: "ffmpeg -i /path/to/audio.mp3 -f s16le -ac 2 -ar 48000 pipe:1",
    sampleRate: 48000,
    channelCount: 2,
    keepOpen: false,
  },
  speaker: null,
  camera: null,
  screen: null,
});
```

### Approach B: NTG_EXTERNAL (frame-by-frame control)

Set up stream with NTG_EXTERNAL, then manually send PCM frames via `ntg_send_external_frame`.
Each frame must be exactly `sampleRate * 16 / 8 / 100 * channelCount` bytes.
Frames must be sent every 10ms.

### Approach C: NTG_FILE (raw PCM file)

Point `input` to a pre-decoded raw PCM file (s16le).

---

## 5. P2P Call Flow (from C++ source analysis)

1. `ntg_create_p2p(ptr, userId)` - creates P2PCall instance
2. `ntg_init_exchange(ptr, userId, dhConfig, g_a_hash, ...)` - DH key exchange step 1
3. `ntg_exchange_keys(ptr, userId, g_a_or_b, fingerprint, ...)` - DH key exchange step 2
   OR `ntg_skip_exchange(ptr, userId, encryptionKey, isOutgoing)` - skip DH if key known
4. `ntg_set_stream_sources(ptr, userId, NTG_STREAM_CAPTURE, mediaDesc)` - configure audio
5. `ntg_connect_p2p(ptr, userId, servers, versions, p2pAllowed)` - connect via WebRTC
6. Register `ntg_on_signaling_data` callback - relay signaling to Telegram
7. Use `ntg_send_signaling_data` to forward Telegram signaling to ntgcalls

---

## 6. Bun FFI Binding

```typescript
import { dlopen, FFIType, suffix, ptr, CString, JSCallback, toArrayBuffer } from "bun:ffi";

// --- Enums ---

const NTG_FILE = 1 << 0;
const NTG_SHELL = 1 << 1;
const NTG_FFMPEG = 1 << 2;
const NTG_DEVICE = 1 << 3;
const NTG_DESKTOP = 1 << 4;
const NTG_EXTERNAL = 1 << 5;

const NTG_STREAM_CAPTURE = 0;
const NTG_STREAM_PLAYBACK = 1;

const NTG_STREAM_MICROPHONE = 0;
const NTG_STREAM_SPEAKER = 1;
const NTG_STREAM_CAMERA = 2;
const NTG_STREAM_SCREEN = 3;

const NTG_STREAM_AUDIO = 0;
const NTG_STREAM_VIDEO = 1;

const NTG_STATE_CONNECTING = 0;
const NTG_STATE_CONNECTED = 1;
const NTG_STATE_TIMEOUT = 2;
const NTG_STATE_FAILED = 3;
const NTG_STATE_CLOSED = 4;

const NTG_ERROR_ASYNC_NOT_READY = -4;

// --- Library Loading ---

const LIB_PATH = `./libntgcalls.${suffix}`;

const lib = dlopen(LIB_PATH, {
  // Lifecycle
  ntg_init: {
    returns: FFIType.ptr, // uintptr_t
    args: [],
  },
  ntg_destroy: {
    returns: FFIType.i32,
    args: [FFIType.ptr], // uintptr_t ptr
  },

  // P2P Call
  ntg_create_p2p: {
    returns: FFIType.i32,
    args: [
      FFIType.ptr,    // uintptr_t ptr
      FFIType.i64,    // int64_t userId
      // ntg_async_struct passed as 4 fields (struct by value):
      FFIType.ptr,    // void* userData
      FFIType.ptr,    // int* errorCode
      FFIType.ptr,    // char** errorMessage
      FFIType.ptr,    // ntg_async_callback promise
    ],
  },

  // Key Exchange
  ntg_init_exchange: {
    returns: FFIType.i32,
    args: [
      FFIType.ptr,    // uintptr_t ptr
      FFIType.i64,    // int64_t userId
      FFIType.ptr,    // ntg_dh_config_struct* dhConfig
      FFIType.ptr,    // const uint8_t* g_a_hash
      FFIType.i32,    // int sizeGAHash
      FFIType.ptr,    // uint8_t** buffer (output)
      FFIType.ptr,    // int* size (output)
      // ntg_async_struct (4 fields)
      FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr,
    ],
  },

  ntg_exchange_keys: {
    returns: FFIType.i32,
    args: [
      FFIType.ptr,    // uintptr_t ptr
      FFIType.i64,    // int64_t userId
      FFIType.ptr,    // const uint8_t* g_a_or_b
      FFIType.i32,    // int sizeGAB
      FFIType.i64,    // int64_t fingerprint
      FFIType.ptr,    // ntg_auth_params_struct* buffer (output)
      // ntg_async_struct (4 fields)
      FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr,
    ],
  },

  ntg_skip_exchange: {
    returns: FFIType.i32,
    args: [
      FFIType.ptr,    // uintptr_t ptr
      FFIType.i64,    // int64_t userId
      FFIType.ptr,    // const uint8_t* encryptionKey
      FFIType.i32,    // int size
      FFIType.bool,   // bool isOutgoing
      // ntg_async_struct (4 fields)
      FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr,
    ],
  },

  // P2P Connection
  ntg_connect_p2p: {
    returns: FFIType.i32,
    args: [
      FFIType.ptr,    // uintptr_t ptr
      FFIType.i64,    // int64_t userId
      FFIType.ptr,    // ntg_rtc_server_struct* servers
      FFIType.i32,    // int serversSize
      FFIType.ptr,    // char** versions
      FFIType.i32,    // int versionsSize
      FFIType.bool,   // bool p2pAllowed
      // ntg_async_struct (4 fields)
      FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr,
    ],
  },

  ntg_send_signaling_data: {
    returns: FFIType.i32,
    args: [
      FFIType.ptr,    // uintptr_t ptr
      FFIType.i64,    // int64_t userId
      FFIType.ptr,    // uint8_t* buffer
      FFIType.i32,    // int size
      // ntg_async_struct (4 fields)
      FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr,
    ],
  },

  ntg_get_protocol: {
    returns: FFIType.i32,
    args: [FFIType.ptr], // ntg_protocol_struct* buffer
  },

  // Stream Sources
  ntg_set_stream_sources: {
    returns: FFIType.i32,
    args: [
      FFIType.ptr,    // uintptr_t ptr
      FFIType.i64,    // int64_t chatID
      FFIType.i32,    // ntg_stream_mode_enum streamMode
      // ntg_media_description_struct (4 pointers, passed by value)
      FFIType.ptr,    // ntg_audio_description_struct* microphone
      FFIType.ptr,    // ntg_audio_description_struct* speaker
      FFIType.ptr,    // ntg_video_description_struct* camera
      FFIType.ptr,    // ntg_video_description_struct* screen
      // ntg_async_struct (4 fields)
      FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr,
    ],
  },

  ntg_send_external_frame: {
    returns: FFIType.i32,
    args: [
      FFIType.ptr,    // uintptr_t ptr
      FFIType.i64,    // int64_t chatID
      FFIType.i32,    // ntg_stream_device_enum device
      FFIType.ptr,    // uint8_t* frame
      FFIType.i32,    // int frameSize
      // ntg_frame_data_struct (by value: i64, u16, u16, u16 + padding)
      FFIType.i64,    // absoluteCaptureTimestampMs
      FFIType.u16,    // width
      FFIType.u16,    // height
      FFIType.u16,    // rotation
      // ntg_async_struct (4 fields)
      FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr,
    ],
  },

  // Control
  ntg_pause: {
    returns: FFIType.i32,
    args: [FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
  },
  ntg_resume: {
    returns: FFIType.i32,
    args: [FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
  },
  ntg_mute: {
    returns: FFIType.i32,
    args: [FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
  },
  ntg_unmute: {
    returns: FFIType.i32,
    args: [FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
  },
  ntg_stop: {
    returns: FFIType.i32,
    args: [FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
  },

  // Event Callbacks
  ntg_on_stream_end: {
    returns: FFIType.i32,
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], // ptr, callback, userData
  },
  ntg_on_upgrade: {
    returns: FFIType.i32,
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
  },
  ntg_on_connection_change: {
    returns: FFIType.i32,
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
  },
  ntg_on_signaling_data: {
    returns: FFIType.i32,
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
  },
  ntg_on_frames: {
    returns: FFIType.i32,
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
  },
  ntg_on_remote_source_change: {
    returns: FFIType.i32,
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
  },

  // Utility
  ntg_get_version: {
    returns: FFIType.i32,
    args: [FFIType.ptr], // char** buffer
  },
  ntg_register_logger: {
    returns: FFIType.void,
    args: [FFIType.ptr], // ntg_log_message_callback
  },
});
```

---

## 7. CRITICAL CAVEAT: Struct-by-Value in Bun FFI

**Bun FFI does NOT support passing structs by value.** The C API passes
`ntg_async_struct` (4 fields) and `ntg_media_description_struct` (4 pointers)
and `ntg_frame_data_struct` by value in the function signatures.

The binding above assumes Bun will flatten struct fields as individual arguments.
**This will NOT work** with current Bun FFI. The struct layout in registers/stack
depends on the platform ABI (System V AMD64 or ARM64 AAPCS).

### Solutions (in order of preference):

**Option 1: Write a thin C shim** that wraps the struct-by-value calls into
pointer-based calls. Compile with `cc -shared -o libntgshim.dylib shim.c -lntgcalls`.

```c
// ntgcalls_shim.c
#include "ntgcalls.h"

int ntg_create_p2p_shim(uintptr_t ptr, int64_t userId, ntg_async_struct* future) {
    return ntg_create_p2p(ptr, userId, *future);
}

int ntg_set_stream_sources_shim(uintptr_t ptr, int64_t chatID,
    ntg_stream_mode_enum streamMode,
    ntg_media_description_struct* desc,
    ntg_async_struct* future) {
    return ntg_set_stream_sources(ptr, chatID, streamMode, *desc, *future);
}

int ntg_send_external_frame_shim(uintptr_t ptr, int64_t chatID,
    ntg_stream_device_enum device,
    uint8_t* frame, int frameSize,
    ntg_frame_data_struct* frameData,
    ntg_async_struct* future) {
    return ntg_send_external_frame(ptr, chatID, device, frame, frameSize, *frameData, *future);
}

// ... repeat for all functions taking ntg_async_struct
```

**Option 2: Use Bun's native addon support** (napi) instead of FFI.

**Option 3: Use a subprocess** calling a Go/Python binary that wraps ntgcalls.

---

## 8. Async Callback Pattern for Bun FFI (JSCallback)

The Go binding reveals the pattern clearly:

```go
// Go: lock mutex, set promise = unlockMutex, wait for re-lock
func CreateFuture() *Future {
    res := &Future{ mutex: &sync.Mutex{} }
    res.mutex.Lock()  // lock before call
    return res
}
func (ctx *Future) wait() {
    ctx.mutex.Lock()  // blocks until promise() unlocks
}
```

For Bun, the equivalent using JSCallback:

```typescript
import { JSCallback, ptr as ptrOf } from "bun:ffi";

interface AsyncResult {
  errorCode: number;
  errorMessage: string | null;
  promise: Promise<void>;
}

function createAsyncStruct(): {
  struct: { userData: number; errorCode: number; errorMessage: number; promise: number };
  result: Promise<AsyncResult>;
} {
  // Allocate memory for errorCode (int32) and errorMessage (char*)
  const errorCodeBuf = new Int32Array(1);
  errorCodeBuf[0] = NTG_ERROR_ASYNC_NOT_READY;
  const errorMsgBuf = new BigUint64Array(1); // char* pointer

  let resolvePromise: (value: AsyncResult) => void;
  const resultPromise = new Promise<AsyncResult>((resolve) => {
    resolvePromise = resolve;
  });

  // The callback ntgcalls will invoke when done
  // WARNING: this callback is called from a C++ thread, NOT the JS thread.
  // Bun's JSCallback handles cross-thread dispatch.
  const callback = new JSCallback(
    (userData: number) => {
      const code = errorCodeBuf[0];
      resolvePromise({
        errorCode: code,
        errorMessage: null, // would need to read errorMsgBuf pointer
        promise: Promise.resolve(),
      });
    },
    { returns: "void", args: ["ptr"] }
  );

  return {
    struct: {
      userData: 0,                    // not used in our pattern
      errorCode: ptrOf(errorCodeBuf), // int* errorCode
      errorMessage: ptrOf(errorMsgBuf), // char** errorMessage
      promise: callback.ptr,          // function pointer
    },
    result: resultPromise,
  };
}
```

### Thread Safety Warning

**ntg_async_callback is called from a C++ worker thread**, not the main JS thread.

Bun's `JSCallback` supports `threadsafe: true` (experimental):
```typescript
const callback = new JSCallback((userData: number) => { /* ... */ }, {
  returns: "void",
  args: ["ptr"],
  threadsafe: true,  // REQUIRED for ntgcalls callbacks
});
```

Per Bun docs: "thread-safe callbacks work best when run from another thread that
is running JavaScript code, i.e. a Worker. A future version of Bun will enable
them to be called from any thread (such as new threads spawned by your native
library that Bun is not aware of)."

**This means ntgcalls callbacks from C++ threads may NOT work reliably yet.**
The Go binding works because Go's goroutine scheduler handles cross-thread calls natively.
**This is the biggest risk** in the Bun FFI approach.

---

## 9. Complete Example: Play MP3 into P2P Call (Shell Method)

```typescript
// Pseudocode - requires the C shim from section 7

async function playAudioInP2PCall(
  ntgPtr: number,
  userId: bigint,
  audioFilePath: string
) {
  // 1. Create P2P call
  const createFuture = createAsyncStruct();
  lib.symbols.ntg_create_p2p_shim(ntgPtr, userId, ptrOf(createFuture.structBuf));
  const createResult = await createFuture.result;
  if (createResult.errorCode !== 0) throw new Error(`create_p2p failed: ${createResult.errorCode}`);

  // 2. Key exchange (ntg_init_exchange + ntg_exchange_keys)
  //    ... DH config from Telegram API ...

  // 3. Set stream sources - use ffmpeg shell to decode MP3
  const audioDesc = allocAudioDescription({
    mediaSource: NTG_SHELL,  // 2
    input: `ffmpeg -i ${audioFilePath} -f s16le -ac 2 -ar 48000 pipe:1`,
    sampleRate: 48000,
    channelCount: 2,
    keepOpen: false,
  });

  const mediaDesc = allocMediaDescription({
    microphone: audioDesc,
    speaker: null,
    camera: null,
    screen: null,
  });

  const setStreamFuture = createAsyncStruct();
  lib.symbols.ntg_set_stream_sources_shim(
    ntgPtr, userId, NTG_STREAM_CAPTURE,
    ptrOf(mediaDesc), ptrOf(setStreamFuture.structBuf)
  );
  await setStreamFuture.result;

  // 4. Connect P2P (after key exchange)
  //    ntg_connect_p2p(ptr, userId, servers, versions, p2pAllowed)

  // 5. Register signaling callback
  //    ntg_on_signaling_data → relay to Telegram
  //    Telegram signaling → ntg_send_signaling_data
}
```

---

## 10. External Frame Method (frame-by-frame PCM)

```typescript
async function streamExternalAudio(
  ntgPtr: number,
  chatId: bigint,
  pcmData: Uint8Array  // raw PCM s16le, 48kHz, stereo
) {
  // Configure with NTG_EXTERNAL
  const audioDesc = allocAudioDescription({
    mediaSource: NTG_EXTERNAL,  // 1 << 5 = 32
    input: "",
    sampleRate: 48000,
    channelCount: 2,
    keepOpen: true,
  });

  // Set stream sources...

  // Frame size: 48000 * 16 / 8 / 100 * 2 = 1920 bytes per 10ms frame
  const FRAME_SIZE = 1920;
  const FRAME_INTERVAL_MS = 10;

  for (let offset = 0; offset < pcmData.length; offset += FRAME_SIZE) {
    const frame = pcmData.slice(offset, offset + FRAME_SIZE);
    if (frame.length < FRAME_SIZE) break; // incomplete frame

    const frameData = allocFrameData({
      absoluteCaptureTimestampMs: BigInt(Date.now()),
      width: 0,
      height: 0,
      rotation: 0,
    });

    const future = createAsyncStruct();
    lib.symbols.ntg_send_external_frame_shim(
      ntgPtr, chatId,
      NTG_STREAM_MICROPHONE, // device = 0
      ptrOf(frame), frame.length,
      ptrOf(frameData),
      ptrOf(future.structBuf)
    );
    await future.result;

    // Wait 10ms between frames
    await Bun.sleep(FRAME_INTERVAL_MS);
  }
}

// To convert MP3 to PCM in Bun before sending:
async function mp3ToPcm(mp3Path: string): Promise<Uint8Array> {
  const proc = Bun.spawn([
    "ffmpeg", "-i", mp3Path,
    "-f", "s16le", "-ac", "2", "-ar", "48000",
    "pipe:1"
  ], { stdout: "pipe" });
  const chunks: Uint8Array[] = [];
  for await (const chunk of proc.stdout) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
```

---

## 11. Caveats & Notes

### Memory Management
- ntgcalls allocates memory for output buffers (`uint8_t** buffer`) using `new[]`
- Caller must `delete[]` / `free()` these after use
- In Bun FFI, use `Bun.FFI.read()` to copy data out, then the C shim should free
- `ntg_async_struct.errorMessage` is `strdup()`-ed by ntgcalls, caller must `free()`
- All `char* input` strings in descriptions are copied by ntgcalls into `std::string`

### Thread Safety
- ntgcalls uses internal WebRTC threads (network, signaling, worker)
- All async callbacks fire on C++ threads, NOT the JS main thread
- The `ntg_async_callback` (promise) fires from whatever thread completes the operation
- Event callbacks (`ntg_on_stream_end`, etc.) fire from WebRTC threads
- **Bun's JSCallback thread safety is the primary concern**

### Buffer Ownership
- Input buffers (`frame`, `g_a_or_b`, `encryptionKey`) are copied by ntgcalls into `bytes::binary`
  immediately, so the caller can free/reuse them after the call returns
- Output buffers (from `ntg_init_exchange`, `ntg_exchange_keys`) are `new[]`-allocated
  and must be freed by the caller

### Platform
- macOS arm64: `ntgcalls.macos-arm64-shared_libs.zip` from releases
- The shared lib will be `libntgcalls.dylib`
- Requires linking against system frameworks (likely bundled in the shared lib)

### What ntgcalls Does NOT Do
- No Telegram API interaction (call creation, signaling relay, DH config fetching)
- No audio decoding (needs raw PCM, or use NTG_SHELL with ffmpeg)
- No call state persistence
- The Telegram-side call setup (phone.requestCall, phone.acceptCall, etc.) must be
  handled separately via MTProto

---

## 12. Recommended Architecture

Given the two showstoppers (struct-by-value, threadsafe callbacks), the most
reliable approach is a **C shim library** that:

1. Wraps all struct-by-value parameters into pointer-based equivalents
2. Converts the async callback pattern into a simple polling model
   (write to a shared memory buffer, JS polls or uses a pipe/eventfd)

### Minimal C Shim

```c
// ntgcalls_shim.c - compile with:
// cc -shared -o libntgshim.dylib ntgcalls_shim.c -L. -lntgcalls

#include "ntgcalls.h"
#include <stdlib.h>
#include <string.h>

// Simple synchronization: semaphore-like via atomic
#include <stdatomic.h>

typedef struct {
    atomic_int ready;     // 0 = pending, 1 = done
    int errorCode;
    char* errorMessage;
} ntg_sync_result;

static void sync_callback(void* userData) {
    ntg_sync_result* result = (ntg_sync_result*)userData;
    atomic_store(&result->ready, 1);
}

static ntg_async_struct make_async(ntg_sync_result* result) {
    result->ready = 0;
    result->errorCode = -4; // NTG_ERROR_ASYNC_NOT_READY
    result->errorMessage = NULL;
    return (ntg_async_struct){
        .userData = result,
        .errorCode = &result->errorCode,
        .errorMessage = &result->errorMessage,
        .promise = sync_callback,
    };
}

// Poll: returns 1 if done, 0 if still pending
int ntg_shim_poll(ntg_sync_result* result) {
    return atomic_load(&result->ready);
}

int ntg_shim_error_code(ntg_sync_result* result) {
    return result->errorCode;
}

// --- Wrapped functions ---

ntg_sync_result* ntg_shim_create_p2p(uintptr_t ptr, int64_t userId) {
    ntg_sync_result* r = calloc(1, sizeof(ntg_sync_result));
    ntg_create_p2p(ptr, userId, make_async(r));
    return r;
}

ntg_sync_result* ntg_shim_set_stream_sources(
    uintptr_t ptr, int64_t chatID,
    ntg_stream_mode_enum streamMode,
    ntg_media_description_struct* desc
) {
    ntg_sync_result* r = calloc(1, sizeof(ntg_sync_result));
    ntg_set_stream_sources(ptr, chatID, streamMode, *desc, make_async(r));
    return r;
}

ntg_sync_result* ntg_shim_connect_p2p(
    uintptr_t ptr, int64_t userId,
    ntg_rtc_server_struct* servers, int serversSize,
    char** versions, int versionsSize,
    bool p2pAllowed
) {
    ntg_sync_result* r = calloc(1, sizeof(ntg_sync_result));
    ntg_connect_p2p(ptr, userId, servers, serversSize,
        versions, versionsSize, p2pAllowed, make_async(r));
    return r;
}

ntg_sync_result* ntg_shim_send_external_frame(
    uintptr_t ptr, int64_t chatID,
    ntg_stream_device_enum device,
    uint8_t* frame, int frameSize,
    ntg_frame_data_struct* frameData
) {
    ntg_sync_result* r = calloc(1, sizeof(ntg_sync_result));
    ntg_send_external_frame(ptr, chatID, device, frame, frameSize,
        *frameData, make_async(r));
    return r;
}

ntg_sync_result* ntg_shim_stop(uintptr_t ptr, int64_t chatID) {
    ntg_sync_result* r = calloc(1, sizeof(ntg_sync_result));
    ntg_stop(ptr, chatID, make_async(r));
    return r;
}

ntg_sync_result* ntg_shim_mute(uintptr_t ptr, int64_t chatID) {
    ntg_sync_result* r = calloc(1, sizeof(ntg_sync_result));
    ntg_mute(ptr, chatID, make_async(r));
    return r;
}

ntg_sync_result* ntg_shim_unmute(uintptr_t ptr, int64_t chatID) {
    ntg_sync_result* r = calloc(1, sizeof(ntg_sync_result));
    ntg_unmute(ptr, chatID, make_async(r));
    return r;
}

ntg_sync_result* ntg_shim_pause(uintptr_t ptr, int64_t chatID) {
    ntg_sync_result* r = calloc(1, sizeof(ntg_sync_result));
    ntg_pause(ptr, chatID, make_async(r));
    return r;
}

ntg_sync_result* ntg_shim_resume(uintptr_t ptr, int64_t chatID) {
    ntg_sync_result* r = calloc(1, sizeof(ntg_sync_result));
    ntg_resume(ptr, chatID, make_async(r));
    return r;
}

void ntg_shim_free_result(ntg_sync_result* result) {
    if (result->errorMessage) free(result->errorMessage);
    free(result);
}

// --- Event callbacks using pipe-based notification ---
// For ntg_on_signaling_data, ntg_on_stream_end, etc.
// these need a ring buffer or pipe fd approach since
// they fire from C++ threads unpredictably.
// Simplest: write to a Unix pipe, JS reads with Bun's async I/O.
```

### Bun FFI for the Shim

```typescript
import { dlopen, FFIType, suffix, ptr, read, toArrayBuffer } from "bun:ffi";

const shim = dlopen(`./libntgshim.${suffix}`, {
  ntg_init: { returns: FFIType.ptr, args: [] },
  ntg_destroy: { returns: FFIType.i32, args: [FFIType.ptr] },

  ntg_shim_create_p2p: {
    returns: FFIType.ptr,  // ntg_sync_result*
    args: [FFIType.ptr, FFIType.i64],
  },
  ntg_shim_set_stream_sources: {
    returns: FFIType.ptr,
    args: [FFIType.ptr, FFIType.i64, FFIType.i32, FFIType.ptr],
  },
  ntg_shim_connect_p2p: {
    returns: FFIType.ptr,
    args: [FFIType.ptr, FFIType.i64, FFIType.ptr, FFIType.i32,
           FFIType.ptr, FFIType.i32, FFIType.bool],
  },
  ntg_shim_send_external_frame: {
    returns: FFIType.ptr,
    args: [FFIType.ptr, FFIType.i64, FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr],
  },
  ntg_shim_stop: {
    returns: FFIType.ptr,
    args: [FFIType.ptr, FFIType.i64],
  },
  ntg_shim_mute: {
    returns: FFIType.ptr,
    args: [FFIType.ptr, FFIType.i64],
  },
  ntg_shim_unmute: {
    returns: FFIType.ptr,
    args: [FFIType.ptr, FFIType.i64],
  },

  ntg_shim_poll: {
    returns: FFIType.i32,
    args: [FFIType.ptr],
  },
  ntg_shim_error_code: {
    returns: FFIType.i32,
    args: [FFIType.ptr],
  },
  ntg_shim_free_result: {
    returns: FFIType.void,
    args: [FFIType.ptr],
  },

  // Direct ntgcalls functions that don't need struct-by-value
  ntg_get_protocol: {
    returns: FFIType.i32,
    args: [FFIType.ptr],
  },
  ntg_on_stream_end: {
    returns: FFIType.i32,
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
  },
  ntg_on_connection_change: {
    returns: FFIType.i32,
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
  },
  ntg_on_signaling_data: {
    returns: FFIType.i32,
    args: [FFIType.ptr, FFIType.ptr, FFIType.ptr],
  },
  ntg_get_version: {
    returns: FFIType.i32,
    args: [FFIType.ptr],
  },
});

// --- Async helper: poll until done ---

async function waitForResult(resultPtr: number): Promise<number> {
  while (shim.symbols.ntg_shim_poll(resultPtr) === 0) {
    await Bun.sleep(1); // yield, check again in 1ms
  }
  const errorCode = shim.symbols.ntg_shim_error_code(resultPtr);
  shim.symbols.ntg_shim_free_result(resultPtr);
  if (errorCode !== 0) {
    throw new Error(`ntgcalls error: ${errorCode}`);
  }
  return errorCode;
}

// --- Struct allocation helpers ---

function allocAudioDescription(desc: {
  mediaSource: number;
  input: string;
  sampleRate: number;
  channelCount: number;
  keepOpen: boolean;
}): Uint8Array {
  // ntg_audio_description_struct layout (arm64):
  // offset 0:  int32  mediaSource (4 bytes + 4 padding)
  // offset 8:  ptr    input (8 bytes)
  // offset 16: uint32 sampleRate (4 bytes)
  // offset 20: uint8  channelCount (1 byte)
  // offset 21: bool   keepOpen (1 byte + 2 padding)
  // total: 24 bytes
  const buf = new ArrayBuffer(24);
  const view = new DataView(buf);
  const inputBuf = Buffer.from(desc.input + "\0", "utf8");

  view.setInt32(0, desc.mediaSource, true);
  // pointer to input string - need to keep inputBuf alive!
  const inputPtr = ptr(inputBuf);
  if (typeof inputPtr === "number") {
    view.setBigUint64(8, BigInt(inputPtr), true);
  }
  view.setUint32(16, desc.sampleRate, true);
  view.setUint8(20, desc.channelCount);
  view.setUint8(21, desc.keepOpen ? 1 : 0);

  return new Uint8Array(buf);
}

function allocMediaDescription(desc: {
  microphone: Uint8Array | null;
  speaker: Uint8Array | null;
  camera: Uint8Array | null;
  screen: Uint8Array | null;
}): Uint8Array {
  // ntg_media_description_struct: 4 pointers (32 bytes on 64-bit)
  const buf = new ArrayBuffer(32);
  const view = new DataView(buf);

  const setPtr = (offset: number, typedArray: Uint8Array | null) => {
    if (typedArray) {
      view.setBigUint64(offset, BigInt(ptr(typedArray)), true);
    }
    // null = 0 (already zeroed by ArrayBuffer)
  };

  setPtr(0, desc.microphone);
  setPtr(8, desc.speaker);
  setPtr(16, desc.camera);
  setPtr(24, desc.screen);

  return new Uint8Array(buf);
}
```

---

## 13. Summary of Risks & Recommendations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Struct-by-value not supported in Bun FFI | **Blocker** | C shim required |
| JSCallback threadsafe is experimental, may not work from C++ threads | **High** | Use polling model instead of callbacks for async; use pipe/eventfd for events |
| `bun:ffi` itself is experimental | **Medium** | Node-API module as fallback |
| Memory leaks from C allocations | **Medium** | Careful free() in shim, FinalizationRegistry |
| ntgcalls has no macOS x86_64 build | **Low** | Only arm64 available, fine for M-series |

**Recommended approach**: C shim + polling for async + pipe for event callbacks.
The Go binding is the closest reference implementation to follow.
