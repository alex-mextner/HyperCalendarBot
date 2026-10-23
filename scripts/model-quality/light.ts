// scripts/model-quality/light.ts
// The planner role: bounded, side-effect-free structured tasks (tool-group selection, literal field
// extraction, tool-outcome interpretation). Nothing in production calls a planner yet, so the request is
// the preset's own settings plus a strict JSON schema; the answer must be exactly that JSON.

import type OpenAI from 'openai';
import { z } from 'zod';
import { presetRequestFields } from '../../src/services/ai/model-presets.ts';
import { acceptsSamplingTemperature, CLAUDE_MAX_OUTPUT_TOKENS } from '../../src/services/ai/streaming.ts';
import { type Budget, estimateRequestUsd, type Reservation } from './budget.ts';
import { gradeLight, instructions, type LightCase, lightSchemas } from './light-cases.ts';
import { type Candidate, candidateId } from './models.ts';
import { classifyError, costOf, type MeasuredRow } from './runner.ts';

export interface LightResponse {
  content: string;
  finishReason: string | null;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    reasoningTokens: number | null;
    cachedTokens: number | null;
    costUsd?: number | null;
  } | null;
}

export type LightCall = (
  request: OpenAI.ChatCompletionCreateParamsNonStreaming,
  signal: AbortSignal,
) => Promise<LightResponse>;

export interface LightRow extends MeasuredRow {
  role: 'planner';
  content: string;
}

const LIGHT_MIN_OUTPUT_TOKENS = 1536;

/**
 * Claude's structured output answers 400 to an array `maxItems` ("property 'maxItems' is not supported",
 * seen live 2026-10-23). It gets the schema without that keyword; grading still parses the answer with the
 * full schema, so a fifth group is still a failure.
 */
function stripMaxItems(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMaxItems);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'maxItems')
      .map(([key, entry]) => [key, stripMaxItems(entry)]),
  );
}

type JsonSchemaObject = NonNullable<OpenAI.ResponseFormatJSONSchema['json_schema']['schema']>;

function schemaFor(provider: Candidate['provider'], role: LightCase['role']): JsonSchemaObject {
  const schema = z.toJSONSchema(lightSchemas[role]);
  return provider === 'claude' ? Object.fromEntries(Object.entries(stripMaxItems(schema) ?? {})) : schema;
}

export function lightRequest(candidate: Candidate, fixture: LightCase): OpenAI.ChatCompletionCreateParamsNonStreaming {
  const { preset, provider } = candidate;
  const temperature = preset.temperature ?? 0;
  return {
    model: candidate.model,
    messages: [
      { role: 'system', content: instructions[fixture.role] },
      { role: 'user', content: fixture.input },
    ],
    max_tokens:
      provider === 'claude' ? CLAUDE_MAX_OUTPUT_TOKENS : Math.max(LIGHT_MIN_OUTPUT_TOKENS, preset.maxOutputTokens ?? 0),
    ...(acceptsSamplingTemperature(provider) ? { temperature } : {}),
    ...presetRequestFields(provider, preset),
    response_format: {
      type: 'json_schema',
      json_schema: { name: fixture.role, strict: true, schema: schemaFor(provider, fixture.role) },
    },
  };
}

/** The real call: one non-streaming request, no retry. */
export function lightCallFor(client: OpenAI): LightCall {
  return async (request, signal) => {
    const response = await client.chat.completions.create(request, { signal });
    const choice = response.choices[0];
    const usage = response.usage;
    const cost = usage ? Reflect.get(usage, 'cost') : undefined;
    return {
      content: choice?.message.content ?? '',
      finishReason: choice?.finish_reason ?? null,
      usage: usage
        ? {
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? null,
            cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? null,
            ...(typeof cost === 'number' ? { costUsd: cost } : {}),
          }
        : null,
    };
  };
}

export interface LightArgs {
  candidate: Candidate;
  fixture: LightCase;
  repetition: number;
  call: LightCall;
  budget: Budget;
  attemptTimeoutMs: number;
}

export async function runLightCase(args: LightArgs): Promise<LightRow> {
  const { candidate, fixture, repetition, call, budget } = args;
  const request = lightRequest(candidate, fixture);
  const row: LightRow = {
    role: 'planner',
    candidate: candidateId(candidate),
    presetId: candidate.preset.id,
    provider: candidate.provider,
    model: candidate.model,
    caseId: fixture.id,
    family: fixture.role,
    repetition,
    pass: false,
    critical: false,
    reasons: [],
    durationMs: 0,
    error: null,
    status: null,
    rounds: 1,
    roundMs: [],
    finishReasons: [],
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cachedTokens: null,
    usageMissing: false,
    costUsd: null,
    costSource: 'unknown',
    unknownCostReservationUsd: 0,
    content: '',
  };
  const started = performance.now();
  let pending: Reservation | null = null;
  try {
    pending = budget.reserve(estimateRequestUsd(candidate.price, request.messages, []));
    const response = await call(request, AbortSignal.timeout(args.attemptTimeoutMs));
    const cost = costOf(response.usage, candidate.price);
    const reserved = pending;
    budget.settle(reserved, cost.usd);
    pending = null;
    if (cost.usd === null) {
      row.usageMissing = true;
      row.unknownCostReservationUsd = reserved.usd;
    }
    row.costUsd = cost.usd;
    row.costSource = cost.source;
    row.inputTokens = response.usage?.promptTokens ?? null;
    row.outputTokens = response.usage?.completionTokens ?? null;
    row.reasoningTokens = response.usage?.reasoningTokens ?? null;
    row.cachedTokens = response.usage?.cachedTokens ?? null;
    row.content = response.content;
    if (response.finishReason) row.finishReasons.push(response.finishReason);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(response.content);
    } catch {
      row.reasons.push('not_json');
    }
    if (response.finishReason !== 'stop') row.reasons.push(`finish:${response.finishReason ?? 'missing'}`);
    if (response.finishReason === 'stop' && parsed !== null && !gradeLight(fixture, parsed))
      row.reasons.push('wrong_answer');
    row.pass = row.reasons.length === 0;
  } catch (error) {
    const classified = classifyError(error);
    row.error = classified.error;
    row.status = classified.status;
    if (classified.detail) row.errorDetail = classified.detail;
    row.reasons.push(`error:${classified.error}`);
    if (pending) {
      budget.settle(pending, null);
      row.usageMissing = true;
      row.unknownCostReservationUsd = pending.usd;
    }
  }
  row.durationMs = performance.now() - started;
  row.roundMs = [row.durationMs];
  return row;
}
