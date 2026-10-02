// HTTP binding of the intent-learning protocol under a fixed versioned prefix. Worker and admin
// bearers are separate secrets (and distinct from ADMIN_ALERT_TOKEN); neither can use the other's routes.
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  INTENT_LEARNING_ROUTE_PREFIX,
  MAX_BODY_BYTES,
  MIN_TOKEN_CHARS,
} from '../services/intent-learning/constants.ts';
import { IntentLearningError } from '../services/intent-learning/context.ts';
import { jsonDepthWithin } from '../services/intent-learning/redaction.ts';
import {
  AdminEnqueueBodySchema,
  ApproveBodySchema,
  artifactJsonSchema,
  ClaimBodySchema,
  EvidenceBodySchema,
  FailureBodySchema,
  HeartbeatBodySchema,
  type JsonValue,
  ProposalsBodySchema,
  RejectBodySchema,
  ResultBodySchema,
} from '../services/intent-learning/schemas.ts';
import type { IntentLearningService } from '../services/intent-learning/service.ts';
import { jsonCodec } from '../utils/json-codec.ts';
import { webLogger } from '../utils/logger.ts';

export interface IntentLearningRouteOptions {
  service: IntentLearningService;
  /** Bearer for the Claude Code worker: claim, heartbeat, result, failure, evidence, schema. */
  workerToken?: string;
  /** Bearer for the operator: enqueue, proposals, approve, reject, status, schema. */
  adminToken?: string;
  /** ADMIN_ALERT_TOKEN, only to refuse a configuration that reuses it. */
  alertToken?: string;
}

type Role = 'worker' | 'admin';
const MAX_JSON_DEPTH = 40;
/** Depth is probed iteratively before any recursive schema walks the body. */
const RequestJson = jsonCodec(
  z.custom<JsonValue>((value) => jsonDepthWithin(value, MAX_JSON_DEPTH), 'JSON nesting is too deep'),
);

class RouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

interface RouteSpec {
  method: 'GET' | 'POST';
  roles: Role[];
  handle: (service: IntentLearningService, body: unknown) => Response | Promise<Response>;
}

const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

function empty(status: number, headers: { [key: string]: string } = {}): Response {
  return new Response(null, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new IntentLearningError(
      'validation_failed',
      'Request body does not match the schema',
      parsed.error.issues.slice(0, 20).map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`),
    );
  return parsed.data;
}

const ROUTES: { [path: string]: RouteSpec } = {
  '/claim': {
    method: 'POST',
    roles: ['worker'],
    handle: (service, body) => {
      const { workerId } = parse(ClaimBodySchema, body);
      const claim = service.claim(workerId);
      if (claim) return json(200, claim);
      const next = service.nextClaimAt();
      const retryAfter = next === null ? null : Math.max(1, Math.ceil((next - Date.now()) / 1000));
      return empty(204, retryAfter === null ? {} : { 'Retry-After': String(retryAfter) });
    },
  },
  '/heartbeat': {
    method: 'POST',
    roles: ['worker'],
    handle: (service, body) => {
      const input = parse(HeartbeatBodySchema, body);
      return json(200, service.heartbeat(input.jobId, input.leaseToken));
    },
  },
  '/result': {
    method: 'POST',
    roles: ['worker'],
    handle: (service, body) => json(200, service.submitResult(parse(ResultBodySchema, body))),
  },
  '/failure': {
    method: 'POST',
    roles: ['worker'],
    handle: (service, body) => json(200, service.reportFailure(parse(FailureBodySchema, body))),
  },
  '/evidence': {
    method: 'POST',
    roles: ['worker'],
    handle: (service, body) => json(200, service.evidence(parse(EvidenceBodySchema, body))),
  },
  '/schema': { method: 'GET', roles: ['worker', 'admin'], handle: () => json(200, artifactJsonSchema()) },
  '/enqueue': {
    method: 'POST',
    roles: ['admin'],
    handle: (service, body) => {
      const input = parse(AdminEnqueueBodySchema, body);
      if ('kind' in input) return json(200, service.enqueueCorpus(input.sampleIds, { kind: 'admin_token' }));
      return json(200, service.enqueue(input));
    },
  },
  '/proposals': {
    method: 'POST',
    roles: ['admin'],
    handle: (service, body) => {
      const input = parse(ProposalsBodySchema, body);
      if (input.action === 'list') return json(200, { proposals: service.listProposals(input.status) });
      if (input.action === 'get') {
        const proposal = service.getProposal(input.id);
        return proposal ? json(200, proposal) : json(404, { error: 'not_found' });
      }
      return json(200, service.createManualProposal(input.proposal, { kind: 'admin_token' }));
    },
  },
  '/approve': {
    method: 'POST',
    roles: ['admin'],
    handle: (service, body) => {
      const input = parse(ApproveBodySchema, body);
      return json(
        200,
        service.approve({ proposalId: input.id, expectedHash: input.expectedHash, actor: { kind: 'admin_token' } }),
      );
    },
  },
  '/reject': {
    method: 'POST',
    roles: ['admin'],
    handle: (service, body) => {
      const input = parse(RejectBodySchema, body);
      service.reject({ proposalId: input.id, actor: { kind: 'admin_token' }, reason: input.reason });
      return json(200, { status: 'rejected' });
    },
  },
  '/status': { method: 'GET', roles: ['admin'], handle: (service) => json(200, service.status()) },
};

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Constant-time comparison of the presented bearer against one configured secret. */
function bearerMatches(header: string | null, secret: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  return timingSafeEqual(digest(header.slice('Bearer '.length)), digest(secret));
}

function usableTokens(options: IntentLearningRouteOptions): { worker?: string; admin?: string } | null {
  const worker = options.workerToken && options.workerToken.length >= MIN_TOKEN_CHARS ? options.workerToken : undefined;
  const admin = options.adminToken && options.adminToken.length >= MIN_TOKEN_CHARS ? options.adminToken : undefined;
  if (worker && admin && worker === admin) return null;
  if (options.alertToken && (worker === options.alertToken || admin === options.alertToken)) return null;
  return { worker, admin };
}

function roleOf(req: Request, tokens: { worker?: string; admin?: string }): Role | null {
  const header = req.headers.get('Authorization');
  const worker = tokens.worker !== undefined && bearerMatches(header, tokens.worker);
  const admin = tokens.admin !== undefined && bearerMatches(header, tokens.admin);
  return worker ? 'worker' : admin ? 'admin' : null;
}

/** Streams the body and stops at the cap; a chunked body carries no Content-Length to trust. */
async function readCapped(req: Request): Promise<Uint8Array> {
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch((err: unknown) => webLogger.warn({ err }, 'Cancelling an oversized body failed'));
      throw new RouteError(413, 'body_too_large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readJsonBody(req: Request): Promise<unknown> {
  const contentType = req.headers.get('Content-Type') ?? '';
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) throw new RouteError(415, 'unsupported_media_type');
  const declared = Number(req.headers.get('Content-Length') ?? '0');
  if (declared > MAX_BODY_BYTES) throw new RouteError(413, 'body_too_large');
  const bytes = await readCapped(req);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Invalid UTF-8 is malformed client input, answered with 400 rather than logged as a fault.
    throw new RouteError(400, 'invalid_json');
  }
  const parsed = RequestJson.safeParse(text);
  if (!parsed.success) throw new RouteError(400, 'invalid_json');
  return parsed.data;
}

function errorResponse(err: unknown): Response {
  if (err instanceof RouteError) return json(err.status, { error: err.code });
  if (err instanceof IntentLearningError)
    return json(err.status, { error: err.code, message: err.message, details: err.details });
  webLogger.error({ err }, 'Intent-learning route failed');
  return json(500, { error: 'internal' });
}

/**
 * Handles every request under `/admin/intent-learning/v1`; returns null for any other path so the
 * parent server can continue routing. Unconfigured roles answer 404; a token reused across roles
 * (or equal to ADMIN_ALERT_TOKEN) disables the whole route with 503.
 */
export async function handleIntentLearningRequest(
  req: Request,
  options: IntentLearningRouteOptions,
): Promise<Response | null> {
  const { pathname } = new URL(req.url);
  if (pathname !== INTENT_LEARNING_ROUTE_PREFIX && !pathname.startsWith(`${INTENT_LEARNING_ROUTE_PREFIX}/`))
    return null;
  const tokens = usableTokens(options);
  if (!tokens) return json(503, { error: 'misconfigured_tokens' });
  if (!tokens.worker && !tokens.admin) return json(404, { error: 'not_found' });
  const route = ROUTES[pathname.slice(INTENT_LEARNING_ROUTE_PREFIX.length)];
  if (!route || !Object.hasOwn(ROUTES, pathname.slice(INTENT_LEARNING_ROUTE_PREFIX.length)))
    return json(404, { error: 'not_found' });
  const role = roleOf(req, tokens);
  if (!role) return json(401, { error: 'unauthorized' });
  if (!route.roles.includes(role)) return json(403, { error: 'forbidden' });
  if (req.method !== route.method) return empty(405, { Allow: route.method });
  try {
    const body = route.method === 'POST' ? await readJsonBody(req) : undefined;
    return await route.handle(options.service, body);
  } catch (err) {
    return errorResponse(err);
  }
}
