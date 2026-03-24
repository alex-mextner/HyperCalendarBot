// src/services/ai/debug-logger.ts
// Full conversation debug logger. Enabled via AI_DEBUG_LOGS=true.
// Writes to logs/chats/{chatId}/{YYYY-MM-DD_HH-MM-SS}.log — one file per dialog session.
// A new session starts after SESSION_TIMEOUT_MS of inactivity or when end_conversation is called.

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';

const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 min idle → new file

type ContentBlock = Anthropic.ContentBlockParam;

function serializeContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((b) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'tool_use') return `[tool_use: ${b.name} | input: ${JSON.stringify(b.input).slice(0, 200)}]`;
      if (b.type === 'tool_result') {
        const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        return `[tool_result${b.is_error ? ' ERROR' : ''}: ${c.slice(0, 300)}]`;
      }
      return `[${b.type}]`;
    })
    .join(' ');
}

export interface DebugMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
  created_at?: string;
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
      const ts = msg.created_at ? ` | ${msg.created_at}` : '';
      const text = serializeContent(msg.content);
      this.parts.push(`[${msg.role}${ts}]`);
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
