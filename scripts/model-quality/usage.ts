export function billedOutputUpperEstimate(prompt: number, completion: number, total: number): number {
  return Math.max(completion, total - prompt, 0);
}
