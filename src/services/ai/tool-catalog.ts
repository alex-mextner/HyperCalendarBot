import type OpenAI from 'openai';
import { z } from 'zod';

// Discovery metadata only. Authorization remains in the existing tool handlers.
const GROUPS: Readonly<Record<string, readonly string[]>> = {
  'calendar.read': ['get_events', 'get_event', 'get_upcoming', 'search_events', 'get_free_slots', 'get_holidays'],
  'calendar.write': [
    'create_event',
    'update_event',
    'attach_pending_location_to_event',
    'delete_event',
    'create_birthday_event',
    'set_event_visibility',
    'snooze_event',
  ],
  reminders: ['set_reminder', 'get_reminders', 'make_call'],
  contacts: [
    'find_user',
    'get_contacts',
    'add_contact',
    'find_contact',
    'update_contact',
    'get_user_info',
    'delete_contact',
  ],
  sharing: [
    'notify_participants',
    'share_event',
    'send_invitation',
    'get_invitation_status',
    'share_agenda',
    'propose_edit',
    'cancel_invitation',
    'resend_invitation',
    'list_calendar_access',
    'manage_secretaries',
    'propose_calendar_change',
  ],
  settings: [
    'manage_settings',
    'get_google_calendar_status',
    'list_google_calendars',
    'get_timezone_info',
    'convert_to_timezone',
    'connect_telegram_status',
    'dismiss_connect_telegram_prompt',
  ],
  history: ['get_history', 'get_action_log', 'remember_user_fact'],
  automation: [
    'schedule_ai_call',
    'schedule_ai_calls_list',
    'schedule_ai_call_cancel',
    'add_trigger',
    'list_triggers',
    'remove_trigger',
  ],
  presentation: ['render_day_image', 'render_week_image', 'render_month_image', 'render_table'],
  calculator: ['calculate'],
  interaction: [
    'ask_user',
    'pick_users',
    'resume_scene',
    'cancel_scene',
    'set_reaction',
    'end_conversation',
    'end_call',
    'supplement_skip',
    'get_bot_info',
    'send_feedback',
    'lookup_stress',
  ],
};

const nameSchema = z.string().trim().min(1).max(96);
const requestSchema = z
  .object({
    groups: z.array(nameSchema).max(8).default([]),
    tools: z.array(nameSchema).max(24).default([]),
  })
  .strict();

interface CatalogLimits {
  maxTools?: number;
  maxSchemaChars?: number;
}

type DescriptionResult =
  | { ok: false; error: 'INVALID_CATALOG_REQUEST' }
  | { ok: true; tools: OpenAI.ChatCompletionTool[]; unavailable: string[]; deferred: string[]; schemaChars: number };

function budget(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < minimum || n > maximum) throw new Error('Invalid tool catalog budget');
  return n;
}

/** One optional request field: absent, or an array of at most `max` strings each at most 96 chars. */
function rawNameListIsBounded(values: unknown, max: number): boolean {
  if (values === undefined) return true;
  if (!Array.isArray(values) || values.length > max) return false;
  for (const value of values) {
    if (typeof value !== 'string' || value.length > 96) return false;
  }
  return true;
}

/** Bound raw arrays/strings before Zod traverses or trims their contents. */
function rawRequestIsBounded(input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  if (!Object.hasOwn(input, 'groups') && !Object.hasOwn(input, 'tools')) return false;
  return rawNameListIsBounded(Reflect.get(input, 'groups'), 8) && rawNameListIsBounded(Reflect.get(input, 'tools'), 24);
}

/**
 * Explicit names precede domain expansion: a large domain cannot starve
 * the particular function the caller asked for. Both arrays are bounded.
 * Groups with no members are recorded in `unavailable`.
 */
function expandRequestedNames(
  byGroup: ReadonlyMap<string, readonly string[]>,
  request: { groups: readonly string[]; tools: readonly string[] },
  unavailable: Set<string>,
): Set<string> {
  const requested = new Set(request.tools);
  for (const group of request.groups) {
    const members = byGroup.get(group);
    if (!members) unavailable.add(`group:${group}`);
    else for (const name of members) requested.add(name);
  }
  return requested;
}

/** Takes requested tools in order while they fit; unknown names go to `unavailable`, overflow to `deferred`. */
function fitWithinBudget(
  byName: ReadonlyMap<string, OpenAI.ChatCompletionFunctionTool>,
  requested: ReadonlySet<string>,
  unavailable: Set<string>,
  limits: { maxTools: number; maxSchemaChars: number },
): { tools: OpenAI.ChatCompletionTool[]; deferred: string[]; schemaChars: number } {
  const tools: OpenAI.ChatCompletionTool[] = [];
  const deferred: string[] = [];
  let schemaChars = 2; // JSON array brackets, including the empty case.
  for (const name of requested) {
    const tool = byName.get(name);
    if (!tool) {
      unavailable.add(name);
      continue;
    }
    const cost = JSON.stringify(tool).length + (tools.length ? 1 : 0);
    if (tools.length >= limits.maxTools || schemaChars + cost > limits.maxSchemaChars) {
      deferred.push(name);
      continue; // A later, smaller schema may still fit.
    }
    tools.push(structuredClone(tool));
    schemaChars += cost;
  }
  return { tools, deferred, schemaChars };
}

/**
 * Construct from getToolDefinitions(inputMode, supplementMode), NOT
 * a global catalog. This is a per-request discovery view, not an execution grant.
 * index() carries summaries; describe() returns the unchanged full JSON schemas.
 * Neither method reads user data, invokes tools or changes production routing.
 */
export function createToolCatalog(allowed: readonly OpenAI.ChatCompletionTool[], limits: CatalogLimits = {}) {
  const maxTools = budget(limits.maxTools, 24, 1, 64);
  const maxSchemaChars = budget(limits.maxSchemaChars, 16000, 2, 64000);
  const byName = new Map<string, OpenAI.ChatCompletionFunctionTool>();
  const byGroup = new Map<string, string[]>();
  for (const tool of allowed) {
    if (tool.type !== 'function') throw new Error('Tool catalog supports function tools only');
    const name = tool.function.name;
    if (name === 'discover_tools') throw new Error('RESERVED_TOOL_NAME');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name) || byName.has(name)) throw new Error('Invalid or duplicate tool name');
    byName.set(name, structuredClone(tool));
    const group = Object.entries(GROUPS).find(([, names]) => names.includes(name))?.[0] ?? 'other';
    const members = byGroup.get(group) ?? [];
    members.push(name);
    byGroup.set(group, members);
  }

  return {
    /** Group and tool names a discovery request may name; `loaded` tools already carry their schema and are left out of the tool names. */
    identifiers(loaded: ReadonlySet<string> = new Set()): { groups: string[]; tools: string[] } {
      return { groups: [...byGroup.keys()], tools: [...byName.keys()].filter((name) => !loaded.has(name)) };
    },
    /** One line per tool that is not `loaded`, grouped by domain; a domain whose tools are all loaded is left out. */
    index(loaded: ReadonlySet<string> = new Set()): string {
      return [...byGroup]
        .flatMap(([group, names]) => {
          const entries = names
            .filter((name) => !loaded.has(name))
            .map((name) => {
              const description = (byName.get(name)?.function.description ?? '').replace(/\s+/g, ' ').trim();
              const brief = description.length > 100 ? `${description.slice(0, 99)}…` : description;
              return `${name}: ${brief}`;
            });
          return entries.length === 0 ? [] : [`[${group}]\n${entries.join('\n')}`];
        })
        .join('\n');
    },
    describe(input: unknown): DescriptionResult {
      if (!rawRequestIsBounded(input)) return { ok: false, error: 'INVALID_CATALOG_REQUEST' };
      const parsed = requestSchema.safeParse(input);
      if (!parsed.success) return { ok: false, error: 'INVALID_CATALOG_REQUEST' };
      const unavailable = new Set<string>();
      const requested = expandRequestedNames(byGroup, parsed.data, unavailable);
      const { tools, deferred, schemaChars } = fitWithinBudget(byName, requested, unavailable, {
        maxTools,
        maxSchemaChars,
      });
      return { ok: true, tools, unavailable: [...unavailable], deferred, schemaChars };
    },
  };
}
