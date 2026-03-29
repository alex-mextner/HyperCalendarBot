import { net, session } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadDecryptedCookies } from './cookie-parser';

const COOKIES_PATH = join(
  homedir(),
  'Library',
  'Application Support',
  'Claude',
  'Cookies',
);
const API_BASE = 'https://claude.ai';
const AGENT_VERSION = '0.1.0';

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

function classifyError(status: number): string {
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

async function apiRequest(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  if (isCircuitOpen()) {
    throw new Error('Circuit breaker open — too many recent errors');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  const url = `${API_BASE}${path}`;
  console.log(`[claude-bridge] → ${options.method ?? 'GET'} ${url}`);
  let res: Response;
  try {
    // Use session.defaultSession so Chromium handles cookies natively —
    // Cloudflare's __cf_bm is refreshed automatically on every response.
    res = await net.fetch(url, {
      ...options,
      signal: controller.signal,
      useSessionCookies: true,
      headers: {
        'Content-Type': 'application/json',
        'Origin': API_BASE,
        'Referer': `${API_BASE}/`,
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'X-Agent-Version': AGENT_VERSION,
        ...(options.headers as Record<string, string> | undefined),
      },
    } as Parameters<typeof net.fetch>[1]);
  } finally {
    clearTimeout(timer);
  }
  console.log(`[claude-bridge] ← ${res.status} ${url}`);
  if (!res.ok) {
    recordError();
    const kind = classifyError(res.status);
    throw new Error(errorMessage(kind));
  }
  return res;
}

export async function getOrgId(): Promise<string> {
  const res = await apiRequest('/api/organizations');
  const orgs = (await res.json()) as Array<{ uuid: string }>;
  if (!orgs.length) throw new Error('No Claude organizations found');
  return orgs[0]!.uuid;
}

export async function listChats(orgId: string): Promise<Array<{ id: string; name: string }>> {
  const res = await apiRequest(
    `/api/organizations/${orgId}/chat_conversations?limit=50`,
  );
  const chats = (await res.json()) as Array<{ uuid: string; name: string }>;
  return chats.map((c) => ({ id: c.uuid, name: c.name }));
}

export async function listProjects(orgId: string): Promise<Array<{ id: string; name: string }>> {
  const res = await apiRequest(`/api/organizations/${orgId}/projects`);
  const projects = (await res.json()) as Array<{ uuid: string; name: string }>;
  return projects.map((p) => ({ id: p.uuid, name: p.name }));
}

export async function getArtifact(artifactId: string): Promise<{ content: string; type: string }> {
  const res = await apiRequest(`/api/artifacts/${artifactId}`);
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
  const orgId = await getOrgId();

  let convId = conversationId;
  if (!convId) {
    const createRes = await apiRequest(
      `/api/organizations/${orgId}/chat_conversations`,
      {
        method: 'POST',
        body: JSON.stringify({ name: '' }),
      },
    );
    const conv = (await createRes.json()) as { uuid: string };
    convId = conv.uuid;
  }

  const res = await apiRequest(
    `/api/organizations/${orgId}/chat_conversations/${convId}/completion`,
    {
      method: 'POST',
      body: JSON.stringify({
        prompt: message,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    },
  );

  const chunks: string[] = [];

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const text = decoder.decode(value, { stream: true });
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') break;
      try {
        const parsed = JSON.parse(data) as { completion?: string; delta?: { text?: string } };
        const chunk = parsed.completion ?? parsed.delta?.text ?? '';
        if (chunk) {
          chunks.push(chunk);
          onChunk?.(chunk);
        }
      } catch {
        // skip malformed SSE lines
      }
    }
  }

  return { response: chunks.join(''), conversationId: convId };
}
