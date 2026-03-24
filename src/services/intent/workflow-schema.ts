import { z } from 'zod';

/**
 * Tool input values in workflow DSL are always strings — either literal values
 * or template expressions like "{{$1}}", "{{dates.today}}", "{{user.timezone}}".
 * The variable-resolver evaluates templates at runtime into concrete types.
 */
const ToolInputSchema = z.record(z.string(), z.string());

const Level1ToolSchema = z.object({
  name: z.string(),
  input: ToolInputSchema,
});

const Level2StepSchema = z.object({
  call: z.string().optional(),
  input: ToolInputSchema.optional(),
  as: z.string().optional(),
  when: z.string().optional(),
  respond: z.string().optional(),
  stop: z.boolean().optional(),
});

/** i18n dictionary: language code → key → translated string */
const I18nMapSchema = z.record(z.string(), z.record(z.string(), z.string()));

const Level1WorkflowSchema = z.object({
  tools: z.array(Level1ToolSchema),
  format: z.string().optional(),
  i18n: I18nMapSchema.optional(),
});

const Level2WorkflowSchema = z.object({
  steps: z.array(Level2StepSchema),
  i18n: I18nMapSchema.optional(),
});

export const WorkflowSchema = z.union([Level1WorkflowSchema, Level2WorkflowSchema]);

export type Workflow = z.infer<typeof WorkflowSchema>;
export type Level1Tool = z.infer<typeof Level1ToolSchema>;
export type Level2Step = z.infer<typeof Level2StepSchema>;
export type I18nMap = z.infer<typeof I18nMapSchema>;
