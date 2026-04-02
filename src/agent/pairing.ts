// src/agent/pairing.ts

import type { ServerWebSocket } from 'bun';
import { jwtVerify, SignJWT } from 'jose';
import { logger } from '../utils/logger.ts';
import type { AgentPairError, AgentPairResponse } from './protocol.ts';
import type { AgentRegistry } from './registry.ts';

const pairingLogger = logger.child({ module: 'agent-pairing' });

export const PAIRING_TTL_MS = 10 * 60 * 1000;

export interface WsData {
  userId: number | null;
  _token?: string | null;
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
      try {
        pending.ws.send(JSON.stringify(msg));
      } catch {
        /* WS already closed */
      }
      pendingConnections.delete(code);
    }
  }, PAIRING_TTL_MS);
}

export async function completePairing(code: string, userId: number, registry: AgentRegistry): Promise<boolean> {
  if (!secret()) {
    pairingLogger.error('completePairing: AGENT_JWT_SECRET not configured');
    return false;
  }
  const pending = pendingConnections.get(code);
  if (!pending || Date.now() > pending.expiresAt) {
    pairingLogger.warn({ code, userId }, 'Pairing failed: code not found or expired');
    pendingConnections.delete(code);
    return false;
  }
  const jwt = await issueAgentJwt(userId);
  pending.ws.data.userId = userId;
  const msg: AgentPairResponse = { type: 'paired', jwt };
  try {
    pending.ws.send(JSON.stringify(msg));
  } catch {
    pairingLogger.warn({ userId, code }, 'Pairing send failed (WS closed)');
    pendingConnections.delete(code);
    return false;
  }
  registry.register(userId, pending.ws);
  pendingConnections.delete(code);
  pairingLogger.info({ userId, code }, 'Agent paired successfully');
  return true;
}

let _jwtSecret: Uint8Array | null = null;

export function initPairingSecret(secret: string): void {
  _jwtSecret = new TextEncoder().encode(secret);
}

function secret(): Uint8Array | null {
  return _jwtSecret;
}

export async function issueAgentJwt(userId: number): Promise<string> {
  const sec = secret();
  if (!sec) throw new Error('AGENT_JWT_SECRET not configured');
  return new SignJWT({ sub: String(userId) })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(sec);
}

export async function verifyAgentJwt(token: string): Promise<number | null> {
  const sec = secret();
  if (!sec) return null;
  try {
    const { payload } = await jwtVerify(token, sec);
    const n = Number(payload.sub);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export async function verifyAgentJwtFull(token: string): Promise<{ userId: number; exp: number } | null> {
  const sec = secret();
  if (!sec) {
    pairingLogger.error('verifyAgentJwtFull: AGENT_JWT_SECRET not configured');
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, sec);
    const n = Number(payload.sub);
    if (!Number.isFinite(n) || typeof payload.exp !== 'number') {
      pairingLogger.warn({ sub: payload.sub }, 'JWT payload invalid (bad sub or missing exp)');
      return null;
    }
    return { userId: n, exp: payload.exp };
  } catch (err) {
    pairingLogger.warn({ err }, 'JWT verification failed');
    return null;
  }
}
