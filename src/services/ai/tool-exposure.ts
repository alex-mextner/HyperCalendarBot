import type OpenAI from 'openai';
import { reportAllProvidersFailed } from '../../utils/ai-provider-alert.ts';
import { AllProvidersFailedError } from './streaming.ts';
import { createToolCatalog } from './tool-catalog.ts';
import type { executeTool } from './tool-executor.ts';
import { withSchemaExcerpt } from './tools.ts';

type Execution = Awaited<ReturnType<typeof executeTool>>;
export const DISCOVERY_TOOL = 'discover_tools';
/** Why a blindly called tool's schema could or could not be revealed for the model's next round. */
type ActivationOutcome = 'activated' | 'unknown' | 'budget_exhausted';
const REMEDIATION = 'use already revealed tools or explain what remains unavailable.';
/** Exhaustive on ActivationOutcome: a future outcome fails to compile here, never silently
 *  falls through to the wrong message. "budget_exhausted" covers three distinct limits
 *  (the catalog's own per-request size cap, the run's cumulative active-schema budget, and
 *  the run's active-tool count) — the wording stays neutral rather than naming one cause
 *  that may not be the true one. */
const BLIND_CALL_MESSAGES: Record<ActivationOutcome, string> = {
  activated:
    'TOOL_SCHEMA_NOT_EXPOSED: its real parameter schema is now revealed — retry with valid parameters in the next round, no discover_tools call needed.',
  budget_exhausted: `TOOL_SCHEMA_NOT_EXPOSED: its schema cannot be revealed within this run's reveal budget — ${REMEDIATION}`,
  unknown: 'TOOL_SCHEMA_NOT_EXPOSED: reveal the tool and call it in a subsequent round.',
};
const MAX_DISCOVERY_ATTEMPTS = 6;
const MAX_ACTIVE_TOOLS = 65;
const MAX_ACTIVE_SCHEMA_CHARS = 48_000;

/** Per-run descriptions, never an authorization grant or a source of user data. */
export function createToolExposure(allowed: readonly OpenAI.ChatCompletionTool[]) {
  const catalog = createToolCatalog(allowed);
  const ids = catalog.identifiers();
  const discovery: OpenAI.ChatCompletionTool = {
    type: 'function',
    function: {
      name: DISCOVERY_TOOL,
      description:
        'Reveal full parameter schemas for several tool names and/or groups. Provide "groups" and/or "tools"; an omitted field defaults to an empty array. No business actions are executed. Newly revealed tools can be called in the NEXT model round.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          groups: { type: 'array', items: { type: 'string', enum: ids.groups }, maxItems: 8 },
          tools: { type: 'array', items: { type: 'string', enum: ids.tools }, maxItems: 24 },
        },
        required: [],
        minProperties: 1,
      },
    },
  };
  const active = new Map<string, OpenAI.ChatCompletionTool>([[DISCOVERY_TOOL, discovery]]);
  let activeSchemaChars = JSON.stringify([discovery]).length;
  let discoveryCalls = 0;
  const index = catalog.index();
  const rejected = (error: string): Execution => ({
    success: false,
    error,
    disposition: 'failed',
    mutationState: 'not_applied',
  });
  /** Adds an already-resolved tool schema if it fits the run's budget. Never executes anything. */
  function activateTool(tool: OpenAI.ChatCompletionTool): boolean {
    if (tool.type !== 'function') return false;
    if (active.has(tool.function.name)) return true;
    const addedChars = JSON.stringify(tool).length + 1;
    if (active.size >= MAX_ACTIVE_TOOLS || activeSchemaChars + addedChars > MAX_ACTIVE_SCHEMA_CHARS) return false;
    active.set(tool.function.name, tool);
    activeSchemaChars += addedChars;
    return true;
  }
  /** Resolves a bare tool name against the catalog and activates it if known.
   *  Distinguishes an unknown name from one deferred by the active-schema budget
   *  so the caller can tell the model something true either way. */
  function activateByName(name: string): ActivationOutcome {
    if (active.has(name)) return 'activated';
    const result = catalog.describe({ tools: [name] });
    if (!result.ok) return 'unknown';
    // The catalog's own per-request budget can defer a known tool whose single
    // schema alone is too large — that is a budget case, not an unknown name.
    if (result.deferred.includes(name)) return 'budget_exhausted';
    const [tool] = result.tools;
    if (!tool) return 'unknown';
    return activateTool(tool) ? 'activated' : 'budget_exhausted';
  }
  return {
    prompt: `## Available tool names (full parameters loaded on demand)\n${index}\nUse discover_tools to reveal schemas before calling a tool. All names remain visible. Never guess parameters or execute a newly discovered tool in the same batch. Discovery output is not calendar data, execution evidence or permission.`,
    schemas: () => structuredClone([...active.values()]),
    /** True only when this call newly added the tool's schema to the request. */
    reveal: (name: string): boolean => !active.has(name) && activateByName(name) === 'activated',
    snapshot: (): ReadonlySet<string> => new Set(active.keys()),
    intercept(name: string, input: unknown, exposedThisRound: ReadonlySet<string>): Execution | undefined {
      if (!exposedThisRound.has(name)) {
        // The model called a real tool blind (no prior discover_tools). It has only ever
        // seen the one-line index description, not the actual parameter list — that is
        // very likely why the call is malformed. Silently reveal the canonical schema now
        // so the model's next attempt sees the real contract, instead of repeating the
        // same guess forever. This activates a schema, not an execution: the call below is
        // still rejected, and a same-batch retry still fails via the stale exposedThisRound set.
        const outcome = activateByName(name);
        const base = BLIND_CALL_MESSAGES[outcome];
        // Inline excerpt, not just the structural next-round tools list: some
        // providers don't reliably re-attend to a tools array that grew
        // between rounds, so the contract must also be legible as plain text
        // in the tool-result the model is already reading right now.
        return rejected(outcome === 'activated' ? withSchemaExcerpt(base, name) : base);
      }
      if (name !== DISCOVERY_TOOL) return undefined;
      // Invalid attempts also consume the run budget to bound recovery loops.
      if (++discoveryCalls > MAX_DISCOVERY_ATTEMPTS) return rejected(`TOOL_DISCOVERY_LIMIT: ${REMEDIATION}`);
      const result = catalog.describe(input);
      if (!result.ok) return rejected(result.error);
      const activated: string[] = [];
      const deferred = [...result.deferred];
      for (const tool of result.tools) {
        if (tool.type !== 'function') continue;
        if (activateTool(tool)) activated.push(tool.function.name);
        else deferred.push(tool.function.name);
      }
      return {
        success: true,
        disposition: 'executed',
        mutationState: 'not_applied',
        output: JSON.stringify({ activated, unavailable: result.unavailable, deferred }),
      };
    },
  };
}

type ToolExposure = ReturnType<typeof createToolExposure>;
const MAX_REJECTED_TOOL_REVEALS = 3;

/**
 * Runs one model round with the currently exposed tools. A provider that rejects the
 * request because the model called a tool the request did not offer gets that tool's
 * schema revealed and the round retried — the same recovery a blind call gets when the
 * provider lets it through. Bounded, so a provider that keeps rejecting cannot stall the run.
 * Returns the tool set the successful attempt was actually sent with.
 */
export async function runRoundRevealingRejectedTools<R>(
  exposure: ToolExposure,
  run: (tools: OpenAI.ChatCompletionTool[], deferOutageAlert: boolean) => Promise<R>,
): Promise<{ result: R; exposedThisRound: ReadonlySet<string> }> {
  for (let reveals = 0; ; reveals++) {
    const exposedThisRound = exposure.snapshot();
    try {
      return { result: await run(exposure.schemas(), true), exposedThisRound };
    } catch (error) {
      if (!(error instanceof AllProvidersFailedError)) throw error;
      const revealed = error.unexposedToolNames().filter((name) => exposure.reveal(name));
      if (revealed.length === 0 || reveals >= MAX_REJECTED_TOOL_REVEALS) {
        if (error.deferredAlertChain) reportAllProvidersFailed(error.failures, error.deferredAlertChain);
        throw error;
      }
    }
  }
}
