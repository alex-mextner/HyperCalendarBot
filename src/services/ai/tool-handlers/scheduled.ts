import { t } from '../../../config/constants.ts';
import { evaluate } from '../../intent/expression-evaluator.ts';
import { ALL_TOPICS } from '../../scheduled/domain-event-bus.ts';
import type { AgentContext, ToolResult } from '../types.ts';

function requireScheduledCallService(ctx: AgentContext): ToolResult | null {
  if (!ctx.scheduled?.scheduledCallService) return { success: false, error: 'Scheduled calls not available.' };
  return null;
}

function requireTriggerRepo(ctx: AgentContext): ToolResult | null {
  if (!ctx.scheduled?.triggerService?.repo) return { success: false, error: 'Trigger service not available.' };
  return null;
}

export interface ScheduleAiCallInput {
  message: string;
  run_at?: string;
  cron?: string;
  label?: string;
}

export interface TriggerInput {
  topic: string;
  action: string;
  condition?: string;
  label?: string;
  once?: boolean;
}

export interface TriggerIdInput {
  id: string;
}

export async function handleScheduleAiCall(ctx: AgentContext, input: ScheduleAiCallInput): Promise<ToolResult> {
  const err = requireScheduledCallService(ctx);
  if (err) return err;
  try {
    const id = await ctx.scheduled!.scheduledCallService.create({
      userId: ctx.user.telegram_id,
      message: input.message,
      runAt: input.run_at ?? null,
      cron: input.cron ?? null,
      label: input.label ?? null,
    });
    const when = input.run_at ?? `cron: ${input.cron}`;
    return { success: true, output: t(ctx.user.language).aiTools.scheduled.scheduleCreated(id, input.message, when) };
  } catch (e: unknown) {
    return { success: false, error: String(e) };
  }
}

export function handleScheduleAiCallsList(ctx: AgentContext): ToolResult {
  const err = requireScheduledCallService(ctx);
  if (err) return err;
  const schedules = ctx.scheduled!.scheduledCallService.list(ctx.user.telegram_id);
  if (schedules.length === 0)
    return { success: true, output: t(ctx.user.language).aiTools.scheduled.noScheduledCalls, data: [] };
  const lines = schedules.map(
    (s) => `[${s.id}] "${s.label ?? s.message}" — ${s.run_at ?? `cron: ${s.cron}`} (runs: ${s.run_count})`,
  );
  return { success: true, output: lines.join('\n'), data: schedules };
}

export async function handleScheduleAiCallCancel(ctx: AgentContext, input: TriggerIdInput): Promise<ToolResult> {
  const err = requireScheduledCallService(ctx);
  if (err) return err;
  await ctx.scheduled!.scheduledCallService.cancel(input.id, ctx.user.telegram_id);
  return { success: true, output: t(ctx.user.language).aiTools.scheduled.scheduleCancelled(input.id) };
}

export function handleAddTrigger(ctx: AgentContext, input: TriggerInput): ToolResult {
  const err = requireTriggerRepo(ctx);
  if (err) return err;

  if (!(ALL_TOPICS as readonly string[]).includes(input.topic)) {
    return { success: false, error: `Unknown topic "${input.topic}". Available: ${ALL_TOPICS.join(', ')}` };
  }

  if (input.condition) {
    try {
      evaluate(input.condition, { newEvent: {}, updatedEvent: {}, oldEvent: {}, event: {}, inviteeId: 0 });
    } catch (e: unknown) {
      return { success: false, error: `Invalid condition expression: ${String(e)}` };
    }
  }

  const repo = ctx.scheduled!.triggerService.repo;
  const count = repo.countEnabled(ctx.user.telegram_id);
  if (count >= 50) return { success: false, error: 'Trigger limit (50) reached.' };

  const id = repo.create({
    userId: ctx.user.telegram_id,
    topic: input.topic,
    action: input.action,
    condition: input.condition ?? null,
    label: input.label ?? null,
    once: input.once ?? false,
  });

  return {
    success: true,
    output: t(ctx.user.language).aiTools.scheduled.triggerCreated(
      id,
      input.topic,
      input.condition ?? null,
      input.action,
    ),
  };
}

export function handleListTriggers(ctx: AgentContext): ToolResult {
  const err = requireTriggerRepo(ctx);
  if (err) return err;
  const triggers = ctx.scheduled!.triggerService.repo.listByUser(ctx.user.telegram_id);
  if (triggers.length === 0)
    return { success: true, output: t(ctx.user.language).aiTools.scheduled.noTriggers, data: [] };
  const lines = triggers.map(
    (tr) =>
      `[${tr.id}] ${tr.topic}${tr.condition ? ` if (${tr.condition})` : ''} → "${tr.action}" ${tr.enabled ? '✅' : '⬜'} fires:${tr.fire_count}${tr.once ? ' once' : ''}`,
  );
  return { success: true, output: lines.join('\n'), data: triggers };
}

export function handleRemoveTrigger(ctx: AgentContext, input: TriggerIdInput): ToolResult {
  const err = requireTriggerRepo(ctx);
  if (err) return err;
  ctx.scheduled!.triggerService.repo.remove(input.id, ctx.user.telegram_id);
  return { success: true, output: t(ctx.user.language).aiTools.scheduled.triggerRemoved(input.id) };
}
