// src/agent/protocol.ts
import { z } from 'zod';

export interface AgentPairRequest {
  type: 'pair';
  code: string;
}
export interface AgentPairResponse {
  type: 'paired';
  jwt: string;
}
export interface AgentPairError {
  type: 'pair_error';
  reason: 'expired' | 'invalid';
}

/** Playwright action params — each action has its own known shape. */
interface PlaywrightNavigateParams {
  url: string;
}
interface PlaywrightClickParams {
  selector: string;
}
interface PlaywrightFillParams {
  selector: string;
  value: string;
}
interface PlaywrightExtractParams {
  selector: string;
}
interface PlaywrightEvaluateParams {
  expression: string;
}

type PlaywrightParams =
  | PlaywrightNavigateParams
  | PlaywrightClickParams
  | PlaywrightFillParams
  | PlaywrightExtractParams
  | PlaywrightEvaluateParams
  | Record<never, never>; // screenshot — no params

export type AgentCommand =
  | { id: string; type: 'claude_chat'; payload: { chat_id: string; message: string; timeout_ms?: number } }
  | { id: string; type: 'claude_new_chat'; payload: { message: string; project_id?: string; timeout_ms?: number } }
  | { id: string; type: 'claude_list_chats'; payload: { limit?: number } }
  | { id: string; type: 'claude_open_chat'; payload: { chat_id: string } }
  | { id: string; type: 'claude_list_projects'; payload: Record<never, never> }
  | { id: string; type: 'claude_artifact'; payload: { artifact_id: string } }
  | { id: string; type: 'bash_execute'; payload: { command: string; timeout_ms?: number } }
  | {
      id: string;
      type: 'playwright_action';
      payload: {
        action: 'screenshot' | 'navigate' | 'click' | 'fill' | 'extract' | 'evaluate';
        params: PlaywrightParams;
        timeout_ms?: number;
      };
    }
  | { id: string; type: 'applescript_run'; payload: { script: string; timeout_ms?: number } };

export interface AgentResponse {
  id: string;
  type: 'chunk' | 'done' | 'error';
  text?: string;
  /** Structured data from agent — JSON-safe primitives, arrays, or objects. */
  data?: string | number | boolean | null;
  exitCode?: number;
  error?: string;
}

export interface AgentPing {
  type: 'ping';
}
export interface AgentPong {
  type: 'pong';
}
export interface AgentCancel {
  type: 'cancel';
  id: string;
}
export interface AgentTokenRefreshed {
  type: 'token_refreshed';
  jwt: string;
}

/** Zod schema for validating inbound WebSocket messages from the agent. */
export const AgentInboundSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pair'), code: z.string() }),
  z.object({
    type: z.literal('chunk'),
    id: z.string(),
    text: z.string().optional(),
    data: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
  }),
  z.object({
    type: z.literal('done'),
    id: z.string(),
    text: z.string().optional(),
    data: z.union([z.string(), z.number(), z.boolean(), z.null()]).optional(),
    exitCode: z.number().optional(),
  }),
  z.object({
    type: z.literal('error'),
    id: z.string(),
    error: z.string().optional(),
  }),
  z.object({ type: z.literal('ping') }),
]);

export type AgentInbound = z.infer<typeof AgentInboundSchema>;
export type AgentOutbound =
  | AgentPairResponse
  | AgentPairError
  | AgentCommand
  | AgentPong
  | AgentCancel
  | AgentTokenRefreshed;
