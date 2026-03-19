// src/services/voice/interruption-classifier.ts

export type InterruptionDecision = 'noise' | 'resume' | 'respond';

const RESUME_WORDS = new Set([
  // Russian
  'да',
  'нет',
  'угу',
  'ага',
  'ок',
  'хорошо',
  'понятно',
  'ясно',
  'продолжай',
  'давай',
  // English
  'yes',
  'no',
  'ok',
  'okay',
  'yeah',
  'yep',
  'mhm',
  'sure',
  'got',
]);

/**
 * Classifies an interim STT transcript as noise, resume, or respond.
 * Called when the user speaks during active bot audio playback.
 * VAD_END → always 'respond' (handled in CallSession, not here).
 */
export function classifyInterrupt(transcript: string): InterruptionDecision {
  const words = transcript.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return 'noise';
  if (words.length === 1 && !RESUME_WORDS.has(words[0]!)) return 'noise';
  if (words.length <= 2 && words.every((w) => RESUME_WORDS.has(w))) return 'resume';
  return 'respond';
}
