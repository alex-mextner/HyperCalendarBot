import { appendFileSync, mkdirSync } from 'node:fs';
import OpenAI from 'openai';
import { fixtures } from './fixtures.ts';
import { nativeResponseSchema as schema } from './gemini-response.ts';
import { promptFor, tools } from './sandbox.ts';

const out = process.argv[2];
if (!out) throw new Error('Unique output directory required');
mkdirSync(out, { mode: 0o700 });
const key = process.env.GEMINI_API_KEY;
if (!key) throw new Error('No configured Gemini key');
const fixture = fixtures.find(
  (f) => f.id === (process.argv[3]?.startsWith('native-delete') ? 'delete-confirmed' : 'terse-create'),
)!;
const system = promptFor(fixture);
const tool = tools.find((t) => t.type === 'function' && t.function.name === 'calculate');
if (!tool || tool.type !== 'function') throw new Error('Calculator schema absent');
const client = new OpenAI({
  apiKey: key,
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
  maxRetries: 0,
  timeout: 12000,
});

let accounted = 0;
for (const cap of [128, 4096])
  for (const thinking of ['default', 'none'])
    for (const transport of ['compat-stream', 'native']) {
      if (
        process.argv[3]?.startsWith('native-delete') &&
        (cap !== 4096 || thinking !== 'default' || transport !== 'native')
      )
        continue;
      if (process.argv[3] === 'native-default' && (thinking !== 'default' || transport !== 'native')) continue;
      const reserve = (new TextEncoder().encode(system + fixture.user).length * 0.3 + cap * 2.5) / 1e6;
      if (accounted + reserve > (process.argv[3]?.startsWith('native-delete') ? 0.04 : 0.025)) {
        console.log('DIAGNOSTIC_BUDGET_STOP');
        break;
      }
      await Bun.sleep(5000);
      accounted += reserve;
      const started = performance.now();
      try {
        let status = 200,
          finish: string | null = null,
          textChars = 0,
          toolCalls = 0,
          frames = 0,
          reasoning: number | null = null,
          input: number | null = null,
          output: number | null = null,
          total: number | null = null;
        const callNames: string[] = [];
        if (transport === 'compat-stream') {
          const stream = await client.chat.completions.create(
            {
              model: 'gemini-2.5-flash',
              messages: [
                { role: 'system', content: system },
                { role: 'user', content: fixture.user },
              ],
              tools: [tool],
              stream: true,
              stream_options: { include_usage: true },
              temperature: 0,
              max_tokens: cap,
              ...(thinking === 'none' ? { reasoning_effort: 'none' as const } : {}),
            },
            { signal: AbortSignal.timeout(12000) },
          );
          for await (const chunk of stream) {
            frames++;
            const c = chunk.choices[0];
            if (c?.finish_reason) finish = c.finish_reason;
            textChars += c?.delta.content?.length ?? 0;
            for (const call of c?.delta.tool_calls ?? [])
              if (call.function?.name) {
                toolCalls++;
                callNames.push(call.function.name);
              }
            if (chunk.usage) {
              input = chunk.usage.prompt_tokens;
              output = chunk.usage.completion_tokens;
              total = chunk.usage.total_tokens;
              reasoning = chunk.usage.completion_tokens_details?.reasoning_tokens ?? null;
            }
          }
        } else {
          const body = {
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: fixture.user }] }],
            tools: [
              {
                functionDeclarations: process.argv[3]?.startsWith('native-delete')
                  ? (process.argv[3] === 'native-delete-minimal'
                      ? tools.filter(
                          (t) =>
                            t.type === 'function' &&
                            ['get_event', 'delete_event', 'ask_user', 'render_day_image', 'calculate'].includes(
                              t.function.name,
                            ),
                        )
                      : tools
                    ).flatMap((t) =>
                      t.type === 'function'
                        ? [
                            {
                              name: t.function.name,
                              description: t.function.description,
                              parametersJsonSchema: t.function.parameters,
                            },
                          ]
                        : [],
                    )
                  : [
                      {
                        name: tool.function.name,
                        description: tool.function.description,
                        parametersJsonSchema: tool.function.parameters,
                      },
                    ],
              },
            ],
            generationConfig: {
              temperature: 0,
              maxOutputTokens: cap,
              ...(thinking === 'none' ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
            },
          };
          const response = await fetch(
            'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(12000),
            },
          );
          status = response.status;
          const data = schema.parse(await response.json());
          if (!response.ok) throw new Error(`${status}:${data.error?.status ?? 'native_error'}`);
          const candidate = data.candidates?.[0];
          finish = candidate?.finishReason ?? null;
          frames = data.candidates?.length ?? 0;
          for (const part of candidate?.content?.parts ?? []) {
            if (!part.thought) textChars += part.text?.length ?? 0;
            if (part.functionCall) {
              toolCalls++;
              callNames.push(part.functionCall.name);
            }
          }
          input = data.usageMetadata?.promptTokenCount ?? null;
          output = data.usageMetadata?.candidatesTokenCount ?? null;
          total = data.usageMetadata?.totalTokenCount ?? null;
          reasoning = data.usageMetadata?.thoughtsTokenCount ?? null;
        }
        const cost = input !== null && total !== null ? (input * 0.3 + Math.max(0, total - input) * 2.5) / 1e6 : null;
        if (cost !== null) accounted += cost - reserve;
        const record = {
          at: new Date().toISOString(),
          transport,
          thinking,
          cap,
          status,
          finish,
          textChars,
          toolCalls,
          callNames,
          frames,
          inputTokens: input,
          outputTokens: output,
          reasoningTokens: reasoning,
          totalTokens: total,
          ms: performance.now() - started,
          costEnvelopeUSD: cost,
          unusable: textChars === 0 && toolCalls === 0,
        };
        appendFileSync(`${out}/matrix.jsonl`, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        console.log(JSON.stringify(record));
      } catch (error) {
        const record = {
          at: new Date().toISOString(),
          transport,
          thinking,
          cap,
          ms: performance.now() - started,
          error:
            error instanceof OpenAI.APIError
              ? `HTTP_${error.status ?? 'unknown'}`
              : error instanceof Error
                ? error.message
                : 'unknown',
        };
        appendFileSync(`${out}/matrix.jsonl`, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        console.log(JSON.stringify(record));
        if (record.error.includes('429')) break;
      }
    }
console.log(`DIAGNOSTIC_COMPLETE ${JSON.stringify({ accountedUSD: accounted })}`);
