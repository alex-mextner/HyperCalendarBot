import { type AiLogRow, AiLogRowSchema, summarizeAiLogs } from '../src/services/ai/latency-report.ts';
import { jsonCodec } from '../src/utils/json-codec.ts';

const path = Bun.argv[2];
if (!path) {
  console.error('Usage: bun scripts/report-ai-latency.ts <pino-jsonl-file>');
  process.exit(2);
}
const codec = jsonCodec(AiLogRowSchema);
const interesting = new Set([
  'AI request metric',
  'AI model call metric',
  'Routing decision',
  'Routing decision fallback',
]);
const rows: AiLogRow[] = [];
let malformed = 0;
let sourceRows = 0;
let buffer = '';
const decoder = new TextDecoder();
for await (const chunk of Bun.file(path).stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    sourceRows++;
    const parsed = codec.safeParse(line);
    if (!parsed.success) {
      malformed++;
      continue;
    }
    if (interesting.has(parsed.data.msg ?? '')) rows.push(parsed.data);
  }
}
buffer += decoder.decode();
if (buffer.trim()) {
  sourceRows++;
  const parsed = codec.safeParse(buffer);
  if (!parsed.success) malformed++;
  else if (interesting.has(parsed.data.msg ?? '')) rows.push(parsed.data);
}
const summary = summarizeAiLogs(rows);
console.log(JSON.stringify({ ...summary, metricRows: rows.length, sourceRows, malformedRows: malformed }, null, 2));
