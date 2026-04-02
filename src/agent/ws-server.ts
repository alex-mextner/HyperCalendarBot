// src/agent/ws-server.ts
import type { ServerWebSocket } from 'bun';
import { jsonCodec } from '../utils/json-codec.ts';
import { logger } from '../utils/logger.ts';
import type { AgentDispatcher } from './dispatcher.ts';
import { issueAgentJwt, registerPendingConnection, verifyAgentJwtFull, type WsData } from './pairing.ts';
import { AgentInboundSchema, type AgentTokenRefreshed } from './protocol.ts';
import type { AgentRegistry } from './registry.ts';

const agentLogger = logger.child({ module: 'agent-ws' });

const AgentInboundCodec = jsonCodec(AgentInboundSchema);

const REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export function upgradeAgentWs(
  req: Request,
  server: { upgrade(req: Request, opts: { data: WsData }): boolean },
): boolean {
  const token = req.headers.get('authorization')?.replace('Bearer ', '') ?? null;
  agentLogger.debug({ hasToken: !!token }, 'Agent WebSocket upgrade');
  return server.upgrade(req, { data: { userId: null, _token: token } });
}

export function createAgentWsHandler(registry: AgentRegistry, dispatcher: AgentDispatcher) {
  return {
    async open(ws: ServerWebSocket<WsData>) {
      if (ws.data._token) {
        const result = await verifyAgentJwtFull(ws.data._token);
        if (!result) {
          agentLogger.warn('Agent WebSocket: JWT invalid, closing');
          ws.close(4001, 'JWT invalid');
          return;
        }
        ws.data.userId = result.userId;
        registry.register(result.userId, ws);
        agentLogger.info({ userId: result.userId }, 'Agent connected');

        // Proactively refresh JWT if it expires within 7 days
        if (result.exp * 1000 - Date.now() < REFRESH_THRESHOLD_MS) {
          const newJwt = await issueAgentJwt(result.userId);
          const msg: AgentTokenRefreshed = { type: 'token_refreshed', jwt: newJwt };
          try {
            ws.send(JSON.stringify(msg));
            agentLogger.info({ userId: result.userId }, 'Agent JWT refreshed proactively');
          } catch {
            agentLogger.warn({ userId: result.userId }, 'JWT refresh send failed (WS closed)');
          }
        }
      } else {
        agentLogger.info('Agent WebSocket: no JWT, pairing window open (30s)');
        // No JWT — allow pairing window, then close if still unauthenticated
        setTimeout(() => {
          if (ws.data.userId === null && typeof ws.close === 'function') {
            agentLogger.warn('Agent WebSocket: pairing timeout, closing');
            ws.close(4002, 'Authentication timeout');
          }
        }, 30_000);
      }
    },

    message(ws: ServerWebSocket<WsData>, raw: string) {
      const result = AgentInboundCodec.safeParse(raw);
      if (!result.success) {
        agentLogger.warn({ userId: ws.data.userId, raw: raw.slice(0, 100) }, 'Agent message parse failed');
        return;
      }
      const msg = result.data;

      if (msg.type === 'ping') {
        if (ws.data.userId) registry.updatePing(ws.data.userId);
        try {
          ws.send(JSON.stringify({ type: 'pong' }));
        } catch {
          /* WS closed between message and pong */
        }
        return;
      }

      if (msg.type === 'pair') {
        agentLogger.info({ code: msg.code }, 'Agent pairing request');
        registerPendingConnection(msg.code, ws);
        return;
      }

      if (msg.type === 'chunk' || msg.type === 'done' || msg.type === 'error') {
        agentLogger.debug({ userId: ws.data.userId, type: msg.type, id: msg.id }, 'Agent response');
        dispatcher.handleResponse(msg);
      }
    },

    close(ws: ServerWebSocket<WsData>) {
      if (ws.data.userId) {
        const current = registry.get(ws.data.userId);
        if (current?.ws === ws) {
          agentLogger.info({ userId: ws.data.userId }, 'Agent disconnected');
          dispatcher.rejectPendingForUser(ws.data.userId, new Error('Agent disconnected'));
          registry.unregister(ws.data.userId);
        } else {
          agentLogger.debug({ userId: ws.data.userId }, 'Agent WS closed but already replaced — skipping unregister');
        }
      } else {
        agentLogger.debug('Agent WebSocket closed (was not authenticated)');
      }
    },
  };
}
