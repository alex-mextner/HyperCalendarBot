// src/agent/dispatcher.ts
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.ts';
import type { AgentCommand, AgentDoneResponse, AgentResponse } from './protocol.ts';
import { type AgentRegistry, agentRegistry } from './registry.ts';

const dispatchLogger = logger.child({ module: 'agent-dispatch' });

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
    if (!conn) {
      dispatchLogger.warn({ userId, type }, 'Agent command dropped: not connected');
      return Promise.reject(new Error('Agent not connected'));
    }
    const id = randomUUID();
    dispatchLogger.info({ userId, type, id }, 'Agent command sent');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        dispatchLogger.warn({ userId, type, id, timeoutMs }, 'Agent command timed out');
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
    if (!pending) {
      dispatchLogger.warn({ type: msg.type, id: msg.id }, 'Agent response for unknown command (already timed out?)');
      return;
    }
    if (msg.type === 'chunk') {
      pending.onChunk?.(msg.text);
      return;
    }
    this.pending.delete(msg.id);
    if (msg.type === 'done') {
      dispatchLogger.debug({ userId: pending.userId, id: msg.id }, 'Agent command done');
      pending.resolve({ data: msg.data, exitCode: msg.exitCode });
    } else {
      dispatchLogger.warn({ userId: pending.userId, id: msg.id, error: msg.error }, 'Agent command error');
      pending.reject(new Error(msg.error));
    }
  }

  rejectPendingForUser(userId: number, err: Error): void {
    let count = 0;
    for (const [id, pending] of this.pending) {
      if (pending.userId === userId) {
        this.pending.delete(id);
        pending.reject(err);
        count++;
      }
    }
    if (count > 0) {
      dispatchLogger.warn({ userId, count, err: err.message }, 'Rejected pending commands due to disconnect');
    }
  }
}

export const agentDispatcher = new AgentDispatcher(agentRegistry);
