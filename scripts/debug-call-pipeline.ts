/**
 * Local call pipeline testbench — no Telegram call needed.
 *
 * Feeds data/last-call-user.raw (48kHz s16le mono, recorded from last call)
 * through the EN pipeline: resample → Flux STT → log all events.
 *
 * Usage:
 *   bun scripts/debug-call-pipeline.ts [path/to/audio.raw]
 *
 * Defaults to data/last-call-user.raw.
 * To convert any audio: ffmpeg -i input.ogg -ar 48000 -f s16le output.raw
 */

const apiKey = process.env.DEEPGRAM_API_KEY;
if (!apiKey) {
  console.error('DEEPGRAM_API_KEY not set');
  process.exit(1);
}

const audioPath = process.argv[2] ?? 'data/last-call-user.raw';
const file = Bun.file(audioPath);
if (!(await file.exists())) {
  console.error(`File not found: ${audioPath}`);
  process.exit(1);
}

const raw48k = Buffer.from(await file.arrayBuffer());
const durationS = raw48k.length / (48000 * 2);
console.log(`Audio: ${audioPath} — ${durationS.toFixed(1)}s at 48kHz s16le mono`);

// Resample 48kHz → 16kHz (3:1 decimation, same as bridge)
function resampleTo16k(buf: Buffer): Buffer {
  const src = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
  const dst = new Int16Array(Math.floor(src.length / 3));
  for (let i = 0; i < dst.length; i++) dst[i] = src[i * 3] ?? 0;
  return Buffer.from(dst.buffer);
}

const pcm16k = resampleTo16k(raw48k);
console.log(`Resampled: ${(pcm16k.length / (16000 * 2)).toFixed(1)}s at 16kHz\n`);

// Connect to Flux STT
const params = new URLSearchParams({
  model: 'flux-general-en',
  eot_threshold: '0.7',
  eot_timeout_ms: '3000', // faster for local testing
  encoding: 'linear16',
  sample_rate: '16000',
});
const url = `wss://api.deepgram.com/v2/listen?${params}`;
console.log(`Connecting to Flux: ${url}\n`);

const ws = new WebSocket(url, { headers: { Authorization: `Token ${apiKey}` } } as never);
let turnCount = 0;
let lastTranscript = '';
const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`;

ws.onopen = async () => {
  console.log(`[${ts()}] Connected ✓  streaming ${(pcm16k.length / 1024).toFixed(0)}KB...`);

  // Stream in 20ms chunks (640 bytes at 16kHz)
  const CHUNK = 640;
  let offset = 0;

  const sendNext = () => {
    if (offset >= pcm16k.length) {
      console.log(`[${ts()}] All audio sent, waiting for final EndOfTurn...`);
      // Keep sending silence so Flux can fire EndOfTurn
      const silence = Buffer.alloc(CHUNK);
      let silenceCount = 0;
      const sendSilence = () => {
        if (silenceCount++ > 200) {
          // 4s of silence
          ws.send(JSON.stringify({ type: 'CloseStream' }));
          return;
        }
        ws.send(silence);
        setTimeout(sendSilence, 20);
      };
      sendSilence();
      return;
    }
    ws.send(pcm16k.subarray(offset, offset + CHUNK));
    offset += CHUNK;
    setTimeout(sendNext, 20);
  };

  sendNext();
};

ws.onmessage = (event) => {
  try {
    const msg = JSON.parse(event.data as string) as Record<string, unknown>;
    const type = msg.type as string;

    if (type === 'Connected') {
      console.log(`[${ts()}] Flux connected, request_id=${msg.request_id}`);
    } else if (type === 'TurnInfo') {
      const ev = msg.event as string;
      const transcript = (msg.transcript as string) ?? '';
      const conf = msg.end_of_turn_confidence as number | undefined;

      if (ev === 'StartOfTurn') {
        console.log(`[${ts()}] ▶ StartOfTurn (turn ${turnCount})`);
      } else if (ev === 'EndOfTurn') {
        console.log(`[${ts()}] ■ EndOfTurn   conf=${conf?.toFixed(3)}  transcript="${transcript}"`);
        console.log(`            → would trigger agent with: "${transcript}"`);
        turnCount++;
      } else if (ev === 'Update' && transcript && transcript !== lastTranscript) {
        console.log(`[${ts()}]   interim: "${transcript}"`);
        lastTranscript = transcript;
      }
    } else if (type === 'Error') {
      console.error(`[${ts()}] Flux error: ${msg.description}`);
    }
  } catch {
    // non-JSON
  }
};

ws.onerror = (e) => console.error(`[${ts()}] WS error:`, (e as ErrorEvent).message);
ws.onclose = (e) => {
  console.log(`\n[${ts()}] Connection closed (code=${e.code})`);
  console.log(`\nSummary: ${turnCount} turn(s) detected`);
  process.exit(0);
};
