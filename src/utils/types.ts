/**
 * Dynamic JSON object with no known compile-time schema.
 * Use only for genuine JSON blobs from the DB, external APIs, or runtime evaluation
 * where no typed interface can describe the structure.
 *
 * Prefer a specific interface whenever the shape is known.
 */
export type JsonObject = Record<string, unknown>;
