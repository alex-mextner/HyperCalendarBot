// src/agent/dispatcher.ts
import { randomUUID } from 'node:crypto';
import type { AgentCommand, AgentResponse } from './protocol.ts';
import type { AgentRegistry } from './registry.ts';

type ChunkHandler = (text: string) => void;

interface PendingCommand {
  resolve: (result: { data: unknown; exitCode?: number }) => void;
  reject: (err: Error) => void;
  onChunk?: ChunkHandler;
}

export class AgentDispatcher {
  private pending = new Map<string, PendingCommand>();

  constructor(private registry: AgentRegistry) {}

  send(
    userId: number,
    type: AgentCommand['type'],
    payload: Record<string, unknown>,
    onChunk?: ChunkHandler,
  ): Promise<{ data: unknown; exitCode?: number }> {
    const conn = this.registry.get(userId);
    if (!conn) return Promise.reject(new Error('Agent not connected'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onChunk });
      conn.ws.send(JSON.stringify({ id, type, payload } satisfies AgentCommand));
    });
  }

  handleResponse(msg: AgentResponse): void {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    if (msg.type === 'chunk') {
      pending.onChunk?.(msg.text ?? '');
      return;
    }
    this.pending.delete(msg.id);
    if (msg.type === 'done') pending.resolve({ data: msg.data, exitCode: msg.exitCode });
    else pending.reject(new Error(msg.error ?? 'Agent error'));
  }
}
