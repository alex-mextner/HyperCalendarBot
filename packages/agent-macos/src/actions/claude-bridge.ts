import { net, session } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadDecryptedCookies } from './cookie-parser';
import { getAccessToken } from '../oauth-manager';

const COOKIES_PATH = join(
  homedir(),
  'Library',
  'Application Support',
  'Claude',
  'Cookies',
);
const CLAUDE_AI_BASE = 'https://claude.ai';
const ANTHROPIC_API_BASE = 'https://api.anthropic.com';
const AGENT_VERSION = '0.1.0';
const CLAUDE_MODEL = 'claude-opus-4-6';
// Beta headers: oauth always required; files-api and context-1m match Claude Desktop behavior
const ANTHROPIC_BETA_HEADERS = 'oauth-2025-04-20,files-api-2025-04-14,context-1m-2025-08-07';

// Circuit breaker: open after 5 errors in 60s, stays open for 5 minutes.
const CB_ERROR_THRESHOLD = 5;
const CB_WINDOW_MS = 60_000;
const CB_OPEN_DURATION_MS = 5 * 60_000;

interface CircuitBreaker {
  errorTimestamps: number[];
  openUntil: number;
}

const circuitBreaker: CircuitBreaker = {
  errorTimestamps: [],
  openUntil: 0,
};

function isCircuitOpen(): boolean {
  const now = Date.now();
  if (now < circuitBreaker.openUntil) return true;
  circuitBreaker.errorTimestamps = circuitBreaker.errorTimestamps.filter(
    (t) => now - t < CB_WINDOW_MS,
  );
  return false;
}

function recordError(): void {
  const now = Date.now();
  circuitBreaker.errorTimestamps.push(now);
  if (circuitBreaker.errorTimestamps.length >= CB_ERROR_THRESHOLD) {
    circuitBreaker.openUntil = now + CB_OPEN_DURATION_MS;
  }
}

function classifyClaudeAiError(status: number): string {
  if (status === 401 || status === 403) return 'AUTH_FAILED';
  if (status === 404) return 'API_CHANGED';
  if (status === 429) return 'RATE_LIMITED';
  return 'REQUEST_FAILED';
}

function errorMessage(kind: string): string {
  switch (kind) {
    case 'AUTH_FAILED':
      return 'Claude Desktop: нужно заново войти в аккаунт на claude.ai / Need to re-login at claude.ai';
    case 'API_CHANGED':
      return 'Claude API изменился — нужно обновить агент / Claude API changed — update the agent';
    case 'RATE_LIMITED':
      return 'Claude Desktop: слишком много запросов, подожди немного / Too many requests, wait a bit';
    default:
      return `Claude request failed (${kind})`;
  }
}

// Load Claude Desktop cookies into the Electron session so Chromium handles
// them natively. This allows Cloudflare to refresh short-lived cookies (e.g.
// __cf_bm) automatically on every response, the same way a real browser does.
export async function initClaudeCookies(): Promise<void> {
  const cookies = loadDecryptedCookies(COOKIES_PATH);
  const ses = session.defaultSession;
  for (const c of cookies) {
    try {
      await ses.cookies.set({
        url: 'https://claude.ai',
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        expirationDate: c.expirationDate,
      });
    } catch {
      // Skip cookies that fail (e.g. invalid characters in value)
    }
  }
  console.log(`[claude-bridge] Session cookies loaded: ${cookies.length} cookies for claude.ai`);
}

// GET requests to claude.ai (listing orgs, chats, projects, artifacts).
// These use session cookies via Electron's Chromium stack.
async function claudeAiGet(path: string): Promise<Response> {
  if (isCircuitOpen()) {
    throw new Error('Circuit breaker open — too many recent errors');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  const url = `${CLAUDE_AI_BASE}${path}`;
  console.log(`[claude-bridge] → GET ${url}`);
  let res: Response;
  try {
    res = await net.fetch(url, {
      signal: controller.signal,
      useSessionCookies: true,
      headers: {
        'X-Agent-Version': AGENT_VERSION,
      },
    } as Parameters<typeof net.fetch>[1]);
  } finally {
    clearTimeout(timer);
  }
  console.log(`[claude-bridge] ← ${res.status} ${url}`);
  if (!res.ok) {
    recordError();
    const kind = classifyClaudeAiError(res.status);
    throw new Error(errorMessage(kind));
  }
  return res;
}

// POST to api.anthropic.com using OAuth Bearer token.
// Uses net.fetch for correct Chromium TLS fingerprint.
async function anthropicPost(
  path: string,
  body: { [key: string]: unknown },
): Promise<Response> {
  if (isCircuitOpen()) {
    throw new Error('Circuit breaker open — too many recent errors');
  }
  const accessToken = await getAccessToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  const url = `${ANTHROPIC_API_BASE}${path}`;
  console.log(`[claude-bridge] → POST ${url}`);
  let res: Response;
  try {
    res = await net.fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'anthropic-version': '2023-06-01',
        'anthropic-beta': ANTHROPIC_BETA_HEADERS,
        'X-Anthropic-Surface': 'operon-desktop',
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    } as Parameters<typeof net.fetch>[1]);
  } finally {
    clearTimeout(timer);
  }
  console.log(`[claude-bridge] ← ${res.status} ${url}`);
  if (!res.ok) {
    recordError();
    const errBody = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      throw new Error(errorMessage('AUTH_FAILED'));
    }
    if (res.status === 429) {
      throw new Error(errorMessage('RATE_LIMITED'));
    }
    throw new Error(`Anthropic API error (${res.status}): ${errBody}`);
  }
  return res;
}

export async function getOrgId(): Promise<string> {
  const res = await claudeAiGet('/api/organizations');
  const orgs = (await res.json()) as Array<{ uuid: string }>;
  if (!orgs.length) throw new Error('No Claude organizations found');
  return orgs[0]!.uuid;
}

export async function listChats(orgId: string): Promise<Array<{ id: string; name: string }>> {
  const res = await claudeAiGet(
    `/api/organizations/${orgId}/chat_conversations?limit=50`,
  );
  const chats = (await res.json()) as Array<{ uuid: string; name: string }>;
  return chats.map((c) => ({ id: c.uuid, name: c.name }));
}

export async function listProjects(orgId: string): Promise<Array<{ id: string; name: string }>> {
  const res = await claudeAiGet(`/api/organizations/${orgId}/projects`);
  const projects = (await res.json()) as Array<{ uuid: string; name: string }>;
  return projects.map((p) => ({ id: p.uuid, name: p.name }));
}

export async function getArtifact(artifactId: string): Promise<{ content: string; type: string }> {
  const res = await claudeAiGet(`/api/artifacts/${artifactId}`);
  const artifact = (await res.json()) as {
    content?: string;
    body?: string;
    type?: string;
    media_type?: string;
  };
  return {
    content: artifact.content ?? artifact.body ?? '',
    type: artifact.type ?? artifact.media_type ?? 'text/plain',
  };
}

export async function claudeChat(
  message: string,
  conversationId?: string,
  onChunk?: (text: string) => void,
): Promise<{ response: string; conversationId: string }> {
  const convId = conversationId ?? randomUUID();

  if (!message) {
    // claude_open_chat passes empty string — nothing to send
    return { response: '', conversationId: convId };
  }

  const res = await anthropicPost('/v1/messages', {
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    stream: true,
    messages: [{ role: 'user', content: message }],
  });

  if (!res.body) throw new Error('Anthropic API returned no response body');
  const chunks: string[] = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') break;
        try {
          const parsed = JSON.parse(data) as {
            type?: string;
            delta?: { type?: string; text?: string };
          };
          if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
            const chunk = parsed.delta.text ?? '';
            if (chunk) {
              chunks.push(chunk);
              onChunk?.(chunk);
            }
          }
        } catch {
          // skip malformed SSE lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return { response: chunks.join(''), conversationId: convId };
}
