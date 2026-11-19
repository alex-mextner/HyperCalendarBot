# Native Claude caching and attempt accounting

Refs #826, acceptance A3.

## Evidence and scope

Production at `90ee425826f9bd0e194e4f43e0962d6be997d6ee` uses Anthropic chat completions. The preceding seven days through 2026-11-19 00:45 UTC contain 88 Claude attempts; every cached token field is unknown. The OpenAI compatibility endpoint cannot cache prompts. Existing static-first prompt parts already expose a suitable boundary.

## Work

- [x] Preserve the existing credential pool and SDK cancellation while translating native Messages streams into the existing round contract.
- [x] Cache the deterministic tools and static system prefix separately from per-user/time context; retain default five-minute cache duration.
- [x] Store native fresh input, cache writes, cache reads and the actual credential fingerprint per attempt, keeping historical/missing usage unknown.
- [x] Cover wire payload, text/tools, cumulative usage, malformed/aborted streams and credential failover with synthetic regression tests.
- [ ] Obtain independent review and run normal verification in real CI; ship through existing gates.
- [ ] Verify the exact deployed adapter records a cache write then read on two bounded read-only calls with no bot delivery or calendar mutation.

No provider order, account exclusions, tool execution/replay behavior or global configuration changes are included. Historical per-account token splits cannot be reconstructed because the ledger did not record the selected key.

## Runtime contract

`AI_CLAUDE_TRANSPORT` defaults to `native`. `openai` is a scoped transport rollback; it does not provide prompt caching. All calendar Claude calls, including history and validators, use the shared streaming slot. The native request caches the stable system prefix and the last initial tool definition, and enables automatic growing-history caching only for explicitly marked agent/tool-loop prompts. One-shot history and validator calls cache their stable prefix without paying to write unique dynamic inputs. All breakpoints use the default five-minute duration.

Native assistant content is kept only in private in-memory maps for the current run, including empty thinking blocks, signatures, redacted blocks and text/tool ordering. It is never rendered, logged, persisted in chat history, or serialized to other providers. Completed native tool loops reuse the original request prefix. Hybrid discovery appends documented `tool_addition` system blocks with `inline-tools-2026-09-15`; it does not rewrite top-level tools. Unexpected changes to earlier messages, system text or existing schemas fail before HTTP. Historical chat rows start a new run without native reasoning metadata, as their prompt/history prefix is rebuilt.

## Accounting and verification

`scripts/report-ai-usage.ts --json --days 1` or `--days 7` includes `claudeAccounts` once any native-attributed row exists. Each model/credential group retains full input, fresh input, cache writes, cache reads and output separately. Historical rows stay in the unknown-credential group. Request-level unknown cached totals are null. Latency aggregates expose known/unknown row coverage instead of turning missing cache counters into zero. Request-owned usage observers isolate concurrent cancellations even when they share the same abort reason. Failed or cancelled streams retain the latest observed usage; output on such rows is a lower bound, because a terminal usage event may never arrive. Preflight rejects occur before credential rotation and HTTP and do not establish billed provider calls. These records are application telemetry, not an Anthropic invoice, and do not reconstruct unrecorded historical HTTP retries.

Focused synthetic tests exercise the real installed SDK HTTP and named-SSE path, durable SQLite migration/round trip, native account aggregates, pool timeout/fallback attribution, interrupted-stream usage and exact two-round opaque/tool continuity. Corrective validation retries preserve the original completed assistant object, including private replay metadata. Native SDK logging is disabled so debug configuration cannot expose the key or opaque blocks. Migration 071 is appended inline to preserve the existing migration gate and byte-identical historical entries. Full tests, coverage and typecheck run only in established CI. Production acceptance still requires the deployed adapter to show a cache creation followed by a cache read on two bounded no-delivery/no-mutation requests.

Primary references: [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [thinking tool workflows](https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows), [append-only tool changes](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking/change-tools-or-instructions).
