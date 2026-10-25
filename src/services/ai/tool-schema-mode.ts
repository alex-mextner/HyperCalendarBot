// A leaf on purpose: the config layer validates AI_TOOL_SCHEMA_MODE against this list and the
// agent, the agent config type and the tool exposure read it, so none of them may import another
// for it.

/**
 * How much of the tool catalog a request carries.
 *  - `full`: every schema in every request (the default).
 *  - `lazy`: discover_tools and calculate, with every other tool revealed on demand.
 *  - `hybrid`: discover_tools and the tools production calls most, with a compact index of the rest.
 */
export const TOOL_SCHEMA_MODES = ['full', 'lazy', 'hybrid'] as const;

export type ToolSchemaMode = (typeof TOOL_SCHEMA_MODES)[number];

/** The modes that put a discovery step between the model and some of the catalog. */
export type PartialToolSchemaMode = Exclude<ToolSchemaMode, 'full'>;
