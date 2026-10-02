export function canEndConversation(
  text: string,
  options: { explicit: boolean; lastTool: boolean; supplement: boolean },
): boolean {
  if (!options.lastTool) return false;
  if (options.supplement || !options.explicit) return true;
  const answer = text.trim();
  return answer.length > 0 && !/^[.\s…]+$/.test(answer) && answer !== '[SKIP]';
}
