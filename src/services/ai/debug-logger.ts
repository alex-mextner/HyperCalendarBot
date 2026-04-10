// src/services/ai/debug-logger.ts
// Full conversation debug logger. Enabled via AI_DEBUG_LOGS=true.
// Writes to logs/chats/{chatId}/{YYYY-MM-DD_HH-MM-SS}.log — one file per dialog session.
// A new session starts after SESSION_TIMEOUT_MS of inactivity or when end_conversation is called.

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type OpenAI from 'openai';

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 min idle → new file

export type DebugMessage = OpenAI.ChatCompletionMessageParam;

function serializeMessage(msg: DebugMessage): string {
  // Assistant message with tool_calls — render each call as a compact marker.
  // Check this BEFORE the content-is-string short-circuit, because an
  // assistant turn that only calls tools has content='' (or null) and would
  // otherwise lose the tool-call info from the debug log.
  if (msg.role === 'assistant' && 'tool_calls' in msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    const toolParts = msg.tool_calls.map((tc) => {
      if (tc.type !== 'function') return `[${tc.type}]`;
      return `[tool_use: ${tc.function.name} | input: ${tc.function.arguments.slice(0, 200)}]`;
    });
    const textPart = typeof msg.content === 'string' && msg.content.length > 0 ? `${msg.content} ` : '';
    return `${textPart}${toolParts.join(' ')}`;
  }

  // Plain-text content on user/assistant/system/developer messages
  if (typeof msg.content === 'string') return msg.content;

  // Structured content parts (array form) — pick out text and stringify the rest
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((part) => {
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
          return part.text;
        }
        if (part && typeof part === 'object' && 'type' in part && typeof part.type === 'string') {
          return `[${part.type}]`;
        }
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }

  // Tool role with a non-string content — safely coerce
  if (msg.role === 'tool') return `[tool_result: ${String(msg.content).slice(0, 300)}]`;

  return JSON.stringify(msg).slice(0, 500);
}

export class AiDebugRunContext {
  private parts: string[] = [];

  constructor(
    private readonly file: string,
    userId: number,
    chatId: number,
    username: string | null | undefined,
    firstName: string | null | undefined,
    groupTitle: string | null | undefined,
    supplementMode: boolean,
    messageText: string,
    supplementAutoResponse?: string,
  ) {
    const ts = new Date().toISOString();
    const userLabel = [`uid:${userId}`, username ? `@${username}` : null, firstName ?? null].filter(Boolean).join(' ');
    const chatLabel = groupTitle ? `${chatId} "${groupTitle}"` : String(chatId);

    this.parts.push('');
    this.parts.push('='.repeat(80));
    this.parts.push(`[${ts}]`);
    this.parts.push(`CHAT: ${chatLabel} | USER: ${userLabel}`);
    this.parts.push(`SUPPLEMENT: ${supplementMode}`);
    this.parts.push(`MESSAGE: ${messageText}`);
    if (supplementMode && supplementAutoResponse) {
      this.parts.push('');
      this.parts.push('## AUTO-RESPONSE (the message supplement is evaluating)');
      this.parts.push(supplementAutoResponse);
      this.parts.push('## END AUTO-RESPONSE');
    }
    this.parts.push('='.repeat(80));
  }

  logSystemPrompt(prompt: string): void {
    this.parts.push('');
    this.parts.push('## SYSTEM PROMPT');
    this.parts.push(prompt);
    this.parts.push('## END SYSTEM PROMPT');
  }

  logHistory(messages: DebugMessage[]): void {
    this.parts.push('');
    this.parts.push(`## HISTORY [${messages.length} messages]`);
    for (const msg of messages) {
      const text = serializeMessage(msg);
      this.parts.push(`[${msg.role}]`);
      this.parts.push(text.slice(0, 500));
    }
    this.parts.push('## END HISTORY');
  }

  logRound(round: number): void {
    this.parts.push('');
    this.parts.push(`## ROUND ${round + 1}`);
  }

  logToolCall(name: string, input: { [key: string]: unknown }): void {
    this.parts.push(`TOOL CALL: ${name}`);
    this.parts.push(
      JSON.stringify(input, null, 2)
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n'),
    );
  }

  logToolResult(name: string, success: boolean, output?: string, error?: string): void {
    const status = success ? 'OK' : 'ERROR';
    const body = (output ?? error ?? '').slice(0, 400);
    this.parts.push(`TOOL RESULT: ${name} → ${status}`);
    this.parts.push(`  ${body}`);
  }

  logAiText(text: string): void {
    if (!text.trim()) return;
    this.parts.push('AI TEXT:');
    this.parts.push(
      text
        .slice(0, 600)
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n'),
    );
  }

  logFinal(responseText: string, toolCount: number): void {
    this.parts.push('');
    this.parts.push('## FINAL');
    this.parts.push(`Tools called: ${toolCount}`);
    this.parts.push(`Response (${responseText.length} chars):`);
    this.parts.push(
      responseText
        .slice(0, 600)
        .split('\n')
        .map((l) => `  ${l}`)
        .join('\n'),
    );
    this.parts.push('='.repeat(80));
  }

  flush(): void {
    try {
      appendFileSync(this.file, `${this.parts.join('\n')}\n`);
    } catch {
      // Debug logging is non-critical — write failures must not crash the agent
    }
  }
}

interface SessionEntry {
  file: string;
  lastActivity: number;
}

export class AiDebugLogger {
  private sessions = new Map<number, SessionEntry>();

  constructor(
    private readonly enabled: boolean,
    private readonly logsDir: string,
  ) {}

  /** Explicitly end the session for a chat (called by end_conversation tool). */
  endSession(chatId: number): void {
    this.sessions.delete(chatId);
  }

  private getSessionFile(chatId: number): string {
    const now = Date.now();
    const existing = this.sessions.get(chatId);

    if (existing && now - existing.lastActivity < SESSION_TIMEOUT_MS) {
      existing.lastActivity = now;
      return existing.file;
    }

    // New session — create a new timestamped file
    const dir = path.join(this.logsDir, 'chats', String(chatId));
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Non-critical — proceed with whatever file path was computed
    }

    const ts = new Date().toISOString().replace('T', '_').replace(/:/g, '-').slice(0, 19); // YYYY-MM-DD_HH-MM-SS
    const file = path.join(dir, `${ts}.log`);

    this.sessions.set(chatId, { file, lastActivity: now });
    return file;
  }

  createRunContext(
    userId: number,
    chatId: number,
    username: string | null | undefined,
    firstName: string | null | undefined,
    groupTitle: string | null | undefined,
    supplementMode: boolean,
    messageText: string,
    supplementAutoResponse?: string,
  ): AiDebugRunContext | null {
    if (!this.enabled) return null;

    const file = this.getSessionFile(chatId);
    return new AiDebugRunContext(
      file,
      userId,
      chatId,
      username,
      firstName,
      groupTitle,
      supplementMode,
      messageText,
      supplementAutoResponse,
    );
  }
}
