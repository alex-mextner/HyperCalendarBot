// scripts/model-quality/slot.ts
// One provider round exactly as the bot makes it: the production streaming slot builds the request
// (model, sampling, effort field, output ceiling, usage option) and reads the stream, so a measured
// pass is a pass of what production would send, not of a benchmark-only request shape.

import OpenAI from 'openai';
import { type StreamRoundOptions, type StreamRoundResult, streamingSlot } from '../../src/services/ai/streaming.ts';
import { type Candidate, candidateId } from './models.ts';

/** One HTTP attempt, from request to the last chunk. */
export const ATTEMPT_TIMEOUT_MS = 30_000;

type Slot = ReturnType<typeof streamingSlot>;

export function slotFor(candidate: Candidate, getClient: () => OpenAI): Slot {
  return streamingSlot(
    candidateId(candidate),
    candidate.provider,
    getClient,
    candidate.model,
    `qualification:${candidateId(candidate)}`,
    candidate.preset,
  );
}

/** A real client for the candidate's route. Throws when the credential is not in the environment. */
export function clientFor(candidate: Candidate): OpenAI {
  const apiKey = process.env[candidate.keyEnv];
  if (!apiKey) throw new Error('NO_KEY');
  return new OpenAI({
    apiKey,
    baseURL: candidate.baseURL,
    maxRetries: 0,
    timeout: ATTEMPT_TIMEOUT_MS,
    ...(candidate.provider === 'claude' ? { defaultHeaders: { 'anthropic-version': '2023-06-01' } } : {}),
  });
}

export type RoundFn = (
  options: Pick<StreamRoundOptions, 'messages' | 'tools' | 'signal'>,
) => Promise<StreamRoundResult>;

/** The round function the scenario runner calls: production request options, one attempt, no retry. */
export function roundFor(candidate: Candidate, client: OpenAI): RoundFn {
  const slot = slotFor(candidate, () => client);
  return (options) =>
    slot.stream(candidate.model, { ...options, maxTokens: 4096, temperature: 0.3, purpose: 'agent' }, {}, () => {});
}
