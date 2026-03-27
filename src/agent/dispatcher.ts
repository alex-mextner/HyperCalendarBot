// src/agent/dispatcher.ts
import { randomUUID } from 'node:crypto';
import type { AgentCommand, AgentDoneResponse, AgentResponse } from './protocol.ts';
import { type AgentRegistry, agentRegistry } from './registry.ts';

type ChunkHandler = (text: string) => void;

interface PendingCommand {
  userId: number;
  resolve: (result: { data: AgentDoneResponse['data']; exitCode?: number }) => void;
  reject: (err: Error) => void;
  onChunk?: ChunkHandler;
}

export class AgentDispatcher {
  private pending = new Map<string, PendingCommand>();

  constructor(private registry: AgentRegistry) {}

  send(
    userId: number,
    type: AgentCommand['type'],
    payload: AgentCommand['payload'],
    onChunk?: ChunkHandler,
    timeoutMs = 120_000,
  ): Promise<{ data: AgentDoneResponse['data']; exitCode?: number }> {
    const conn = this.registry.get(userId);
    if (!conn) return Promise.reject(new Error('Agent not connected'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Agent command timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, {
        userId,
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        onChunk,
      });
      conn.ws.send(JSON.stringify({ id, type, payload }));
    });
  }

  handleResponse(msg: AgentResponse): void {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    if (msg.type === 'chunk') {
      pending.onChunk?.(msg.text);
      return;
    }
    this.pending.delete(msg.id);
    if (msg.type === 'done') pending.resolve({ data: msg.data, exitCode: msg.exitCode });
    else pending.reject(new Error(msg.error));
  }

  rejectPendingForUser(userId: number, err: Error): void {
    for (const [id, pending] of this.pending) {
      if (pending.userId === userId) {
        this.pending.delete(id);
        pending.reject(err);
      }
    }
  }
}

export const agentDispatcher = new AgentDispatcher(agentRegistry);
