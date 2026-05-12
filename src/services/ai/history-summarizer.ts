import type OpenAI from 'openai';
import { logger } from '../../utils/logger.ts';
import { estimateMessageListTokens } from '../../utils/token-estimate.ts';
import type { StreamRoundOptions, StreamRoundResult } from './streaming.ts';

const histLogger = logger.child({ module: 'history-summarizer' });

export const PER_MSG_CHARS_LIMIT = 600;
export const HISTORY_TOKEN_BUDGET = 6000;
const SUMMARY_CACHE_TTL_SECS = 86400;
const RECENT_KEEP = 5;

type MessageParam = OpenAI.ChatCompletionMessageParam;
type StreamFn = (opts: StreamRoundOptions, callbacks: Record<string, unknown>) => Promise<StreamRoundResult>;

interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, exMode?: string, ttl?: string): Promise<unknown>;
}

const perMsgCacheKey = (id: number) => `hist:sum:msg:${id}`;

export class HistorySummarizer {
  constructor(
    private redis: RedisLike | null,
    private streamFn: StreamFn,
  ) {}

  async condenseMessage(rowId: number, role: string, content: string): Promise<string> {
    if (content.length <= PER_MSG_CHARS_LIMIT) return content;

    const cacheKey = perMsgCacheKey(rowId);
    if (this.redis) {
      const cached = await this.redis.get(cacheKey).catch(() => null);
      if (cached) return cached;
    }

    try {
      const result = await this.streamFn(
        {
          messages: [
            {
              role: 'user',
              content:
                `Summarize this ${role} message from a calendar bot conversation in 1-3 sentences. ` +
                `Keep all key facts: event names, times, dates, IDs, error messages. Reply with the summary only.\n\n` +
                content.slice(0, 3000),
            },
          ],
          maxTokens: 256,
          temperature: 0,
          fast: true,
        },
        {},
      );

      const summary = result.text.trim();

      if (this.redis) {
        await this.redis
          .set(cacheKey, summary, 'EX', String(SUMMARY_CACHE_TTL_SECS))
          .catch((err) => histLogger.warn({ err }, 'Redis set failed for per-message summary'));
      }

      return summary;
    } catch (err) {
      histLogger.warn({ err, rowId }, 'Per-message summarization failed — truncating');
      return `${content.slice(0, PER_MSG_CHARS_LIMIT)}[…]`;
    }
  }

  async condenseHistory(messages: MessageParam[]): Promise<MessageParam[]> {
    const total = estimateMessageListTokens(messages);
    if (total <= HISTORY_TOKEN_BUDGET) return messages;

    histLogger.info({ total, budget: HISTORY_TOKEN_BUDGET }, 'History over token budget — condensing');

    if (messages.length <= RECENT_KEEP) return messages;

    const older = messages.slice(0, messages.length - RECENT_KEEP);
    const recent = messages.slice(messages.length - RECENT_KEEP);

    const olderText = older
      .map((m) => {
        const content = typeof m.content === 'string' ? m.content.slice(0, 300) : '[structured message]';
        return `[${m.role}]: ${content}`;
      })
      .join('\n');

    try {
      const result = await this.streamFn(
        {
          messages: [
            {
              role: 'user',
              content:
                `Summarize this older portion of a calendar bot conversation in 3-6 bullet points. ` +
                `Preserve all event names, dates, times, IDs, user preferences, and decisions made. ` +
                `Reply with bullet points only.\n\n` +
                olderText.slice(0, 4000),
            },
          ],
          maxTokens: 400,
          temperature: 0,
          fast: true,
        },
        {},
      );

      const summary = result.text.trim();
      const summaryMsg: MessageParam = {
        role: 'user',
        content: `[Earlier conversation summary]\n${summary}`,
      };

      return [summaryMsg, ...recent];
    } catch (err) {
      histLogger.warn({ err }, 'Full-history summarization failed — keeping recent messages only');
      return recent;
    }
  }
}
