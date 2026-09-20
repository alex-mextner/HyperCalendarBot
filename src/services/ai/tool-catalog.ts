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

/** Bound raw arrays/strings before Zod traverses or trims their contents. */
function rawRequestIsBounded(input: unknown): boolean {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  for (const [key, max] of [
    ['groups', 8],
    ['tools', 24],
  ] as const) {
    const values: unknown = Reflect.get(input, key);
    if (values === undefined) continue;
    if (!Array.isArray(values) || values.length > max) return false;
    for (const value of values) {
      if (typeof value !== 'string' || value.length > 96) return false;
    }
  }
  return true;
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
    identifiers(): { groups: string[]; tools: string[] } {
      return { groups: [...byGroup.keys()], tools: [...byName.keys()] };
    },
    index(): string {
      return [...byGroup]
        .map(([group, names]) => {
          const entries = names.map((name) => {
            const description = (byName.get(name)?.function.description ?? '').replace(/\s+/g, ' ').trim();
            const brief = description.length > 100 ? `${description.slice(0, 99)}…` : description;
            return `${name}: ${brief}`;
          });
          return `[${group}]\n${entries.join('\n')}`;
        })
        .join('\n');
    },
    describe(input: unknown): DescriptionResult {
      if (!rawRequestIsBounded(input)) return { ok: false, error: 'INVALID_CATALOG_REQUEST' };
      const parsed = requestSchema.safeParse(input);
      if (!parsed.success) return { ok: false, error: 'INVALID_CATALOG_REQUEST' };
      // Explicit names precede domain expansion: a large domain cannot starve
      // the particular function the caller asked for. Both arrays are bounded.
      const requested = new Set(parsed.data.tools);
      const unavailable = new Set<string>();
      for (const group of parsed.data.groups) {
        const members = byGroup.get(group);
        if (!members) unavailable.add(`group:${group}`);
        else for (const name of members) requested.add(name);
      }
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
        if (tools.length >= maxTools || schemaChars + cost > maxSchemaChars) {
          deferred.push(name);
          continue; // A later, smaller schema may still fit.
        }
        tools.push(structuredClone(tool));
        schemaChars += cost;
      }
      return { ok: true, tools, unavailable: [...unavailable], deferred, schemaChars };
    },
  };
}
