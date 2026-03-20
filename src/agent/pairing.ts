// src/agent/pairing.ts

import type { ServerWebSocket } from 'bun';
import { jwtVerify, SignJWT } from 'jose';
import type { AgentPairError, AgentPairResponse } from './protocol.ts';
import type { AgentRegistry } from './registry.ts';

const PAIRING_TTL_MS = 10 * 60 * 1000;

export interface WsData {
  userId: number | null;
}

interface PendingConnection {
  ws: ServerWebSocket<WsData>;
  expiresAt: number;
}

const pendingConnections = new Map<string, PendingConnection>();

export function generatePairingCode(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const rand = (n: number) =>
    Array.from(crypto.getRandomValues(new Uint8Array(n)))
      .map((b) => chars[b % chars.length])
      .join('');
  return `${rand(4)}-${rand(4)}`;
}

export function registerPendingConnection(code: string, ws: ServerWebSocket<WsData>): void {
  pendingConnections.set(code, { ws, expiresAt: Date.now() + PAIRING_TTL_MS });
  setTimeout(() => {
    const pending = pendingConnections.get(code);
    if (pending) {
      const msg: AgentPairError = { type: 'pair_error', reason: 'expired' };
      pending.ws.send(JSON.stringify(msg));
      pendingConnections.delete(code);
    }
  }, PAIRING_TTL_MS);
}

export async function completePairing(code: string, userId: number, registry: AgentRegistry): Promise<boolean> {
  const pending = pendingConnections.get(code);
  if (!pending || Date.now() > pending.expiresAt) {
    pendingConnections.delete(code);
    return false;
  }
  const jwt = await issueAgentJwt(userId);
  pending.ws.data.userId = userId;
  const msg: AgentPairResponse = { type: 'paired', jwt };
  pending.ws.send(JSON.stringify(msg));
  registry.register(userId, pending.ws);
  pendingConnections.delete(code);
  return true;
}

function secret(): Uint8Array {
  const s = process.env.AGENT_JWT_SECRET;
  if (!s) throw new Error('AGENT_JWT_SECRET not set');
  return new TextEncoder().encode(s);
}

export async function issueAgentJwt(userId: number): Promise<string> {
  return new SignJWT({ sub: String(userId) })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1y')
    .sign(secret());
}

export async function verifyAgentJwt(token: string): Promise<number | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    const n = Number(payload.sub);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
