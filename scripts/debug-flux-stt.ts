/**
 * Debug Flux STT via WebSocket directly.
 * Usage: bun scripts/debug-flux-stt.ts [path/to/audio.raw]
 *
 * Without audio file: sends 5s of silence (PCM16 16kHz) to verify connection + message format.
 * With audio file: expects raw s16le 16kHz mono PCM (e.g. from sox or ffmpeg).
 *
 * Convert any audio: ffmpeg -i input.ogg -ar 16000 -ac 1 -f s16le output.raw
 */

// Remote message fields are logged on one line: a newline in them must not forge a log entry.
const oneLine = (value: unknown) => String(value).replace(/[\r\n]/g, '');

const apiKey = process.env.DEEPGRAM_API_KEY;
if (!apiKey) {
  console.error('DEEPGRAM_API_KEY not set');
  process.exit(1);
}

const params = new URLSearchParams({
  model: 'flux-general-en',
  eot_threshold: '0.7',
  eot_timeout_ms: '5000',
  encoding: 'linear16',
  sample_rate: '16000',
});
const url = `wss://api.deepgram.com/v2/listen?${params}`;

console.log('Connecting to Flux STT...');
console.log('URL:', url);

const ws = new WebSocket(url, { headers: { Authorization: `Token ${apiKey}` } } as never);

ws.onopen = async () => {
  console.log('[open] WebSocket connected ✓');

  const audioFile = process.argv[2];
  let pcm: Buffer;

  if (audioFile) {
    console.log(`[audio] Loading ${audioFile}`);
    pcm = Buffer.from(await Bun.file(audioFile).arrayBuffer());
    console.log(`[audio] ${pcm.length} bytes (${(pcm.length / 32000).toFixed(1)}s at 16kHz mono)`);
  } else {
    // 5 seconds of 440Hz sine wave at 16kHz s16le mono
    const SAMPLE_RATE = 16000;
    const DURATION_S = 5;
    const FREQ = 440;
    const samples = SAMPLE_RATE * DURATION_S;
    const buf = Buffer.allocUnsafe(samples * 2);
    for (let i = 0; i < samples; i++) {
      const sample = Math.round(Math.sin((2 * Math.PI * FREQ * i) / SAMPLE_RATE) * 8000);
      buf.writeInt16LE(sample, i * 2);
    }
    pcm = buf;
    console.log(`[audio] Generated ${DURATION_S}s sine wave at ${FREQ}Hz (simulated speech)`);
  }

  // Send in 20ms chunks (640 bytes at 16kHz s16le)
  const CHUNK_BYTES = 640;
  let offset = 0;
  console.log('[audio] Streaming audio chunks...');

  const SILENCE_CHUNK = Buffer.alloc(CHUNK_BYTES); // zeros = silence
  let silenceChunks = 0;
  const MAX_SILENCE_CHUNKS = 6000 / 20; // 6s of silence to trigger eot_timeout_ms (5s)

  const sendNext = () => {
    if (offset >= pcm.length) {
      // Keep streaming silence so Deepgram counts eot_timeout_ms
      if (silenceChunks === 0) console.log('[audio] Speech done, streaming silence to trigger EndOfTurn...');
      if (silenceChunks < MAX_SILENCE_CHUNKS) {
        ws.send(SILENCE_CHUNK);
        silenceChunks++;
        setTimeout(sendNext, 20);
      } else {
        console.log('[audio] Silence timeout reached, closing stream');
        ws.send(JSON.stringify({ type: 'CloseStream' }));
      }
      return;
    }
    const chunk = pcm.subarray(offset, offset + CHUNK_BYTES);
    ws.send(chunk);
    offset += CHUNK_BYTES;
    setTimeout(sendNext, 20);
  };

  sendNext();
};

ws.onmessage = (event) => {
  const raw = event.data as string;
  try {
    const msg = JSON.parse(raw) as Record<string, unknown>;
    const type = msg.type as string;
    if (type === 'ListenV2Connected') {
      console.log('[msg] Connected, request_id:', oneLine(msg.request_id));
    } else if (type === 'ListenV2TurnInfo') {
      const ev = msg.event as string;
      const transcript = (msg.transcript as string) ?? '';
      const conf = msg.end_of_turn_confidence as number | undefined;
      if (ev === 'StartOfTurn') {
        console.log('[turn] StartOfTurn');
      } else if (ev === 'EndOfTurn') {
        console.log(`[turn] EndOfTurn  confidence=${conf?.toFixed(3)}  transcript="${oneLine(transcript)}"`);
      } else {
        console.log(`[turn] ${oneLine(ev)}  transcript="${oneLine(transcript)}"`);
      }
    } else {
      console.log('[msg]', JSON.stringify(msg));
    }
  } catch {
    console.log('[msg] non-JSON:', oneLine(raw.slice(0, 80)));
  }
};

ws.onerror = (event) => {
  console.error('[error]', (event as ErrorEvent).message ?? event);
};

ws.onclose = (event) => {
  console.log(`[close] code=${event.code} reason=${event.reason || '(none)'}`);
  process.exit(event.code === 1000 ? 0 : 1);
};
