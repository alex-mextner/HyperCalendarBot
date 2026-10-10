# Claude reserve provider — measurements behind the request shape (2026-10-09/10)

Claude Sonnet 5.5 (smart chain) and Haiku 5.5 (fast chain) follow z.ai in both default chains
(#781, #782). This note records what was measured to choose the request shape (#786). Every row is
a small controlled live sample against Anthropic's OpenAI-compatible endpoint, not natural traffic
and not a percentile claim.

## Inputs
- Anonymized corpus `scripts/dryrun-cases.ts`, 23 cases, sha256 `8042c33e…43011af6`; system prompt and
  tool catalog as of tree `6c4378b83e76` (`system-prompt.ts` `f8376efa…`, `tools.ts` `090799d1…`).
- Private copy of 49 production AI debug logs (2026-09-18 … 2026-10-05; combined sha256 of the sorted
  per-file hashes `de341a9c…5b36`). Logs truncate tool arguments and results at 200–600 characters, so
  replays re-execute first rounds with the recorded tool results; nothing executes against real data.
- Raw results, probe sources and an append-only summary are retained privately (0700) as
  `benchmark-history/20261010T013000Z-claude-reserve/` with a `SHA256SUMS` manifest. No conversation
  text, calendar data or credentials are published.

## Request shape history
| Commit | Thinking control sent | temperature | max_tokens |
|---|---|---|---|
| 73b05ef4 | Haiku fast `thinking: disabled` | omitted | caller budget |
| 66c665c3 | Sonnet 5.5 `between_tools`; others `disabled` | omitted | caller budget |
| c7daca39 (merged #782) | `reasoning_effort: medium` | omitted | budget + max(budget, 1024) |
| #787 | none (model default) | omitted | 5.x: budget + 8192; Haiku 4.5: budget |

`temperature` is rejected with 400 by Claude 5.5. Adaptive thinking is rejected with 400 by this
endpoint. Sonnet 5.5 accepts only `between_tools` as an off switch; `claude-sonnet-5` and both Haiku
ids accept only `disabled`.

## Results
| Run | Sample | Outcome |
|---|---|---|
| Haiku summary, 256 tokens, default thinking | 1 synthetic | 0 characters, finish `length` (origin of the reserve) |
| Thinking controls, one real logged prompt, 3 runs each | Haiku 5.5 hidden-token median | `reasoning_effort` low/medium/high/absent: 780/826/830/833 |
| same | Sonnet 5.5 | 340/784/694/711 (no ordering) |
| same | `output_config.effort` low vs high; `thinking.budget_tokens` 1024 vs 4096 | no consistent change; peak Haiku think 2052 tokens |
| Cap acceptance, 4096 + 8192 | sonnet-5-5, haiku-5-5, sonnet-5, haiku-4-5 | all accepted |
| `aiStreamRound` fast chain = Haiku 5.5, 13 real logged prompts × 256/400 | 26 calls | 0 empty, 0 `length`, peak 1128 completion tokens incl. thinking |
| Corpus first move | Haiku 5.5, #787 shape | 22/23 (miss: read-only `find_contact`) |
| 49-log Sonnet replay, three earlier shapes | 49 × 3 | 0 provider/protocol errors each |
| Haiku validator on 34 logged final answers | thinking off / thinking on | 17 / 12 approved; flips reviewed by hand: mostly real defects in the old answers, two harness artefacts |

## Decision
Thinking stays on at the model's own level; the endpoint offers no working effort control.
`max_tokens` is a shared cap for hidden thinking and the visible answer, so Claude 5.x requests carry a
fixed 8192-token reserve on top of the caller's budget (unused reserve is not billed). Haiku 4.5 does
not think and gets the plain budget. Native Messages API support would be needed for a real effort
setting.
