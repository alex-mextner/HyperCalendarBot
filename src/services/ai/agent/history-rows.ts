// Turns stored chat_history rows (current and legacy formats) back into model messages.
import { TZDate } from '@date-fns/tz';
import { format } from 'date-fns';
import { z } from 'zod';
import type { ChatHistoryMessage } from '../../../database/types.ts';
import { jsonCodec } from '../../../utils/json-codec.ts';
import { type ActivityEvent, formatActivityEvent } from '../activity-event.ts';
import type { MessageParam } from './message-sanitizer.ts';

function withTimestamp(text: string, createdAt: string, timezone: string): string {
  const local = format(new TZDate(new Date(`${createdAt}Z`), timezone), 'yyyy-MM-dd HH:mm:ss');
  return `[${local}] ${text}`;
}

/** Plain-text fallback for group-chat sender attribution. */
/**
 * Exported so the system prompt's description of this prefix can be pinned to
 * what it actually produces: the prompt used to tell the model to look for
 * "[Group: name, From: sender]", which nothing has ever written.
 */
export function tagSender(content: string, name: string, userId: number): string {
  const senderTag = `[From: ${name} (id:${userId})] `;
  const tsPattern = /^(\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] )/;
  return tsPattern.test(content) ? content.replace(tsPattern, `$1${senderTag}`) : `${senderTag}${content}`;
}

/**
 * Schema for parsing stored OpenAI-format assistant turns back out of chat_history.
 * The writer serializes via JSON.stringify on the full assistant message; this
 * schema validates the minimum shape we need on the way back in.
 */
const StoredAssistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.string().nullable().optional(),
  tool_calls: z
    .array(
      z.object({
        id: z.string(),
        type: z.literal('function'),
        function: z.object({
          name: z.string(),
          arguments: z.string(),
        }),
      }),
    )
    .optional(),
});

const StoredToolResultArraySchema = z.array(
  z.object({
    role: z.literal('tool'),
    tool_call_id: z.string(),
    content: z.string(),
  }),
);

/**
 * Legacy Anthropic assistant turn — an array of content blocks with a `type`
 * field. Pre-migration history rows use this shape. We flatten them into plain
 * text so existing conversation context survives the SDK swap.
 */
const LegacyAnthropicContentBlocksSchema = z.array(z.object({ type: z.string() }).passthrough());

export const AssistantMessageCodec = jsonCodec(StoredAssistantMessageSchema);
const ToolResultsCodec = jsonCodec(StoredToolResultArraySchema);
const LegacyAnthropicContentBlocksCodec = jsonCodec(LegacyAnthropicContentBlocksSchema);
const ActivityEventCodec = jsonCodec(z.object({ kind: z.string() }).passthrough());

/** Extract a best-effort plain-text summary from a legacy Anthropic content-block array. */
function flattenLegacyContentBlocks(blocks: { type: string; [key: string]: unknown }[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      parts.push(`[tool_use: ${block.name}]`);
    } else if (block.type === 'tool_result') {
      const content =
        typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content
                .map((p) => (p && typeof p === 'object' && 'text' in p ? String(p.text) : ''))
                .filter(Boolean)
                .join(' ')
            : '';
      parts.push(`[tool_result: ${content.slice(0, 300)}]`);
    }
  }
  return parts.join(' ').trim();
}

/**
 * Parse the content column of a chat_history row into zero or more OpenAI
 * messages. Handles three formats:
 *  1. OpenAI assistant turn (JSON of a single assistant message)
 *  2. OpenAI tool results (JSON array of tool-role messages)
 *  3. Activity event (JSON { kind: ... }) — rendered to a single flat string
 *  4. Plain text fallback — rendered with a timestamp prefix
 */
export function parseHistoryRow(msg: ChatHistoryMessage, timezone: string): MessageParam[] {
  if (msg.role === 'assistant') {
    const parsed = AssistantMessageCodec.safeParse(msg.content);
    if (parsed.success) {
      return [parsed.data];
    }
    // Legacy Anthropic content-blocks — flatten to plain-text assistant turn
    // so existing conversation context survives the SDK swap.
    const legacy = LegacyAnthropicContentBlocksCodec.safeParse(msg.content);
    if (legacy.success) {
      const flat = flattenLegacyContentBlocks(legacy.data as { type: string; [key: string]: unknown }[]);
      if (flat) {
        return [
          {
            role: 'assistant',
            content: withTimestamp(flat, msg.created_at, timezone),
          },
        ];
      }
      return [];
    }
    // Activity event (bot reply / edit) — render to a readable text line.
    const activity = ActivityEventCodec.safeParse(msg.content);
    if (activity.success) {
      return [
        {
          role: 'assistant',
          content: withTimestamp(formatActivityEvent(activity.data as ActivityEvent), msg.created_at, timezone),
        },
      ];
    }
    return [
      {
        role: 'assistant',
        content: withTimestamp(msg.content, msg.created_at, timezone),
      },
    ];
  }

  if (msg.role === 'tool') {
    const parsed = ToolResultsCodec.safeParse(msg.content);
    if (parsed.success) {
      return parsed.data;
    }
    // Legacy Anthropic tool_result blocks — drop; they cannot be mapped to
    // OpenAI without tool_call_ids and the stale ones won't match anything anyway.
    return [];
  }

  // role === 'user'
  const activity = ActivityEventCodec.safeParse(msg.content);
  if (activity.success) {
    return [
      {
        role: 'user',
        content: withTimestamp(formatActivityEvent(activity.data as ActivityEvent), msg.created_at, timezone),
      },
    ];
  }
  return [
    {
      role: 'user',
      content: withTimestamp(msg.content, msg.created_at, timezone),
    },
  ];
}
