import { z } from 'zod';

/** 2 = ready for users; 1 = needs revision; 0 = missing, misleading or unacceptable. */
export const ResponseQualitySchema = z
  .object({
    friendliness: z.number().int().min(0).max(2),
    informativeness: z.number().int().min(0).max(2),
    relevance: z.number().int().min(0).max(2),
    grounding: z.number().int().min(0).max(2),
    notes: z.array(z.string().min(1).max(1000)).max(12),
  })
  .strict();
export type ResponseQuality = z.infer<typeof ResponseQualitySchema>;

export const RESPONSE_QUALITY_RUBRIC = `Independently assess the actual user-facing reply on four axes, each 0,1,2 (2 passes,1 needs revision,0 unacceptable). friendliness: natural conversational wording, not bureaucratic or patronizing; emoji is optional and does not earn a pass. informativeness: answer gives the relevant checked date/calendar, time/title/location if available, exact target and action before a write, or a useful next step when context is missing. relevance: answer the user's question directly without generic tool jargon or unsolicited filler. grounding: only assert what the observed data supports; empty successful search is not a failed read or proof that a person is free. No fabricated calendar reads, changes, delivery, availability or sync. Include quality:{friendliness,informativeness,relevance,grounding,notes} for EVERY comparison; notes explain deficiencies or the evidence for passing. Any score below 2 means revise. For 'Что завтра?' avoid 'Событий в этом диапазоне не найдено'; identify tomorrow and the checked calendar in natural language.`;

interface AssessedReply {
  sampleId: number;
  intentResponse: string;
  quality?: ResponseQuality;
}
/** Mandatory review evidence plus a small deterministic guard for a known bad output. */
export function responseQualityFindings(comparisons: readonly AssessedReply[]): string[] {
  const findings: string[] = [];
  for (const comparison of comparisons) {
    const prefix = `Sample ${comparison.sampleId}`;
    if (!comparison.quality)
      findings.push(`${prefix}: friendliness/informativeness/relevance/grounding review is missing`);
    else
      for (const dimension of ['friendliness', 'informativeness', 'relevance', 'grounding'] as const)
        if (comparison.quality[dimension] < 2) findings.push(`${prefix}: ${dimension} needs revision`);
    if (
      /событий\s+в\s+этом\s+диапазоне\s+не\s+найдено|no\s+events\s+found\s+in\s+this\s+range/i.test(
        comparison.intentResponse,
      )
    )
      findings.push(`${prefix}: generic range wording does not identify the requested date/calendar`);
  }
  return findings;
}
