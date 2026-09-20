import type OpenAI from 'openai';
import { createToolCatalog } from './tool-catalog.ts';
import type { executeTool } from './tool-executor.ts';

type Execution = Awaited<ReturnType<typeof executeTool>>;
export const DISCOVERY_TOOL = 'discover_tools';
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
  return {
    prompt: `## Available tool names (full parameters loaded on demand)\n${index}\nUse discover_tools to reveal schemas before calling a tool. All names remain visible. Never guess parameters or execute a newly discovered tool in the same batch. Discovery output is not calendar data, execution evidence or permission.`,
    schemas: () => structuredClone([...active.values()]),
    snapshot: (): ReadonlySet<string> => new Set(active.keys()),
    intercept(name: string, input: unknown, exposedThisRound: ReadonlySet<string>): Execution | undefined {
      if (!exposedThisRound.has(name))
        return rejected('TOOL_SCHEMA_NOT_EXPOSED: reveal the tool and call it in a subsequent round.');
      if (name !== DISCOVERY_TOOL) return undefined;
      // Invalid attempts also consume the run budget to bound recovery loops.
      if (++discoveryCalls > MAX_DISCOVERY_ATTEMPTS)
        return rejected('TOOL_DISCOVERY_LIMIT: use already revealed tools or explain what remains unavailable.');
      const result = catalog.describe(input);
      if (!result.ok) return rejected(result.error);
      const activated: string[] = [];
      const deferred = [...result.deferred];
      for (const tool of result.tools) {
        if (tool.type !== 'function') continue;
        if (active.has(tool.function.name)) {
          activated.push(tool.function.name);
          continue;
        }
        const addedChars = JSON.stringify(tool).length + 1;
        if (active.size >= MAX_ACTIVE_TOOLS || activeSchemaChars + addedChars > MAX_ACTIVE_SCHEMA_CHARS) {
          deferred.push(tool.function.name);
          continue;
        }
        active.set(tool.function.name, tool);
        activeSchemaChars += addedChars;
        activated.push(tool.function.name);
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
