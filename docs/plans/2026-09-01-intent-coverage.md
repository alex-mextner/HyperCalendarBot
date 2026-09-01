# Intent coverage — fix, prune, extend (2026-09-01)

Context: on 2026-09-01 every AI provider in the fallback chain failed at once and the bot
answered nothing for hours. The pre-AI `IntentMatcherLayer` was supposed to keep simple
requests working. This plan makes that layer actually usable, removes the parts of it that
would silently corrupt user calendars, and adds a real degraded mode.

## What the investigation established (read before executing)

Measured against the production database copied on 2026-09-01.

- 46 intents exist: 17 approved, 21 pending, 8 rejected.
- Real user traffic in `chat_history`: 362 user rows, of which 109 are button/command JSON
  blobs and 80 are off-topic chatter from one group chat. The real corpus of
  natural-language, bot-directed messages is **173**.
- Replaying that corpus through the real `IntentMatcher`: today's 17 approved intents match
  **9 / 173 = 5.2 %**.
- Approving all 21 pending intents raises it to 14.5 %, but **14 of the 16 new matches come
  from one intent, `#24 create_event_with_invitation`**, whose workflow hardcodes
  `start_at: {{dates.today}}T19:00:00` — it would create an event today at 19:00 with a
  garbage title for messages like "На завтра на 11 утра поставь прогулку … пригласи
  Виталика". That is silent data corruption, not coverage.
- **Every read intent currently prints raw agent-facing debug text to the user.**
  `get_events` returns `output` as `id: 142, title: Нотариус, start: 2026-09-02T13:00:00+02:00,
  created_by: @alex`, and `formatResponse` passes it through unchanged for every existing
  `format` value. `show_today` / `show_tomorrow` / `show_week` are all 8 of the 8 recorded
  `intent_match` rows in `user_action_log` — so this is what users actually saw.
- **A matched intent does not currently bypass the AI.** `intent-matcher-layer.ts` returns
  `needsSupplement: true`, so the AI agent still runs in supplement mode afterwards. In normal
  operation the ugly dump is followed by a clean AI answer; during the outage the dump was all
  there was.
- `workflow-validator.ts` validates variables but **never validates tool names or their
  required parameters**. That is why `#4` calls a non-existent `render_image`, `#20` calls a
  non-existent `get_day_of_week_date`, `#46` passes `query` to `find_user` (which requires
  `username`), and `#33` passes `telegram_id`/`scope` to `send_invitation` (which requires
  `event_id` + `invitee_id`).
- In group chats `message.handler.ts` prepends `[Group: X, From: Y] ` to the text before
  matching, so exact phrases and every `^`-anchored pattern can never fire there. Intents are
  effectively dead in groups today.
- 25+ slash commands (`/today`, `/tomorrow`, `/week`, `/free`, `/month`, `/search`,
  `/settings`, `/add`) are handled before the pipeline and need no AI. **They kept working
  through the whole outage.** The failure message never mentioned them.

Guiding rule adopted by this plan: **read intents are safe and stay always-on; write intents
are only allowed behind an explicit `ask_user` confirmation.** Rationale in the "Trade-off"
section at the bottom.

---

## Stage 0 — Safety rails first (do these before touching any intent row)

- [ ] Add tool-name and required-parameter validation to `workflow-validator.ts`. Import the
      tool registry from `src/services/ai/tools.ts`, and for every `call` / `tools[].name` in
      a workflow: reject unknown tool names, and reject a step whose `input` omits a key listed
      in that tool's `input_schema.required`. Exempt the DSL pseudo-calls `ask_user` and
      `respond`. This is the gate that would have blocked `#4`, `#20`, `#33`, `#46` at
      creation time.
- [ ] Test: `test/services/intent/workflow-validator.test.ts` — add cases for an unknown tool
      name, a missing required parameter, and a valid workflow that still passes. Assert the
      error message names the offending tool and parameter.
- [ ] Make the admin Accept path re-validate before approving. In
      `callback.handler.ts` (`intent_accept`), run the validator against the stored workflow
      and refuse the approval with the validation error instead of setting
      `status = 'approved'`. Today Accept blindly trusts whatever the learner produced.
- [ ] Test: approving an intent whose workflow references a non-existent tool leaves
      `status` unchanged and reports the error to the admin.
- [ ] Reject an already-approved intent must drop it from the live index. In the
      `intent_reject` branch, call `intentMatcher.reload()` after `updateStatus(id,'rejected')`
      — currently only Accept reloads, so rejecting an approved intent leaves it firing until
      the next restart.
- [ ] Test: reject-then-match no longer returns that intent.

## Stage 1 — Make intent output readable (the highest-impact fix)

The goal: an intent answer must be indistinguishable from what `/today` sends. Do **not**
parse the tool's text output — the repo forbids parsing structured data out of `output`.
Carry the typed `ToolResult.data` through instead.

- [ ] Add `lastData?: ToolResultData` to `ExecutorResult` in `intent-executor.ts` and populate
      it from the final successful tool step (alongside the existing `lastToolOutput`).
- [ ] Change `formatResponse(format, output, timezone, language)` in `response-formatter.ts`
      to accept an optional typed `data` argument, and add a new format value `agenda` that
      renders an `EventSummary[]` as `HH:MM  Title` lines under a date header, empty state
      included. Reuse the wording and shape of `formatDayAgenda` in
      `src/services/event/formatters.ts` rather than inventing a second style.
- [ ] Fix the existing `events_list` / `free_slots` / `search_results` / `holidays` /
      `settings` branches to read from typed `data` when it is present, falling back to the
      current JSON-string parsing only when it is not.
- [ ] Pass `result.lastData` from `intent-matcher-layer.ts` into `formatResponse`.
- [ ] Test: `test/services/intent/response-formatter.test.ts` — feed a realistic
      `EventSummary[]` and assert the rendered text contains `13:00  Нотариус` and contains
      **no** `id:`, no `created_by:`, and no raw ISO timestamp. This is the regression test for
      the internal-ID leak.
- [ ] Test: empty event list renders the empty-state line, not `""` and not `[]`.
- [ ] Switch intents `#2 show_today`, `#8 show_tomorrow`, `#9 show_week`,
      `#17 show_next_week`, `#10 free_slots_today`, `#11 search_events_by_query` to
      `format = 'agenda'` (`free_slots` for `#10`, `search_results` for `#11`) via a migration
      in `src/database/migrations.ts` that updates the `format` column for those
      `canonical_name` values. Append a new migration — never renumber.
- [ ] Test: an integration test in `test/bot/pipeline/intent-matcher-layer.test.ts` that runs
      `show_tomorrow` end to end with a stub `get_events` returning typed data, and asserts the
      string sent to the user is the agenda rendering.

## Stage 2 — Remove the intents that would corrupt data

Each of these is set to `rejected` by a migration, with the reason recorded in the migration
comment. Do not `DELETE` the rows — keep them for audit.

- [ ] `#24 create_event_with_invitation` — hardcodes `today T19:00` and a catch-all
      `^(?:(.+?)\s+)?(?:пригласи|invite)\s+(.+)$` pattern; matched 14 real multi-part messages
      it cannot represent. Highest-severity row in the table.
- [ ] `#46 invite_user_by_name` — passes `query` to `find_user`, which requires `username`;
      catch-all pattern.
- [ ] `#33 invite_user` — passes `telegram_id`/`scope` to `send_invitation`, which requires
      `event_id` + `invitee_id`.
- [ ] `#35 invite_to_event` — catch-all pattern, and sends an invitation to
      `{{last_mentioned_event.id}}` which is frequently unset. Overlaps approved `#6`.
- [ ] `#45 add_contact_and_send_invitation` — a five-capture-group regex over freeform text.
- [ ] `#30`, `#31`, `#34`, `#36`, `#37` (the `create_event_*` family) — five overlapping
      unconfirmed calendar writes. Real creation traffic carries addresses, participants and
      multi-line bodies that these patterns truncate into the title. Keep `#12` as the single
      creation intent, because it is the only one that asks for confirmation first.
- [ ] `#29 delete_last_mentioned_duplicate` — deletes an event from a bare phrase with no
      confirmation and no reliable event context.
- [ ] `#32 mark_me_upcoming` — writes participation with no event context.
- [ ] `#25 show_upcoming` — phrases are `как дела`, `что нового`, `how are you`. Answering a
      greeting with a calendar dump is wrong; the greeting belongs to the AI.
- [ ] `#20 show_day_of_week` — calls the non-existent `get_day_of_week_date`. The concept is
      good; file a follow-up issue for a `dates.weekday(<name>)` resolver, then re-add it.
- [ ] `#41 convert_time_to_utc` — duplicate phrase `в мире` listed twice, no pattern, low value.
- [ ] `#3 show_day_plan` and `#5 show_week_plan` — pure duplicates of approved `#2` / `#9`.
      Before rejecting, merge their non-duplicate phrases into `#2` and `#9` with
      `appendPhrases`, so the phrasing coverage is not lost.
- [ ] Test: after the migration, replay the 173-message corpus fixture through
      `IntentMatcher.load(approved)` and assert that **no message matches a write intent
      without a confirmation step**. Commit the corpus as an anonymized fixture
      (`test/fixtures/intent-corpus.json`) containing message shapes only — no names,
      addresses, usernames or personal content.

## Stage 3 — Fix the approved intents that stay

- [ ] `#6 invite_user_to_event` — the `pick_users` prompt is a hardcoded Russian string sent to
      every user regardless of language. Move it to an `i18n` block.
      RU: `Выбери @{{$1}} в списке контактов для приглашения на «{{last_added_event.title}}».`
      EN: `Pick @{{$1}} from your contacts to invite to “{{last_added_event.title}}”.`
      (note: "Выбери", not "Выберите" — the bot addresses the user as "ты").
- [ ] `#6` — add a first step that responds and stops when `last_added_event.id` is unset,
      instead of calling `pick_users` with an empty event id.
      RU: `Не понял, на какое событие приглашать. Создай событие или назови его.`
      EN: `Not sure which event to invite to. Create one first, or name it.`
- [ ] `#7 make_calendar_call` — hardcoded Russian call text. Move to `i18n`.
      RU: `Привет, {{user.first_name}}! Это твой календарь. Чем помочь?`
      EN: `Hi {{user.first_name}}! This is your calendar. How can I help?`
- [ ] `#13 set_timezone_belgrade` — writes settings and returns the raw `manage_settings`
      output. Add a `respond` step.
      RU: `🌍 Часовой пояс: Белград (Europe/Belgrade)`
      EN: `🌍 Timezone: Belgrade (Europe/Belgrade)`
- [ ] `#16 update_event_time` — moves an event with no confirmation, based on
      `last_mentioned_event`, which the user may not have in mind. Real traffic contains bare
      "Перенеси на 12". Insert an `ask_user` confirmation naming the event and both times, and
      gate the `update_event` step on the answer, exactly as `#12` does.
      RU question: `Перенести «{{last_mentioned_event.title}}» на {{$1}}:{{$2}}?`
      EN question: `Move “{{last_mentioned_event.title}}” to {{$1}}:{{$2}}?`
      RU cancel: `Отменено. Событие не тронул.`
      EN cancel: `Cancelled. Event unchanged.`
- [ ] `#15 show_conversation_history` — dumps 50 raw history rows; can exceed the 4096-char
      Telegram limit. Lower the limit to 15 and route the output through `splitMessage()` from
      `src/utils/telegram.ts`, or reject the intent if that is not worth the effort. Decide
      during implementation and record which.
- [ ] Test: each fixed intent gets a case in `test/services/intent/intent-executor.test.ts`
      asserting the i18n string is chosen by `user.language` and that the confirmation gate on
      `#16` blocks `update_event` when the answer is "нет" / "no".

## Stage 4 — Add new read-only intents

All of these are pure reads, end in a `respond` or a typed `format`, and cannot damage data.
Add them as a migration inserting rows with `status = 'approved'`.

- [ ] **`bot_capabilities`** — zero tools, pure canned answer, zero failure modes.
      `pattern`: null. `trigger_words`: `[]`.
      `phrases`: `["что ты умеешь","что умеешь","чем можешь помочь","твои возможности","what can you do","what do you do","your features"]`
      workflow: `{"steps":[{"respond":"{{t.msg}}"}],"i18n":{...}}`
      RU: `Календарь в чате. Напиши «завтра 14:00 нотариус» — создам событие. «Планы на завтра» — покажу день. /help — весь список.`
      EN: `Calendar in your chat. Write “tomorrow 14:00 notary” — I'll create the event. “Plans for tomorrow” — I'll show your day. /help — the full list.`
- [ ] **`show_upcoming_events`** — `get_upcoming` with `limit: 5`, `scope: {{env.scope}}`,
      `format: 'agenda'`.
      `pattern`: `^(?:что\s+дальше|что\s+ближайшее|ближайшие\s+события|what'?s\s+next|upcoming(?:\s+events)?|next\s+events?)\??$`
      `trigger_words`: `["дальше","ближайшие","ближайшее","next","upcoming"]`
      Note: deliberately does **not** include `как дела` — that is why `#25` is being rejected.
- [ ] **`show_holidays`** — `get_holidays` with `limit: 5`, `format: 'holidays'`.
      `pattern`: `^(?:какие\s+)?(?:ближайшие\s+)?праздники\??$|^(?:upcoming\s+)?holidays\??$`
      `trigger_words`: `["праздники","holidays"]`
- [ ] **`free_slots_tomorrow`** — mirror of `#10` with `{{dates.tomorrow}}`, `format: 'free_slots'`.
      `pattern`: `^(?:когда\s+(?:я\s+)?свободен\s+завтра|свободные\s+(?:окна|слоты)\s+завтра|free\s+slots?\s+tomorrow|when\s+am\s+i\s+free\s+tomorrow)\??$`
      `trigger_words`: `["свободен","свободные","free","slots"]`
- [ ] **`show_month`** — replaces the broken `#4`. Steps: `render_month_image` with
      `month: {{dates.month_start}}`, then `get_events` from `{{dates.month_start}}` to
      `{{dates.month_end}}`, `format: 'agenda'`.
      `pattern`: `^(?:что\s+(?:у\s+меня\s+)?(?:в\s+этом\s+)?месяц[еа]|план(?:ы)?\s+на\s+месяц|расписание\s+на\s+месяц|this\s+month|show\s+month|month\s+plan)\??$`
      `trigger_words`: `["месяц","месяце","month"]`
- [ ] **`get_timezone_setting`** — approve the existing `#47` as-is. It is the one pending
      intent that is already correct: `manage_settings {action:get, category:general}` returns
      JSON, so `{{tool_outputs.settings.timezone}}` resolves, and it ends in an i18n `respond`.
      Verify the rendered string reads `🌍 Твой часовой пояс: Europe/Belgrade`.
- [ ] **`show_reminders`** — `get_reminders` with `scope: {{env.scope}}`, then an i18n
      `respond` (or `agenda` if the typed data fits).
      `pattern`: `^(?:какие\s+)?(?:мои\s+)?напоминани[яй]\??$|^(?:my\s+)?reminders\??$`
      `trigger_words`: `["напоминания","напоминаний","reminders"]`
- [ ] Test: one case per new intent in a new `test/services/intent/seeded-intents.test.ts` that
      loads the seeded rows from a migrated in-memory DB, matches the canonical phrase, runs the
      workflow against a stub tool executor, and asserts the exact user-visible string.
- [ ] Test: negative cases — assert `как дела`, `привет`, `спасибо`, and a bare `завтра 14:00
      нотариус` (a creation message) do **not** match any of the new read intents.

## Stage 5 — Degraded mode (the actual outage fix)

This is the change that would have made 2026-09-01 survivable, independent of intent coverage.

> **Overlap warning — check before starting.** As of 2026-09-01 another agent has uncommitted
> work in the tree touching `src/bot/pipeline/ai-agent-layer.ts`, `src/config/constants.ts`,
> `src/services/ai/streaming.ts` and `src/utils/ai-provider-alert.ts`, and has already added
> `ai_degraded` strings that name the still-working commands
> (`🔧 ИИ недоступен — своими словами ответить не смогу.` + a commands hint). Reconcile with
> that work instead of reimplementing it — the first checkbox below may already be done.

- [ ] Confirm the AI-down message names the AI-free commands, in both languages, and that the
      old `something_wrong` Russian string no longer says "Попробуйте" ("вы" form, which
      violates the repo's tone-of-voice rule). If the parallel work already covers this, tick
      the box and move on.
- [ ] Add a lightweight AI-health signal: record the timestamp of the last successful and last
      failed provider round in `streaming.ts`, and expose `isAiDegraded()` (for example: the
      last N consecutive rounds all failed). No new table — in-memory is enough.
- [ ] When `isAiDegraded()` is true, skip the supplement AI call in
      `intent-matcher-layer.ts` / `ai-agent-layer.ts` so a matched intent answers instantly
      instead of waiting out the provider timeouts before the suppressed error.
- [ ] Test: with a stubbed always-failing `streamImpl`, a message that matches `show_tomorrow`
      still delivers the agenda, and a message that matches nothing delivers the degraded
      message naming the commands — not `something_wrong`.
- [ ] Alert on degradation through the existing `/admin/alerts` path used by
      `healthcheck-alert.sh`, so the next full-chain outage pages someone instead of being
      discovered hours later.

## Stage 6 — Measure whether coverage actually improved

- [ ] Log every intent-layer decision, not just the hits. `intent-matcher-layer.ts` already
      writes `intent_match` rows to `user_action_log`; add an `intent_miss` row (action_name =
      `none`, `input_summary` = first 200 chars) when `matcher.match()` returns null on a
      private-chat text message. Without the denominator there is no coverage metric — that is
      why this investigation had to reconstruct it from `chat_history`.
- [ ] Add `intent_fallthrough` logging for the case where an intent matched but its workflow
      failed and the layer returned `handled: false` (the existing admin notification path).
      A rising fallthrough rate is the signal that a pattern over-matches.
- [ ] Add a script `scripts/intent-coverage.ts` that reads a database path, replays every
      `role='user'` private-chat message through `IntentMatcher` loaded with approved intents,
      and prints: total messages, matched count and percentage, and a per-intent breakdown.
      Run it before and after this plan and record both numbers in the PR description.
- [ ] Baseline to beat, measured 2026-09-01 on 173 real messages: **5.2 % matched, and 100 %
      of those matches rendered raw debug text.** The realistic target after this plan is
      **8–11 % matched with 0 % raw output** — see the trade-off note below on why the ceiling
      is low and why chasing a higher number is the wrong goal.
- [ ] Add a weekly BullMQ repeating job on the `bot-tasks` queue that reports the last 7 days
      of `intent_match` / `intent_miss` / `intent_fallthrough` counts to the admin, so pattern
      drift shows up without anyone running a script.

---

## Trade-off: where intents make the product worse

This is the part worth arguing about, so it is written down rather than assumed.

**Intents are safe where the request is a closed question about existing data.** "Планы на
завтра", "какие праздники", "который час", "какой часовой пояс" — there is one correct answer,
the phrasing space is small, and a wrong match costs the user one useless message. The AI adds
nothing here except latency and a provider dependency.

**Intents are actively harmful where the request creates or changes data.** The evidence is
`#24`: a regex that looked plausible to the learner matched 14 real messages and would have
written 14 wrong events, each with a hardcoded 19:00 start and a title made of the leftover
sentence fragment. The user does not get an error — they get a confidently wrong calendar. The
AI would have parsed "на завтра на 11 утра" correctly. This is not a tuning problem; a regex
cannot represent "На завтра на 11 утра поставь прогулку с Виталиком по парку Калимегдан.
Добавь геолокацию и пригласи Виталика."

**The traffic is dominated by exactly the unsafe class.** Of 173 real messages: ~38 % are event
creation, ~8 % contextual edits ("Перенеси на 12", "В чт в то же время", "Окрашивание убери"),
~7 % bare confirmations that only make sense inside an open flow, ~16 % multi-line batch
requests. Closed read questions are **~6 %**. That is the honest ceiling, and it is why the
owner's hope of covering "most requests" with intents cannot be met — not because the patterns
are not clever enough, but because most requests are freeform authoring.

**Specific degradations to expect from the intents this plan keeps or adds:**

- `show_upcoming_events` will not understand "а что после обеда" — it answers the whole
  upcoming list. Acceptable: it is a read, and the AI supplement still runs normally.
- `show_holidays` ignores country context beyond the user's subscriptions. Acceptable.
- `#16 update_event_time` remains the riskiest survivor even with confirmation, because
  `last_mentioned_event` can point at something the user is not thinking about. The added
  `ask_user` step naming the event title is what makes it tolerable — if that step is dropped
  during implementation, reject the intent instead.
- `#6 invite_user_to_event` fires on `@user пригласи` and opens a contact picker. Low harm.
- Anything matching in a group chat is currently impossible because of the `[Group: …]` prefix.
  Do **not** "fix" that as a side quest — an unanchored pattern firing on casual group chatter
  is a new hijack surface, and the group corpus is 80 messages of pure off-topic conversation.

## Recommendation: default fast path, or degraded-mode fallback?

**Neither, as posed — and the code already settled half of it.** A matched intent today returns
`needsSupplement: true`, so the AI agent runs anyway in supplement mode. Intents are not a
bypass; they are a fast first answer with AI enrichment behind it. That is the right design and
should stay.

Concretely:

- **Read intents: always-on fast path.** The user gets a correct answer in milliseconds with no
  provider dependency, and the AI still gets to add nuance a moment later. If the AI is down,
  the fast answer is simply the whole answer. There is no scenario where this is worse than
  waiting for a model.
- **Write intents: not a fast path at all.** Allow them only with an `ask_user` confirmation
  step, which converts a silent wrong write into a visible question. `#12` already demonstrates
  the shape. Everything in Stage 2 fails this bar.
- **Degraded mode is a separate, more valuable lever than coverage.** During the outage, 25+
  slash commands worked perfectly and the bot never mentioned them. Stage 5 costs a few strings
  and a boolean and recovers more real capability than any number of new intent rows.

On matching confidence: the current matcher has none — `match()` returns the **first** candidate
regex that matches, where candidate order is the insertion order of the trigger index. There is
no scoring and no ambiguity handling, and `phraseMap.set()` lets a later intent silently
overwrite an earlier one's phrase (confirmed collisions: `расписание на сегодня`, `мой день` and
`plan for today` between `#2` and `#3`; `план на неделю`, `неделя`, `show week` between `#5` and
`#9`). Rather than bolting on a confidence score, this plan removes the ambiguity at the source:
delete the duplicate intents, forbid catch-all patterns, and require every write to confirm. If
a scoring layer is wanted later, the honest version is "longest matching pattern wins, and a tie
falls through to the AI" — but it should not be built before the duplicate rows are gone.

## Decide before implementation starts

1. **`#15 show_conversation_history`** — worth fixing (limit 15 + `splitMessage`) or reject?
2. **`#20 show_day_of_week`** — add a `dates.weekday(<name>)` resolver so weekday queries work,
   or leave weekday requests to the AI?
3. **Group chats** — leave intents effectively disabled there (current behaviour, and safe), or
   strip the `[Group: …]` prefix before matching and accept the hijack risk?
4. **Corpus fixture** — confirm that committing anonymized message *shapes* to
   `test/fixtures/` is acceptable, or keep the regression corpus out of the repo and run
   `scripts/intent-coverage.ts` against production manually.
