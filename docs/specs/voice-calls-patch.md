# Voice Calls — ntgcalls P2P Audio Patch

## Простыми словами

Telegram звонки работают так: бот звонит пользователю через интернет (WebRTC). Внутри WebRTC есть
"диспетчер" который решает когда отправлять звуковые пакеты. Этот диспетчер ждёт сигнал "сеть
доступна" прежде чем начать отправку.

**Баг:** библиотека ntgcalls (которая управляет звонками) забывает послать этот сигнал. Диспетчер
думает что сети нет и не отправляет ни одного звукового пакета. Звонок проходит, соединение
устанавливается, но собеседник слышит тишину.

**Фикс:** одна строка кода — "скажи диспетчеру что сеть доступна когда соединение установлено".

Мы нашли баг, собрали библиотеку из исходников с отладочными логами, увидели строку
`PacedSender paused` (диспетчер на паузе) и добавили недостающий вызов.
Баг влияет на все платформы (не только macOS).

## Problem

ntgcalls 2.1.0 has a bug where P2P voice calls connect successfully but audio is completely silent.
The call appears connected on both sides, but the receiver hears nothing.

## Root Cause

`NativeNetworkInterface::UpdateAggregateStates_n()` in ntgcalls never signals
`Call::GetTransportControllerSend()->OnNetworkAvailability(true)` when ICE connection establishes.

This causes WebRTC's `PacedSender` to stay paused — RTP audio packets are never sent despite:
- Opus codec negotiated correctly (48kHz, 2 channels)
- DTLS handshake completed
- NegotiateChannels exchange completed
- ffmpeg subprocess running and piping PCM data
- AudioStreamer::sendData() being called

## How We Found It

1. Tested P2P calls — audio always silent
2. Confirmed pipeline works: capture_time ticks, UDP data sent, codecs negotiated
3. Built ntgcalls from source with Debug config (`LS_VERBOSE` logging)
4. Debug logs revealed:
   ```
   webrtc rtp_transport_controller_send.cc:424 SignalNetworkState Down
   webrtc pacing_controller.cc:113 PacedSender paused.
   ```
5. Traced to `UpdateAggregateStates_n()` — missing `OnNetworkAvailability()` call

## The Fix

**File:** `wrtc/src/interfaces/native_network_interface.cpp`
**Location:** `UpdateAggregateStates_n()`, inside `if (connected != isConnected)` block

```cpp
// Add after stateUpdated() and dataChannelInterface->updateIsConnected():
std::weak_ptr weak(shared_from_this());
workerThread()->PostTask([weak, isConnected] {
    const auto strong = weak.lock();
    if (!strong || !strong->call) return;
    strong->call->GetTransportControllerSend()->OnNetworkAvailability(isConnected);
});
```

## Building Patched Binary

### Быстрый способ (скрипт)

```bash
./scripts/build-patched-ntgcalls.sh
```

Скрипт сам клонирует, патчит, собирает и устанавливает. Занимает ~5 минут.
Требует: Python 3.12, CMake, git, ~5GB RAM.

### Ручная сборка (пошагово)

```bash
# 1. Клонируем исходники ntgcalls
git clone https://github.com/pytgcalls/ntgcalls.git /tmp/ntgcalls-build
cd /tmp/ntgcalls-build

# 2. Меняем тип сборки на Debug (для отладочных логов)
#    В файле setup.py, строка 69:
#    Было:  return 'RelWithDebInfo' if sys.platform.startswith('linux') else 'Release'
#    Стало: return 'Debug'

# 3. Добавляем DEBUG define для macOS (включает verbose логирование)
#    В файле cmake/macOS.cmake, в блоке target_compile_definitions:
#    Добавить строку "DEBUG" рядом с NDEBUG (НЕ удалять NDEBUG!)

# 4. Применяем патч — ЭТО ГЛАВНОЕ
#    Файл: wrtc/src/interfaces/native_network_interface.cpp
#    Функция: UpdateAggregateStates_n()
#    Внутри блока "if (connected != isConnected)", после updateIsConnected, добавить:
#
#    std::weak_ptr weak(shared_from_this());
#    workerThread()->PostTask([weak, isConnected] {
#        const auto strong = weak.lock();
#        if (!strong || !strong->call) return;
#        strong->call->GetTransportControllerSend()->OnNetworkAvailability(isConnected);
#    });
#
#    Или применить: git apply scripts/ntgcalls-fix-network-state.patch

# 5. Собираем (CMake скачает все зависимости автоматически: WebRTC SDK,
#    Chromium clang, Boost, FFmpeg, OpenH264 — ~2GB)
venv/bin/python setup.py build_ext --inplace

# 6. Устанавливаем собранный .so файл в venv проекта
cp ntgcalls.cpython-312-darwin.so venv/lib/python3.12/site-packages/
```

### Что скачивается автоматически при сборке

| Зависимость | Размер | Откуда |
|---|---|---|
| WebRTC SDK (libwebrtc.a) | ~800MB | github.com/pytgcalls/webrtc-build |
| Chromium clang toolchain | ~500MB | chromium-browser-clang GCS |
| Boost (prebuilt) | ~100MB | github.com/pytgcalls/boost |
| FFmpeg (prebuilt) | ~50MB | github.com/pytgcalls/ffmpeg |
| OpenH264 (prebuilt) | ~10MB | github.com/pytgcalls/openh264 |
| libc++ headers | ~20MB | chromium llvm-project fork |

Всё скачивается в `deps/` внутри build директории. Не загрязняет систему.

### Результат сборки

- macOS arm64: `ntgcalls.cpython-312-darwin.so` (~42MB)
- Linux x86_64: `ntgcalls.cpython-312-linux-x86_64.so`
- Linux arm64: `ntgcalls.cpython-312-linux-aarch64.so`

## Deployment Notes

The patched `.so` binary is **platform-specific** and **not in git** (venv is gitignored).

### What's in the repo:
- `scripts/voice-call-bridge.py` — Python bridge for pytgcalls P2P calls
- `scripts/pyrogram-auth.py` — session authentication
- `src/services/voice/` — Bun-side call management
- `src/worker/call-queue.ts` — BullMQ async call queue

### What must be set up per-server:
1. Python 3.12 venv with `py-tgcalls`, `pyrofork`, `ntgcalls`
2. Patched ntgcalls binary (build from source with fix above)
3. Pyrogram session (`bun run auth:voice`)
4. Redis for BullMQ
5. `.env`: `MTPROTO_API_ID`, `MTPROTO_API_HASH`

### When upstream fixes the bug:
Just `venv/bin/pip install --upgrade ntgcalls` — no manual build needed.

## Upstream Issue

https://github.com/pytgcalls/ntgcalls/issues/44
