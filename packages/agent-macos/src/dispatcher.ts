import { applescriptRun } from './actions/applescript';
import { bashExecute } from './actions/bash';
import { claudeChat, getArtifact, getOrgId, listChats, listProjects } from './actions/claude-bridge';
import { type PlaywrightAction, playwrightAction } from './actions/playwright';
import type { AgentCommand, AgentResponse } from './protocol';
import { clampTimeoutMs, MAX_TIMEOUT_MS } from './timeout-clamp';

type SendResponse = (resp: AgentResponse) => void;

function toPlaywrightAction(
  action: string,
  url: string | undefined,
  selector: string,
  value: string,
): PlaywrightAction {
  if (action === 'fill') return { action: 'fill', url, selector, value };
  if (action === 'click') return { action: 'click', url, selector };
  if (action === 'extract') return { action: 'extract', url, selector };
  if (action === 'navigate') return { action: 'navigate', url: url ?? '' };
  return { action: 'screenshot', url };
}

export async function dispatch(cmd: AgentCommand, sendResponse: SendResponse): Promise<void> {
  const { id, type } = cmd;

  try {
    switch (type) {
      case 'bash_execute': {
        const { command, timeout_ms } = cmd.payload;
        const result = await bashExecute(command, timeout_ms ?? 60_000);
        sendResponse({
          id,
          type: 'done',
          data: { stdout: result.stdout, stderr: result.stderr },
          exitCode: result.exitCode,
        });
        break;
      }

      case 'applescript_run': {
        const { script, timeout_ms } = cmd.payload;
        const result = await applescriptRun(script, timeout_ms ?? 30_000);
        sendResponse({
          id,
          type: 'done',
          data: { output: result.output },
          exitCode: result.exitCode,
        });
        break;
      }

      case 'claude_chat': {
        const { message, chat_id, timeout_ms } = cmd.payload;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let timedOut = false;

        const result = await new Promise<{ response: string; conversationId: string }>(
          (resolve, reject) => {
            if (timeout_ms) {
              const effectiveTimeoutMs = clampTimeoutMs(timeout_ms, MAX_TIMEOUT_MS);
              timer = setTimeout(() => {
                timedOut = true;
                reject(new Error('claude_chat timed out'));
              }, effectiveTimeoutMs);
            }

            claudeChat(message, chat_id, (chunk) => {
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
        const { message } = cmd.payload;
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
        const { chat_id } = cmd.payload;
        const result = await claudeChat('', chat_id);
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
        const { artifact_id } = cmd.payload;
        const artifact = await getArtifact(artifact_id);
        sendResponse({ id, type: 'done', data: artifact });
        break;
      }

      case 'playwright_action': {
        const { action, url, selector = '', value = '', timeout_ms } = cmd.payload;
        const params = toPlaywrightAction(action, url, selector, value);
        const result = await playwrightAction(params, timeout_ms ?? 30_000);
        if (result.screenshot) {
          sendResponse({
            id,
            type: 'chunk',
            text: `[screenshot:${result.screenshot.substring(0, 50)}...]`,
          });
        }
        sendResponse({ id, type: 'done', data: result });
        break;
      }

      default:
        sendResponse({ id, type: 'error', error: `Unknown command type: ${type}` });
    }
  } catch (err) {
    sendResponse({
      id,
      type: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
