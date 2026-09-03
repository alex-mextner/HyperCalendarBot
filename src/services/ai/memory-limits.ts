/**
 * The two ceilings on what a user's remembered facts may cost, kept together
 * because they only make sense against each other, and in a leaf module that
 * imports nothing so the prompt builder, the tool schema and the tool handler
 * can all read them without a cycle.
 *
 * The prompt is re-sent whole on every round of every message, so the section
 * they are read back into needs a ceiling; a single fact allowed to approach it
 * would crowd out every other fact, and one that exceeds it would be skipped on
 * every read — left in the table permanently invisible, and unfixable, since
 * the model cannot rewrite what it never sees. So the section is capped, and a
 * fact is capped at a quarter of the section.
 */
export const MEMORY_SECTION_MAX_CHARS = 2_000;
export const MEMORY_FACT_MAX_CHARS = 500;
