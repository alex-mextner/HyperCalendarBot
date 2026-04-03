// src/services/nli/nli-classifier.ts
import { cmdLogger } from '../../utils/logger.ts';

const HF_API_URL = 'https://api-inference.huggingface.co/models/joeddav/xlm-roberta-large-xnli';
const REQUEST_TIMEOUT_MS = 3000;

const CANDIDATE_LABELS = ['calendar scheduling reminder event meeting', 'general conversation chat smalltalk'];

interface HfClassificationResult {
  sequence: string;
  labels: string[];
  scores: number[];
}

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

      const result = (await response.json()) as HfClassificationResult;

      if (!result.labels || !result.scores || result.labels.length < 2) {
        cmdLogger.warn({ result, text: text.slice(0, 80) }, 'NLI API unexpected response shape');
        return true; // fail open
      }

      const calendarIdx = result.labels.indexOf(CANDIDATE_LABELS[0]!);
      const calendarScore = calendarIdx >= 0 ? result.scores[calendarIdx]! : 0;

      cmdLogger.debug({ text: text.slice(0, 80), calendarScore }, 'NLI classification result');

      return calendarScore >= 0.4;
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
