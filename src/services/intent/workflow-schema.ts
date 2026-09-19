import { z } from 'zod';
import { BindingsSchema } from './workflow-bindings.ts';
import { isBoundedJson, readWorkflowVersion, WORKFLOW_LIMITS, type WorkflowInputValue } from './workflow-input.ts';

// Legacy definitions retain their historical string-only contract. A version is
// explicit so an unsupported version cannot be discarded by Zod's object parsing.
const LegacyInput = z.record(z.string(), z.string());
const I18nMapSchema = z.record(z.string(), z.record(z.string(), z.string()));
const LegacyTool = z.object({ name: z.string(), input: LegacyInput });
const LegacyStep = z.object({
  call: z.string().optional(),
  input: LegacyInput.optional(),
  as: z.string().optional(),
  when: z.string().optional(),
  respond: z.string().optional(),
  stop: z.boolean().optional(),
});
const LegacyWorkflow = z.union([
  z.object({
    version: z.literal(1).optional(),
    tools: z.array(LegacyTool),
    format: z.string().optional(),
    i18n: I18nMapSchema.optional(),
  }),
  z.object({ version: z.literal(1).optional(), steps: z.array(LegacyStep), i18n: I18nMapSchema.optional() }),
]);

const Value: z.ZodType<WorkflowInputValue> = z.lazy(() =>
  z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(Value), z.record(z.string(), Value)]),
);
const TypedInput = z.record(z.string(), Value);
const TypedTool = z
  .object({
    name: z
      .string()
      .min(1)
      .refine((name) => !['ask_user', 'respond'].includes(name), 'Use steps for workflow control'),
    input: TypedInput,
  })
  .strict();
const TypedStep = z
  .object({
    call: z.string().min(1).optional(),
    input: TypedInput.optional(),
    as: z.string().optional(),
    when: z.string().optional(),
    respond: z.string().optional(),
    stop: z.boolean().optional(),
  })
  .strict()
  .refine((step) => (step.call !== undefined) !== (step.respond !== undefined), 'A step has one call or response');
const TypedWorkflow = z.custom<unknown>(isBoundedJson, 'Workflow exceeds JSON input constraints').pipe(
  z.union([
    z
      .object({
        version: z.literal(2),
        tools: z.array(TypedTool).min(1).max(WORKFLOW_LIMITS.steps),
        format: z.string().optional(),
        i18n: I18nMapSchema.optional(),
        bindings: BindingsSchema.optional(),
      })
      .strict(),
    z
      .object({
        version: z.literal(2),
        steps: z.array(TypedStep).min(1).max(WORKFLOW_LIMITS.steps),
        i18n: I18nMapSchema.optional(),
        bindings: BindingsSchema.optional(),
      })
      .strict(),
  ]),
);
// Dispatch before parsing the legacy branch: v2 getters must never be evaluated by it.
export const WorkflowSchema = z.unknown().transform((value, ctx) => {
  const version = readWorkflowVersion(value);
  if (version === 'invalid') {
    ctx.addIssue({ code: 'custom', message: 'Invalid workflow version' });
    return z.NEVER;
  }
  const parsed = version === 2 ? TypedWorkflow.safeParse(value) : LegacyWorkflow.safeParse(value);
  if (!parsed.success) {
    ctx.addIssue({ code: 'custom', message: 'Invalid workflow definition' });
    return z.NEVER;
  }
  return parsed.data;
});
export type Workflow = z.infer<typeof WorkflowSchema>;
export type Level1Tool = z.infer<typeof TypedTool>;
export type Level2Step = z.infer<typeof TypedStep>;
export type I18nMap = z.infer<typeof I18nMapSchema>;
