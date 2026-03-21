import { applescriptRun } from './actions/applescript.ts';
import { bashExecute } from './actions/bash.ts';
import { claudeChat, getOrgId, listChats, listProjects } from './actions/claude-bridge.ts';
import type { AgentCommand, AgentResponse } from './protocol.ts';

type SendResponse = (resp: AgentResponse) => void;

export async function dispatch(cmd: AgentCommand, sendResponse: SendResponse): Promise<void> {
  const { id, type, payload } = cmd;

  try {
    switch (type) {
      case 'bash_execute': {
        const command = payload.command as string;
        const timeoutMs = typeof payload.timeout_ms === 'number' ? payload.timeout_ms : 60_000;
        const result = await bashExecute(command, timeoutMs);
        sendResponse({
          id,
          type: 'done',
          data: { stdout: result.stdout, stderr: result.stderr },
          exitCode: result.exitCode,
        });
        break;
      }

      case 'applescript_run': {
        const script = payload.script as string;
        const timeoutMs = typeof payload.timeout_ms === 'number' ? payload.timeout_ms : 30_000;
        const result = await applescriptRun(script, timeoutMs);
        sendResponse({
          id,
          type: 'done',
          data: { output: result.output },
          exitCode: result.exitCode,
        });
        break;
      }

      case 'claude_chat': {
        const message = payload.message as string;
        const conversationId = typeof payload.chat_id === 'string' ? payload.chat_id : undefined;
        const timeoutMs = typeof payload.timeout_ms === 'number' ? payload.timeout_ms : undefined;

        let timer: ReturnType<typeof setTimeout> | null = null;
        let timedOut = false;

        const result = await new Promise<{ response: string; conversationId: string }>(
          (resolve, reject) => {
            if (timeoutMs) {
              timer = setTimeout(() => {
                timedOut = true;
                reject(new Error('claude_chat timed out'));
              }, timeoutMs);
            }

            claudeChat(message, conversationId, (chunk) => {
              if (!timedOut) sendResponse({ id, type: 'chunk', text: chunk });
            })
              .then(resolve)
              .catch(reject);
          },
        );

        if (timer) clearTimeout(timer);
        sendResponse({ id, type: 'done', data: { conversationId: result.conversationId } });
        break;
      }

      case 'claude_new_chat': {
        const message = payload.message as string;
        const result = await claudeChat(message, undefined, (chunk) => {
          sendResponse({ id, type: 'chunk', text: chunk });
        });
        sendResponse({ id, type: 'done', data: { conversationId: result.conversationId } });
        break;
      }

      case 'claude_list_chats': {
        const orgId = await getOrgId();
        const chats = await listChats(orgId);
        sendResponse({ id, type: 'done', data: chats });
        break;
      }

      case 'claude_open_chat': {
        const chatId = payload.chat_id as string;
        const result = await claudeChat('', chatId);
        sendResponse({ id, type: 'done', data: result });
        break;
      }

      case 'claude_list_projects': {
        const orgId = await getOrgId();
        const projects = await listProjects(orgId);
        sendResponse({ id, type: 'done', data: projects });
        break;
      }

      case 'claude_artifact': {
        const artifactId = payload.artifact_id as string;
        sendResponse({
          id,
          type: 'error',
          error: `Artifact retrieval not yet implemented for artifact_id=${artifactId}`,
        });
        break;
      }

      case 'playwright_action': {
        sendResponse({
          id,
          type: 'error',
          error: 'playwright_action not yet implemented in this agent version',
        });
        break;
      }

      default: {
        sendResponse({ id, type: 'error', error: `Unknown command type: ${type}` });
      }
    }
  } catch (err) {
    sendResponse({
      id,
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
