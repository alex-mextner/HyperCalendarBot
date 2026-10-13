# Local coverage gate

Run `BUN_BIN=/path/to/installed/bun-1.4.2 bash ci/local-ci.sh` (CI runs the same
script). The runner never installs dependencies or browsers. Chromium must already
be installed for the project's Playwright version. It runs typecheck, lint, then the
explicit `./test/` root once with coverage. The real-browser pool scenarios run in
their own child process (`test/worker/playwright-pool.test.ts`); a missing or
unlaunchable browser fails that test, it cannot skip. That child is not
instrumented, so `src/worker/playwright-pool.ts` lines count only through the
in-process tests. Browser tests use in-memory HTML, not external websites.

The denominator covers the bot's entire `src/` tree: TS/JS variants, including
`.d.ts` declarations and hidden files/directories (`dot: true`). `packages/` contains
separate products; packages, scripts (including the Python transports), tests and CI
tooling are outside this **bot source** metric. This is not a full-repository or
Python coverage claim.

Bun only emits LCOV for loaded sources. The JSON therefore reports:

- `sourceFiles`: complete matching source inventory.
- `loaded`: unique normalized source-path/DA-line pairs; repeated records for the
  same file merge hits by logical OR.
- `missingRuntime`: compiler-mapped runtime source lines absent from LCOV in loaded
  files. These lines are added to the denominator as uncovered. TypeScript emits
  source maps with comments removed; a signed VLQ decoder collects original line
  positions across all mapping segments. Mapping boundaries (including closing
  braces) are retained conservatively; this is not an exact executable-line count.
- `uninstrumented`: every wholly missing runtime source, with its physical line count.
- `noRuntime`: omitted sources whose TypeScript compiler output has no runtime
  statements, with physical line counts and `executableLines: 0`. The compiler
  transpiles with ESNext, Preserve, verbatimModuleSyntax and React JSX, then
  parses emitted JavaScript. Only an empty `export {}` module marker is ignored.
  Interfaces, type-only imports/exports and ambient declarations can therefore
  contribute zero; value imports, side-effect imports, enums, functions and
  runtime entrypoints remain in the denominator. No path exclusion list is used.
  Invalid source diagnostics fail classification closed. Compiler version and
  emission settings are included in the summary.
- `conservative`: loaded covered lines divided by the union of loaded DA lines
  and compiler-mapped runtime lines, plus **all physical lines** of uninstrumented
  runtime files counted uncovered. Missing mapped lines, blank lines,
  comments and declarations inside runtime modules remain in that fallback. A final
  newline is a terminator, not another line. Empty files contribute zero.

The fallback is a conservative bound, not an invented executable-line count or
fake execution. The gate compares its unrounded ratio against 0.8. The loaded
ratio alone cannot pass the gate. Missing/empty reports, malformed DA counters,
truncated records, DA positions outside actual source line bounds, and inconsistent
LF/LH summaries fail closed. A completed but shortened record cannot remove mapped
runtime lines from the denominator. CLI and boundary tests use the same evaluator.

This is report validation under trusted source/compiler/runner inputs. It cannot
prove reported hits are genuine or protect against a malicious CI runner, forged
hit counts, or source edits. No module imports are executed to collect this inventory.

Every invocation creates `coverage/full-XXXXXXXX/` with its own LCOV, a
`tests.json` exit status and `summary.json` inventory.
A summary's `passed` refers only to the coverage threshold; the shell also
requires the test process to succeed. Failed tests' reports remain diagnostic
evidence, never a passing CI result. No old report is consumed or overwritten.
Ordinary targeted tests do not collect coverage by default; use `--coverage-dir=coverage/targeted` for explicit targeted
coverage. Regression runner fixtures are synthetic
filesystem/process-boundary tests, not application coverage evidence.
