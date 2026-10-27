// src/bot/handlers/message/intent-edit.ts
// Admin intent-edit flow: LLM-assisted JSON edit of an intent workflow with validation retries.

import { z } from 'zod';
import type { Intent } from '../../../database/types.ts';
import { aiStreamRound } from '../../../services/ai/streaming.ts';
import type { AdminEditSession } from '../../../services/intent/admin-edit-session.ts';
import { type Workflow, WorkflowSchema } from '../../../services/intent/workflow-schema.ts';
import { validateWorkflow } from '../../../services/intent/workflow-validator.ts';
import { jsonCodec } from '../../../utils/json-codec.ts';
import { cmdLogger } from '../../../utils/logger.ts';
import type { BotCommandContext } from '../../types.ts';
import type { MessageHandlerDeps } from './types.ts';

export function stripJsonFences(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

const INTENT_EDIT_MAX_TOKENS = 2048;

const INTENT_EDIT_SYSTEM_PROMPT = `You are a JSON editor for calendar-bot intent objects.
Given a current intent JSON and admin instructions, return ONLY a valid JSON object with updated fields.
Only include fields that should change: phrases (string[]), trigger_words (string[]), pattern (string|null), workflow (object), format (string).
Do not include id, canonical_name, status, source_message, created_at.
IMPORTANT: Return raw JSON only — no markdown, no code fences, no backticks, no explanation.
Your response budget is ${INTENT_EDIT_MAX_TOKENS} tokens. Always emit complete, valid JSON — never truncate.

## Workflow syntax reference

Workflow is always { "steps": [...] }. Step types:
- Tool call: { "call": "tool_name", "input": {...} } — add "as": "var_name" to save output for later steps.
- Conditional: add "when": "expr" to any step — skip if false.
- Clarifying question: { "call": "ask_user", "input": { "question": "{{t.q}}", "options": ["{{t.opt1}}", "{{t.opt2}}"] }, "as": "name|lower" } — suspends, resumes when user replies. Answer is in ask.name namespace.
- Respond and stop: { "respond": "{{t.msg}}" }
- i18n: add "i18n": { "ru": { "key": "..." }, "en": { "key": "..." } } at workflow root when steps use {{t.key}}.

## Context helper functions (use in "when" expressions)
- isPastHour(h) — true if hour h (0-23) already passed today in user timezone
- isPastHourPM(h) — true if PM hour h (1-12, maps to h+12) already passed today
- isPastDay(d) — true if day-of-month d already passed this month
- isAmPmAmbiguous(h) — true if h is 1-12 (ambiguous AM/PM, must ask user)

## Template variables (ONLY these — any other {{var}} will crash at runtime)
Dates: {{dates.today}}, {{dates.yesterday}}, {{dates.tomorrow}}, {{dates.week_start}}, {{dates.week_end}}, {{dates.next_week_start}}, {{dates.next_week_end}}, {{dates.month_start}}, {{dates.month_end}}, {{dates.next_month_start}}, {{dates.now}}
User: {{user.id}}, {{user.username}}, {{user.first_name}}, {{user.timezone}}, {{user.language}}, {{user.utc_offset}}
Env: {{env.scope}} — "group" in group chats, "personal" in private chats
Captures: {{$1}}, {{$2}}, ... — regex capturing group values
Last events: {{last_added_event.id/.title/.date/.time/...}}, {{last_mentioned_event.id/.title/.date/.time/...}}
i18n text: {{t.key}}
Filters (pipe): {{$1|pad(2)}}, {{var|upper}}, {{var|lower}}, {{var|trim}}, {{var|truncate(50)}}, {{var|default("x")}}, {{var|replace("a","b")}}, {{var|date("dd.MM")}}, {{var|ternary("yes","no")}}, {{var|eq("m","if","else")}}, {{$1|add(12)}}

## AM/PM handling pattern
When hour $N could be 1-12, use ask_user for AM/PM clarification:
{ "steps": [
  { "when": "isAmPmAmbiguous($1) == false", "call": "create_event", "input": { "start_at": "{{dates.today}}T{{$1|pad(2)}}:00:00{{user.utc_offset}}", "scope": "{{env.scope}}" } },
  { "when": "isAmPmAmbiguous($1)", "call": "ask_user", "input": { "question": "{{t.ampm_q}}", "options": ["{{t.am}}", "{{t.pm}}"] }, "as": "ampm|lower" },
  { "when": "isAmPmAmbiguous($1) && ask.ampm == 'am'", "call": "create_event", "input": { "start_at": "{{dates.today}}T{{$1|pad(2)}}:00:00{{user.utc_offset}}", "scope": "{{env.scope}}" } },
  { "when": "isAmPmAmbiguous($1) && ask.ampm == 'pm'", "call": "create_event", "input": { "start_at": "{{dates.today}}T{{$1|add(12)|pad(2)}}:00:00{{user.utc_offset}}", "scope": "{{env.scope}}" } }
], "i18n": { "ru": { "ampm_q": "{{$1}}:00 — это утро или вечер?", "am": "утро", "pm": "вечер" }, "en": { "ampm_q": "Is {{$1}}:00 AM or PM?", "am": "AM", "pm": "PM" } } }

## Past-time handling pattern
When event is today and hour could be in the past, add isPastHour check:
{ "when": "isPastHour($1) == false", "call": "create_event", "input": { "start_at": "{{dates.today}}T{{$1|pad(2)}}:00:00{{user.utc_offset}}", ... } },
{ "when": "isPastHour($1)", "call": "create_event", "input": { "start_at": "{{dates.tomorrow}}T{{$1|pad(2)}}:00:00{{user.utc_offset}}", ... } }`;

const INTENT_EDIT_MAX_RETRIES = 3;

const IntentEditSchema = z.object({
  phrases: z.array(z.string()).optional(),
  trigger_words: z.array(z.string()).optional(),
  pattern: z.string().nullable().optional(),
  workflow: WorkflowSchema.optional(),
  format: z.string().optional(),
});
type IntentEdit = z.infer<typeof IntentEditSchema>;

const StringArrayCodec = jsonCodec(z.array(z.string()));
const IntentEditCodec = jsonCodec(IntentEditSchema);

/**
 * Ask the model for the edited fields, retrying on empty or unparseable answers.
 * Throws the last attempt's error once the retry budget is spent.
 */
async function requestIntentEdit(currentJson: string, instruction: string): Promise<IntentEdit> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= INTENT_EDIT_MAX_RETRIES; attempt++) {
    let rawText: string | undefined;
    try {
      const result = await aiStreamRound({
        messages: [
          { role: 'system', content: INTENT_EDIT_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Current intent:\n${currentJson}\n\nAdmin instructions: ${instruction}`,
          },
        ],
        maxTokens: INTENT_EDIT_MAX_TOKENS,
        purpose: 'intent_edit',
      });

      rawText = result.text;
      if (!rawText) throw new Error('Empty AI response');

      return IntentEditCodec.parse(stripJsonFences(rawText));
    } catch (err) {
      lastError = err;
      cmdLogger.warn({ err, attempt, rawAiResponse: rawText }, 'Intent edit attempt failed, retrying');
    }
  }
  throw lastError;
}

/**
 * Validate the combination that would be stored. A pattern-only edit still needs
 * checking: the retained workflow's {{$1}} references depend on that pattern's groups.
 */
function validateIntentEdit(updated: IntentEdit, currentWorkflow: Workflow, currentPattern: string | null): string[] {
  if (updated.workflow === undefined && updated.pattern === undefined) return [];
  const effectiveWorkflow = updated.workflow ?? currentWorkflow;
  const effectivePattern = updated.pattern !== undefined ? updated.pattern : currentPattern;
  return validateWorkflow(effectiveWorkflow, effectivePattern);
}

function intentEditChanges(updated: IntentEdit) {
  return {
    ...(updated.phrases !== undefined && { phrases: JSON.stringify(updated.phrases) }),
    ...(updated.trigger_words !== undefined && { trigger_words: JSON.stringify(updated.trigger_words) }),
    ...(updated.pattern !== undefined && { pattern: updated.pattern }),
    ...(updated.workflow !== undefined && { workflow: JSON.stringify(updated.workflow) }),
    ...(updated.format !== undefined && { format: updated.format }),
  };
}

function intentEditPreview(fresh: Intent): string {
  return [
    `✏️ Intent #${fresh.id} updated: <b>${fresh.canonical_name}</b>`,
    `Phrases: ${StringArrayCodec.parse(fresh.phrases)
      .map((p) => `"${p}"`)
      .join(', ')}`,
    fresh.pattern ? `Pattern: ${fresh.pattern}` : 'Pattern: none',
    `Workflow: ${fresh.workflow}`,
    `Format: ${fresh.format}`,
  ].join('\n');
}

export async function handleIntentEditInstruction(
  ctx: BotCommandContext,
  instruction: string,
  session: AdminEditSession,
  deps: MessageHandlerDeps,
): Promise<void> {
  const intentRepo = deps.intentRepo;
  if (!intentRepo) {
    await ctx.send('Intent repository not configured.');
    return;
  }

  const intent = intentRepo.getById(session.intentId);
  if (!intent) {
    await ctx.send(`Intent #${session.intentId} not found.`);
    return;
  }

  const currentWorkflow = jsonCodec(WorkflowSchema).parse(intent.workflow);
  const currentJson = JSON.stringify({
    phrases: StringArrayCodec.parse(intent.phrases),
    trigger_words: StringArrayCodec.parse(intent.trigger_words),
    pattern: intent.pattern,
    workflow: currentWorkflow,
    format: intent.format,
  });

  try {
    const updated = await requestIntentEdit(currentJson, instruction);

    const errors = validateIntentEdit(updated, currentWorkflow, intent.pattern);
    if (errors.length > 0) {
      cmdLogger.warn({ intentId: session.intentId, errors }, 'Admin intent edit produced an invalid workflow');
      await ctx.send(`❌ Edit rejected — the new workflow is invalid:\n${errors.map((e) => `- ${e}`).join('\n')}`);
      return;
    }

    intentRepo.update(session.intentId, intentEditChanges(updated));

    const fresh = intentRepo.getById(session.intentId)!;
    const { InlineKeyboard } = await import('gramio');
    const kb = new InlineKeyboard()
      .text('✅ Accept', `intent_accept:${fresh.id}`)
      .text('✏️ Edit', `intent_edit:${fresh.id}`)
      .text('❌ Reject', `intent_reject:${fresh.id}`);

    await ctx.send(intentEditPreview(fresh), { parse_mode: 'HTML', reply_markup: kb });
  } catch (error) {
    cmdLogger.error({ err: error }, 'Intent edit instruction failed');
    await ctx.send(`Failed to process edit: ${String(error)}`);
  }
}
