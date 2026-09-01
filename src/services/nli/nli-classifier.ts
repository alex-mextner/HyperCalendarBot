// src/services/nli/nli-classifier.ts
import { z } from 'zod';
import { cmdLogger } from '../../utils/logger.ts';

// HuggingFace retired the `api-inference.huggingface.co` host — it no longer
// resolves in DNS. Requests failed instantly and, because this classifier fails
// open, the group-chat filter stopped filtering: every group message reached the
// AI. Inference now goes through the router.
const HF_API_URL = 'https://router.huggingface.co/hf-inference/models/joeddav/xlm-roberta-large-xnli';
const REQUEST_TIMEOUT_MS = 3000;
const CALENDAR_CONFIDENCE_THRESHOLD = 0.4;

const CALENDAR_LABEL = 'calendar scheduling reminder event meeting';
const CANDIDATE_LABELS = [CALENDAR_LABEL, 'general conversation chat smalltalk'];

const HfClassificationSchema = z.object({
  sequence: z.string(),
  labels: z.array(z.string()).min(2),
  scores: z.array(z.number()).min(2),
});

export class NliClassifier {
  private token: string;

  constructor(hfToken: string) {
    this.token = hfToken;
  }

  /**
   * Returns true if the text is likely calendar/scheduling-related.
   * Fails open: returns true on any error or timeout (let the AI decide).
   */
  async isCalendarRelated(text: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const response = await fetch(HF_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          inputs: text,
          parameters: { candidate_labels: CANDIDATE_LABELS },
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        cmdLogger.warn({ status: response.status, text: text.slice(0, 80) }, 'NLI API returned non-OK status');
        return true; // fail open
      }

      const parsed = HfClassificationSchema.safeParse(await response.json());
      if (!parsed.success) {
        cmdLogger.warn({ err: parsed.error, text: text.slice(0, 80) }, 'NLI API unexpected response shape');
        return true; // fail open
      }

      const result = parsed.data;
      const calendarIdx = result.labels.indexOf(CALENDAR_LABEL);
      const calendarScore = calendarIdx >= 0 ? result.scores[calendarIdx]! : 0;

      cmdLogger.debug({ text: text.slice(0, 80), calendarScore }, 'NLI classification result');

      return calendarScore >= CALENDAR_CONFIDENCE_THRESHOLD;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        cmdLogger.debug({ text: text.slice(0, 80) }, 'NLI classification timed out — fail open');
      } else {
        cmdLogger.warn({ err, text: text.slice(0, 80) }, 'NLI classification failed — fail open');
      }
      return true; // fail open
    }
  }
}
