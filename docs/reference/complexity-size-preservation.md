# Document split byte/line audit for GH-860

Original: `2327f650f56b09fbb1362891349411af59d1562d`. First split: `0bdc82291b2241b07279814be389b537c1618887`. Current committed source: `bb7a9d4765e406b3c2c258fc4ad55445643857ac`.
The four restored Python fences are included explicitly below. Their complete original bytes and hashes are checked against the actual candidate files; later product changes remain separate.

Method: compare raw UTF-8 lines with line endings retained, `SequenceMatcher(autojunk=False)`. No banner, blank, escaping, heading or link is removed before comparison. Each hunk records source/destination ranges and raw SHA-256 in the linked machine-readable metadata. Complete old/new bytes are retained in the native raw evidence archive and can be reconstructed from the immutable source blobs. The public metadata contains hashes and ranges, not relocated document bodies.

All 22 originals are byte-identical between the issue baseline and the actual split parent. The split is therefore compared against that single exact original. Later product changes are reported separately.

## Plans and specifications

| Original | Original lines | Parts | Equal original lines after fence restoration, before later product changes | Raw change hunks |
|---|---:|---:|---:|---:|
| `docs/plans/2026-03-12-parser-recurrence-holidays.md` | 2897 | 4 | 2897 | 4 |
| `docs/plans/2026-03-13-ai-agent.md` | 2801 | 4 | 2801 | 4 |
| `docs/plans/2026-03-13-google-calendar-sync.md` | 3477 | 5 | 3477 | 5 |
| `docs/plans/2026-03-13-image-generation.md` | 2199 | 3 | 2195 | 6 |
| `docs/plans/2026-03-13-notifications.md` | 2853 | 4 | 2853 | 4 |
| `docs/plans/2026-03-16-voice-call-reminders.md` | 1774 | 3 | 1774 | 3 |
| `docs/plans/2026-03-17-bot-ux-automation.md` | 1781 | 2 | 1781 | 2 |
| `docs/plans/2026-03-17-group-chat-interaction.md` | 1779 | 2 | 1779 | 2 |
| `docs/plans/2026-03-18-group-commands.md` | 1258 | 2 | 1258 | 2 |
| `docs/plans/2026-03-18-invite-propose-time.md` | 1534 | 2 | 1534 | 2 |
| `docs/plans/2026-03-18-secretary-access.md` | 1439 | 2 | 1439 | 2 |
| `docs/plans/2026-03-19-bidirectional-voice.md` | 2154 | 3 | 2154 | 3 |
| `docs/plans/2026-03-19-scheduled-ai-calls.md` | 2143 | 3 | 2143 | 3 |
| `docs/plans/2026-03-20-ai-assistant-bot-server.md` | 2534 | 3 | 2534 | 3 |
| `docs/plans/2026-03-20-birthdays.md` | 1693 | 3 | 1693 | 3 |
| `docs/plans/2026-03-21-stt-corrections.md` | 2025 | 3 | 2025 | 3 |
| `docs/plans/2026-03-25-connect-telegram.md` | 3388 | 5 | 3388 | 5 |
| `docs/plans/2026-04-10-openai-sdk-migration.md` | 1555 | 2 | 1555 | 2 |
| `docs/specs/03-google-calendar-sync.md` | 1234 | 2 | 1234 | 2 |
| `docs/specs/05-image-generation.md` | 1277 | 2 | 1271 | 3 |

Bare index-plus-parts concatenation remains different for all 20 families because the added navigation remains present. This audit does not label those concatenations byte-identical.

### Every plan/spec split hunk

An empty old range denotes insertion at that boundary. New ranges include the complete added banners, contents links and blank separators. The four restored Python fences are covered by the restoration table, rather than silently normalized.

#### `docs/plans/2026-03-12-parser-recurrence-holidays.md`

| Original range | Destination range(s) | Classification |
|---|---|---|
| ∅ before L12 | [2026-03-12-parser-recurrence-holidays.md:L12–42](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-12-parser-recurrence-holidays.md#L12-L42); [01-tasks-1-4.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-12-parser-recurrence-holidays/01-tasks-1-4.md#L1) | Added navigation/banner/separator bytes |
| ∅ before L627 | [01-tasks-1-4.md:L617–617](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-12-parser-recurrence-holidays/01-tasks-1-4.md#L617); [02-tasks-5-10.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-12-parser-recurrence-holidays/02-tasks-5-10.md#L1) | Added navigation/banner/separator bytes |
| ∅ before L1420 | [03-tasks-11-13.md:L1–2](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-12-parser-recurrence-holidays/03-tasks-11-13.md#L1-L2) | Added navigation/banner/separator bytes |
| ∅ before L2129 | [03-tasks-11-13.md:L712–712](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-12-parser-recurrence-holidays/03-tasks-11-13.md#L712); [04-tasks-14-16.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-12-parser-recurrence-holidays/04-tasks-14-16.md#L1) | Added navigation/banner/separator bytes |

#### `docs/plans/2026-03-13-ai-agent.md`

| Original range | Destination range(s) | Classification |
|---|---|---|
| ∅ before L12 | [2026-03-13-ai-agent.md:L12–47](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-13-ai-agent.md#L12-L47); [01-tasks-1-6.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-13-ai-agent/01-tasks-1-6.md#L1) | Added navigation/banner/separator bytes |
| ∅ before L844 | [02-tasks-7-8.md:L1–2](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-13-ai-agent/02-tasks-7-8.md#L1-L2) | Added navigation/banner/separator bytes |
| ∅ before L1298 | [02-tasks-7-8.md:L457–457](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-13-ai-agent/02-tasks-7-8.md#L457); [03-tasks-9-11.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-13-ai-agent/03-tasks-9-11.md#L1) | Added navigation/banner/separator bytes |
| ∅ before L1881 | [03-tasks-9-11.md:L585–585](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-13-ai-agent/03-tasks-9-11.md#L585); [04-tasks-12-16.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-13-ai-agent/04-tasks-12-16.md#L1) | Added navigation/banner/separator bytes |

#### `docs/plans/2026-03-13-google-calendar-sync.md`

| Original range | Destination range(s) | Classification |
|---|---|---|
| ∅ before L10 | [2026-03-13-google-calendar-sync.md:L10–55](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-13-google-calendar-sync.md#L10-L55); [01-overview-tasks-1-4.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-13-google-calendar-sync/01-overview-tasks-1-4.md#L1) | Added navigation/banner/separator bytes |
| ∅ before L546 | [01-overview-tasks-1-4.md:L538–538](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-13-google-calendar-sync/01-overview-tasks-1-4.md#L538); [02-tasks-5-7.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-13-google-calendar-sync/02-tasks-5-7.md#L1) | Added navigation/banner/separator bytes |
| ∅ before L1223 | [02-tasks-5-7.md:L679–679](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-13-google-calendar-sync/02-tasks-5-7.md#L679); [03-tasks-8-11.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-13-google-calendar-sync/03-tasks-8-11.md#L1) | Added navigation/banner/separator bytes |
| ∅ before L1920 | [03-tasks-8-11.md:L699–699](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-13-google-calendar-sync/03-tasks-8-11.md#L699); [04-tasks-12-15.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-13-google-calendar-sync/04-tasks-12-15.md#L1) | Added navigation/banner/separator bytes |
| ∅ before L2807 | [05-tasks-16-24.md:L1–2](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-13-google-calendar-sync/05-tasks-16-24.md#L1-L2) | Added navigation/banner/separator bytes |

#### `docs/plans/2026-03-13-image-generation.md`

| Original range | Destination range(s) | Classification |
|---|---|---|
| ∅ before L12 | [2026-03-13-image-generation.md:L12–46](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-13-image-generation.md#L12-L46); [01-overview-tasks-1-5.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-13-image-generation/01-overview-tasks-1-5.md#L1) | Added navigation/banner/separator bytes |
| ∅ before L725 | [02-tasks-6-11.md:L1–2](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-13-image-generation/02-tasks-6-11.md#L1-L2) | Added navigation/banner/separator bytes |
| [L733–733](https://github.com/alex-mextner/HyperCalendarBot/blob/2327f650f56b09fbb1362891349411af59d1562d/docs/plans/2026-03-13-image-generation.md#L733) | [02-tasks-6-11.md:L11–11](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-13-image-generation/02-tasks-6-11.md#L11) | Required new spec path plus section-title reference replacing historical line numbers; exact old/new shown below |

```diff
-**Reference:** Full HTML/CSS template in `docs/specs/05-image-generation.md`, Section 9 (lines 758–1151).
+**Reference:** Full HTML/CSS template in `docs/specs/05-image-generation/02-sections-7-12.md`, Section 9 (Example Template: Daily Agenda).
```

| Original range | Destination range(s) | Classification |
|---|---|---|
| [L885–885](https://github.com/alex-mextner/HyperCalendarBot/blob/2327f650f56b09fbb1362891349411af59d1562d/docs/plans/2026-03-13-image-generation.md#L885) | [02-tasks-6-11.md:L163–163](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-13-image-generation/02-tasks-6-11.md#L163) | Required new spec path plus section-title reference replacing historical line numbers; exact old/new shown below |

```diff
-Port the template from `docs/specs/05-image-generation.md` Section 9 (lines 758–1151). The template is a full HTML document with inline CSS.
+Port the template from `docs/specs/05-image-generation/02-sections-7-12.md` Section 9 (Example Template: Daily Agenda). The template is a full HTML document with inline CSS.
```

| Original range | Destination range(s) | Classification |
|---|---|---|
| [L1368–1369](https://github.com/alex-mextner/HyperCalendarBot/blob/2327f650f56b09fbb1362891349411af59d1562d/docs/plans/2026-03-13-image-generation.md#L1368-L1369) | [02-tasks-6-11.md:L646–647](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-13-image-generation/02-tasks-6-11.md#L646-L647) | Required new spec path plus section-title reference replacing historical line numbers; exact old/new shown below |

```diff
-// ... Full implementation per spec lines 442-567 ...
-// See docs/specs/05-image-generation.md Section 5
+// ... Full implementation per spec Section 5 (Strategy: Single Browser, Context Pool) ...
+// See docs/specs/05-image-generation/01-overview-sections-1-6.md Section 5
```

| Original range | Destination range(s) | Classification |
|---|---|---|
| ∅ before L1522 | [02-tasks-6-11.md:L800–800](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-13-image-generation/02-tasks-6-11.md#L800); [03-tasks-12-17.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-13-image-generation/03-tasks-12-17.md#L1) | Added navigation/banner/separator bytes |

#### `docs/plans/2026-03-13-notifications.md`

| Original range | Destination range(s) | Classification |
|---|---|---|
| ∅ before L12 | [2026-03-13-notifications.md:L12–41](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-13-notifications.md#L12-L41); [01-tasks-1-5.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-13-notifications/01-tasks-1-5.md#L1) | Added navigation/banner/separator bytes |
| ∅ before L779 | [01-tasks-1-5.md:L769–769](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-13-notifications/01-tasks-1-5.md#L769); [02-tasks-6-9.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-13-notifications/02-tasks-6-9.md#L1) | Added navigation/banner/separator bytes |
| ∅ before L1594 | [03-tasks-10-12.md:L1–2](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-13-notifications/03-tasks-10-12.md#L1-L2) | Added navigation/banner/separator bytes |
| ∅ before L2115 | [03-tasks-10-12.md:L524–524](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-13-notifications/03-tasks-10-12.md#L524); [04-tasks-13-17.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-13-notifications/04-tasks-13-17.md#L1) | Added navigation/banner/separator bytes |

#### `docs/plans/2026-03-16-voice-call-reminders.md`

| Original range | Destination range(s) | Classification |
|---|---|---|
| ∅ before L17 | [2026-03-16-voice-call-reminders.md:L17–49](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-16-voice-call-reminders.md#L17-L49); [01-overview-tasks-1-4.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-16-voice-call-reminders/01-overview-tasks-1-4.md#L1) | Added navigation/banner/separator bytes |
| ∅ before L809 | [02-tasks-5-6.md:L1–2](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-16-voice-call-reminders/02-tasks-5-6.md#L1-L2) | Added navigation/banner/separator bytes |
| ∅ before L1167 | [02-tasks-5-6.md:L361–361](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-16-voice-call-reminders/02-tasks-5-6.md#L361); [03-tasks-7-12.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-16-voice-call-reminders/03-tasks-7-12.md#L1) | Added navigation/banner/separator bytes |

#### `docs/plans/2026-03-17-bot-ux-automation.md`

| Original range | Destination range(s) | Classification |
|---|---|---|
| ∅ before L14 | [2026-03-17-bot-ux-automation.md:L14–40](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-17-bot-ux-automation.md#L14-L40); [01-tasks-1-9.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-17-bot-ux-automation/01-tasks-1-9.md#L1) | Added navigation/banner/separator bytes |
| ∅ before L905 | [02-tasks-10-20.md:L1–2](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-17-bot-ux-automation/02-tasks-10-20.md#L1-L2) | Added navigation/banner/separator bytes |

#### `docs/plans/2026-03-17-group-chat-interaction.md`

| Original range | Destination range(s) | Classification |
|---|---|---|
| ∅ before L14 | [2026-03-17-group-chat-interaction.md:L14–48](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-17-group-chat-interaction.md#L14-L48); [01-tasks-1-6.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-17-group-chat-interaction/01-tasks-1-6.md#L1) | Added navigation/banner/separator bytes |
| ∅ before L920 | `docs/plans/2026-03-17-group-chat-interaction/02-tasks-7-18.md:L1–2` (restored candidate bytes) | Added navigation/banner/separator bytes |

#### `docs/plans/2026-03-18-group-commands.md`

| Original range | Destination range(s) | Classification |
|---|---|---|
| ∅ before L12 | [2026-03-18-group-commands.md:L12–32](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-18-group-commands.md#L12-L32); [01-overview-tasks-1-5.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-18-group-commands/01-overview-tasks-1-5.md#L1) | Added navigation/banner/separator bytes |
| ∅ before L595 | [01-overview-tasks-1-5.md:L585–585](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-18-group-commands/01-overview-tasks-1-5.md#L585); [02-tasks-6-12.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-18-group-commands/02-tasks-6-12.md#L1) | Added navigation/banner/separator bytes |

#### `docs/plans/2026-03-18-invite-propose-time.md`

| Original range | Destination range(s) | Classification |
|---|---|---|
| ∅ before L16 | [2026-03-18-invite-propose-time.md:L16–39](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-18-invite-propose-time.md#L16-L39); [01-overview-tasks-1-5.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-18-invite-propose-time/01-overview-tasks-1-5.md#L1) | Added navigation/banner/separator bytes |
| ∅ before L638 | [01-overview-tasks-1-5.md:L624–624](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-18-invite-propose-time/01-overview-tasks-1-5.md#L624); [02-tasks-6-10.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-18-invite-propose-time/02-tasks-6-10.md#L1) | Added navigation/banner/separator bytes |

#### `docs/plans/2026-03-18-secretary-access.md`

| Original range | Destination range(s) | Classification |
|---|---|---|
| ∅ before L14 | [2026-03-18-secretary-access.md:L14–33](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-18-secretary-access.md#L14-L33); [01-overview-tasks-1-5.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-18-secretary-access/01-overview-tasks-1-5.md#L1) | Added navigation/banner/separator bytes |
| ∅ before L712 | [01-overview-tasks-1-5.md:L700–700](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-18-secretary-access/01-overview-tasks-1-5.md#L700); [02-tasks-6-11.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-18-secretary-access/02-tasks-6-11.md#L1) | Added navigation/banner/separator bytes |

#### `docs/plans/2026-03-19-bidirectional-voice.md`

| Original range | Destination range(s) | Classification |
|---|---|---|
| ∅ before L12 | [2026-03-19-bidirectional-voice.md:L12–41](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-19-bidirectional-voice.md#L12-L41); [01-overview-tasks-1-5.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-19-bidirectional-voice/01-overview-tasks-1-5.md#L1) | Added navigation/banner/separator bytes |
| ∅ before L770 | [02-tasks-6-8.md:L1–2](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-19-bidirectional-voice/02-tasks-6-8.md#L1-L2) | Added navigation/banner/separator bytes |
| ∅ before L1515 | `docs/plans/2026-03-19-bidirectional-voice/03-tasks-9-12.md:L1–2` (restored candidate bytes) | Added navigation/banner/separator bytes |

#### `docs/plans/2026-03-19-scheduled-ai-calls.md`

| Original range | Destination range(s) | Classification |
|---|---|---|
| ∅ before L14 | [2026-03-19-scheduled-ai-calls.md:L14–37](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-19-scheduled-ai-calls.md#L14-L37); [01-overview-tasks-1-4.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-19-scheduled-ai-calls/01-overview-tasks-1-4.md#L1) | Added navigation/banner/separator bytes |
| ∅ before L688 | [01-overview-tasks-1-4.md:L676–676](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-19-scheduled-ai-calls/01-overview-tasks-1-4.md#L676); [02-tasks-5-10.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-19-scheduled-ai-calls/02-tasks-5-10.md#L1) | Added navigation/banner/separator bytes |
| ∅ before L1417 | [03-tasks-11-15.md:L1–2](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-19-scheduled-ai-calls/03-tasks-11-15.md#L1-L2) | Added navigation/banner/separator bytes |

#### `docs/plans/2026-03-20-ai-assistant-bot-server.md`

| Original range | Destination range(s) | Classification |
|---|---|---|
| ∅ before L14 | [2026-03-20-ai-assistant-bot-server.md:L14–50](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-20-ai-assistant-bot-server.md#L14-L50); [01-overview-tasks-1-6.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-20-ai-assistant-bot-server/01-overview-tasks-1-6.md#L1) | Added navigation/banner/separator bytes |
| ∅ before L810 | [01-overview-tasks-1-6.md:L798–798](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-20-ai-assistant-bot-server/01-overview-tasks-1-6.md#L798); [02-tasks-7-a3.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-20-ai-assistant-bot-server/02-tasks-7-a3.md#L1) | Added navigation/banner/separator bytes |
| ∅ before L1626 | [02-tasks-7-a3.md:L818–818](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-20-ai-assistant-bot-server/02-tasks-7-a3.md#L818); [03-tasks-a4-a10.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-20-ai-assistant-bot-server/03-tasks-a4-a10.md#L1) | Added navigation/banner/separator bytes |

#### `docs/plans/2026-03-20-birthdays.md`

| Original range | Destination range(s) | Classification |
|---|---|---|
| ∅ before L14 | `docs/plans/2026-03-20-birthdays.md:L14–31` (restored candidate bytes); `docs/plans/2026-03-20-birthdays/01-overview-tasks-1-4.md:L1–1` (restored candidate bytes) | Added navigation/banner/separator bytes |
| ∅ before L628 | [02-tasks-5-6.md:L1–2](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-20-birthdays/02-tasks-5-6.md#L1-L2) | Added navigation/banner/separator bytes |
| ∅ before L1187 | [03-tasks-7-9.md:L1–2](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-20-birthdays/03-tasks-7-9.md#L1-L2) | Added navigation/banner/separator bytes |

#### `docs/plans/2026-03-21-stt-corrections.md`

| Original range | Destination range(s) | Classification |
|---|---|---|
| ∅ before L12 | [2026-03-21-stt-corrections.md:L12–29](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-21-stt-corrections.md#L12-L29); [01-overview-tasks-1-3.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-21-stt-corrections/01-overview-tasks-1-3.md#L1) | Added navigation/banner/separator bytes |
| ∅ before L727 | [02-tasks-4-7.md:L1–2](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-21-stt-corrections/02-tasks-4-7.md#L1-L2) | Added navigation/banner/separator bytes |
| ∅ before L1329 | [02-tasks-4-7.md:L605–605](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-21-stt-corrections/02-tasks-4-7.md#L605); [03-task-8.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-21-stt-corrections/03-task-8.md#L1) | Added navigation/banner/separator bytes |

#### `docs/plans/2026-03-25-connect-telegram.md`

| Original range | Destination range(s) | Classification |
|---|---|---|
| ∅ before L16 | [2026-03-25-connect-telegram.md:L16–43](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-25-connect-telegram.md#L16-L43); [01-overview-tasks-1-3.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-25-connect-telegram/01-overview-tasks-1-3.md#L1) | Added navigation/banner/separator bytes |
| ∅ before L629 | [01-overview-tasks-1-3.md:L615–615](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-25-connect-telegram/01-overview-tasks-1-3.md#L615); [02-tasks-4-6.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-25-connect-telegram/02-tasks-4-6.md#L1) | Added navigation/banner/separator bytes |
| ∅ before L1404 | [03-tasks-7-8.md:L1–2](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-25-connect-telegram/03-tasks-7-8.md#L1-L2) | Added navigation/banner/separator bytes |
| ∅ before L1931 | [03-tasks-7-8.md:L530–530](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-25-connect-telegram/03-tasks-7-8.md#L530); [04-tasks-9-11.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-03-25-connect-telegram/04-tasks-9-11.md#L1) | Added navigation/banner/separator bytes |
| ∅ before L2683 | `docs/plans/2026-03-25-connect-telegram/05-tasks-12-14.md:L1–2` (restored candidate bytes) | Added navigation/banner/separator bytes |

#### `docs/plans/2026-04-10-openai-sdk-migration.md`

| Original range | Destination range(s) | Classification |
|---|---|---|
| ∅ before L23 | [2026-04-10-openai-sdk-migration.md:L23–43](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-04-10-openai-sdk-migration.md#L23-L43); [01-overview-tasks-1-4.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-04-10-openai-sdk-migration/01-overview-tasks-1-4.md#L1) | Added navigation/banner/separator bytes |
| ∅ before L699 | [01-overview-tasks-1-4.md:L678–678](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-04-10-openai-sdk-migration/01-overview-tasks-1-4.md#L678); [02-tasks-5-13.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/plans/2026-04-10-openai-sdk-migration/02-tasks-5-13.md#L1) | Added navigation/banner/separator bytes |

#### `docs/specs/03-google-calendar-sync.md`

| Original range | Destination range(s) | Classification |
|---|---|---|
| ∅ before L2 | [03-google-calendar-sync.md:L2–75](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/specs/03-google-calendar-sync.md#L2-L75); [01-overview-sections-1-4.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/specs/03-google-calendar-sync/01-overview-sections-1-4.md#L1) | Added navigation/banner/separator bytes |
| ∅ before L682 | [02-sections-5-14.md:L1–2](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/specs/03-google-calendar-sync/02-sections-5-14.md#L1-L2) | Added navigation/banner/separator bytes |

#### `docs/specs/05-image-generation.md`

| Original range | Destination range(s) | Classification |
|---|---|---|
| ∅ before L4 | [05-image-generation.md:L4–53](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/specs/05-image-generation.md#L4-L53); [01-overview-sections-1-6.md:L1–1](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/specs/05-image-generation/01-overview-sections-1-6.md#L1) | Added navigation/banner/separator bytes |
| [L13–18](https://github.com/alex-mextner/HyperCalendarBot/blob/2327f650f56b09fbb1362891349411af59d1562d/docs/specs/05-image-generation.md#L13-L18) | [01-overview-sections-1-6.md:L11–16](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/specs/05-image-generation/01-overview-sections-1-6.md#L11-L16) | Six internal links retargeted to the second part; labels and anchors retained |

```diff
-7. [Caching Strategy](#7-caching-strategy)
-8. [Performance Considerations](#8-performance-considerations)
-9. [Example Template: Daily Agenda](#9-example-template-daily-agenda)
-10. [File Structure](#10-file-structure)
-11. [API Surface](#11-api-surface)
-12. [Mini App Auto-Timezone Detection](#12-mini-app-auto-timezone-detection)
+7. [Caching Strategy](02-sections-7-12.md#7-caching-strategy)
+8. [Performance Considerations](02-sections-7-12.md#8-performance-considerations)
+9. [Example Template: Daily Agenda](02-sections-7-12.md#9-example-template-daily-agenda)
+10. [File Structure](02-sections-7-12.md#10-file-structure)
+11. [API Surface](02-sections-7-12.md#11-api-surface)
+12. [Mini App Auto-Timezone Detection](02-sections-7-12.md#12-mini-app-auto-timezone-detection)
```

| Original range | Destination range(s) | Classification |
|---|---|---|
| ∅ before L696 | [02-sections-7-12.md:L1–2](https://github.com/alex-mextner/HyperCalendarBot/blob/0bdc82291b2241b07279814be389b537c1618887/docs/specs/05-image-generation/02-sections-7-12.md#L1-L2) | Added navigation/banner/separator bytes |

### Exact fence restorations

| Part | Before/after physical lines | After file SHA-256 |
|---|---|---|
| `docs/plans/2026-03-17-group-chat-interaction/02-tasks-7-18.md` | 867 → 862 | `4c0e1d5c254741baef3e61e9a02d793d077ec0f0362232301446fb26c86cc184` |
| `docs/plans/2026-03-19-bidirectional-voice/03-tasks-9-12.md` | 656 → 642 | `8ef6a01e2e6d7781742b69d06c54eb1904102543962eb4ac2872ac5dd783a5d8` |
| `docs/plans/2026-03-20-birthdays/01-overview-tasks-1-4.md` | 616 → 615 | `1be5f1480c5e9941b3277e277b3b78c076ddcbce1b4ac054aff9a2b89f11443e` |
| `docs/plans/2026-03-25-connect-telegram/05-tasks-12-14.md` | 710 → 708 | `f73f2563c58ce60b94e9ca2c39a95338447e47c90cda89fbf31804c1f8545f54` |

Each complete Python fence, including quotes, wrapping and blank lines, is restored from its original file. Python ASTs before/after are equal; original bytes after restoration are equal. These are two separate checks.

### Later plan/spec content retained

Only `docs/specs/03-google-calendar-sync/01-overview-sections-1-4.md` changed independently after the split, in `3c51bcaded9355f84631394da2236a1a5ec2ad63` (#879). Its Google event-id receipt and recovery changes remain intact. Every later raw hunk is in the companion map and the linked commit; none is treated as accidental split loss.


## Generated documents: exact restoration proof

The actual native run used the original catalogue model and engine from `2327f650f56b09fbb1362891349411af59d1562d` with the new renderer sources. It rendered the complete public Markdown and self-contained HTML without removing or normalizing any bytes.

| Original document | Original and regenerated complete SHA-256 |
|---|---|
| `docs/intents/README.md` | `be93115ada88533fb43a61c9a25f35fa778dc062bc151ecda8650621c1196aea` |
| `docs/intents/index.html` | `3a0421486e1a97d85bbd26096be215784d63a08b914f54525ce6ace59f6cce51` |

Both complete outputs are byte-identical to the original committed documents. Their real physical split pages were generated in the same run and independently stayed at or below 1200 physical lines. These same-input artifacts are evidence about the split; current committed pages retain the later seed changes separately.

The [machine-readable byte and line metadata](complexity-size-preservation.json) records the source and destination hashes and ranges. The raw README comparison keeps every banner, heading, blank and footer. All original lines have an ordered byte-equal destination after applying only the explicitly listed link retargets. Each of the 52 complete original rule cards is additionally compared as one raw block, including entity spelling, fenced JSON and whitespace. The 13 category gaps and the between-part divider are checked in their original card-end context, before the added visible footer link.

| Rule | Original README lines | Markdown destination lines | Original HTML workflow lines | Readable HTML destination lines | Retarget occurrences |
|---|---|---|---|---|---:|
| `basis.calendar.day` | 111–195 | `rules/calendar.md`:9–93 | 138–171 | `workflows/calendar.html`:6–39 | 5 |
| `basis.calendar.period` | 199–293 | `rules/calendar.md`:97–191 | 172–220 | `workflows/calendar.html`:42–90 | 5 |
| `basis.calendar.upcoming` | 297–369 | `rules/calendar.md`:195–267 | 221–246 | `workflows/calendar.html`:93–118 | 2 |
| `basis.calendar.search` | 373–437 | `rules/calendar.md`:271–335 | 247–269 | `workflows/calendar.html`:121–143 | 2 |
| `basis.calendar.count` | 441–542 | `rules/calendar.md`:339–440 | 270–329 | `workflows/calendar.html`:146–205 | 4 |
| `basis.calendar.image` | 546–657 | `rules/calendar.md`:444–555 | 330–397 | `workflows/calendar.html`:208–275 | 1 |
| `basis.holidays.upcoming` | 661–730 | `rules/calendar.md`:559–628 | 398–426 | `workflows/calendar.html`:278–306 | 3 |
| `basis.slots.day` | 734–810 | `rules/slots.md`:9–85 | 427–460 | `workflows/slots.html`:6–39 | 4 |
| `basis.slots.week` | 814–952 | `rules/slots.md`:89–227 | 480–569 | `workflows/slots.html`:42–131 | 3 |
| `basis.slots.check_time` | 956–1067 | `rules/slots.md`:231–342 | 571–631 | `workflows/slots.html`:134–194 | 3 |
| `basis.event.create` | 1071–1233 | `rules/events-1.md`:9–171 | 633–735 | `workflows/events-1.html`:6–108 | 2 |
| `basis.event.show` | 1237–1346 | `rules/events-1.md`:175–284 | 737–803 | `workflows/events-1.html`:111–177 | 1 |
| `basis.event.reschedule` | 1350–1539 | `rules/events-1.md`:288–477 | 805–935 | `workflows/events-1.html`:180–310 | 2 |
| `basis.event.rename` | 1543–1695 | `rules/events-1.md`:481–633 | 937–1041 | `workflows/events-1.html`:313–417 | 2 |
| `basis.event.set_detail` | 1699–1874 | `rules/events-1.md`:637–812 | 1043–1168 | `workflows/events-1.html`:420–545 | 3 |
| `basis.event.delete` | 1878–2033 | `rules/events-1.md`:816–971 | 1170–1268 | `workflows/events-1.html`:548–646 | 2 |
| `basis.event.snooze` | 2037–2217 | `rules/events-2.md`:9–189 | 1270–1395 | `workflows/events-2.html`:6–131 | 3 |
| `basis.event.hide` | 2221–2380 | `rules/events-2.md`:193–352 | 1397–1501 | `workflows/events-2.html`:134–238 | 2 |
| `basis.event.create_range` | 2384–2524 | `rules/events-2.md`:356–496 | 1502–1590 | `workflows/events-2.html`:241–329 | 1 |
| `basis.reminder.set` | 2528–2712 | `rules/reminders.md`:9–193 | 1592–1719 | `workflows/reminders.html`:6–133 | 3 |
| `basis.reminder.list` | 2716–2834 | `rules/reminders.md`:197–315 | 1721–1794 | `workflows/reminders.html`:136–209 | 2 |
| `basis.reminder.clear` | 2838–2987 | `rules/reminders.md`:319–468 | 1796–1895 | `workflows/reminders.html`:212–311 | 2 |
| `basis.reminder.after` | 2991–3123 | `rules/reminders.md`:472–604 | 1896–1978 | `workflows/reminders.html`:314–396 | 3 |
| `basis.invite.send` | 3127–3301 | `rules/invitations.md`:9–183 | 1980–2097 | `workflows/invitations.html`:6–123 | 2 |
| `basis.invite.status` | 3305–3426 | `rules/invitations.md`:187–308 | 2099–2176 | `workflows/invitations.html`:126–203 | 1 |
| `basis.contacts.list` | 3430–3491 | `rules/contacts.md`:9–70 | 2177–2197 | `workflows/contacts.html`:6–26 | 2 |
| `basis.contacts.find` | 3495–3565 | `rules/contacts.md`:74–144 | 2198–2227 | `workflows/contacts.html`:29–58 | 2 |
| `basis.contacts.add` | 3569–3659 | `rules/contacts.md`:148–238 | 2228–2273 | `workflows/contacts.html`:61–106 | 2 |
| `basis.contacts.rename` | 3663–3779 | `rules/contacts.md`:242–358 | 2275–2346 | `workflows/contacts.html`:109–180 | 2 |
| `basis.contacts.set_username` | 3783–3897 | `rules/contacts.md`:362–476 | 2348–2419 | `workflows/contacts.html`:183–254 | 1 |
| `basis.contacts.delete` | 3901–4011 | `rules/contacts.md`:480–590 | 2421–2486 | `workflows/contacts.html`:257–322 | 1 |
| `basis.call.start` | 4015–4100 | `rules/contacts.md`:594–679 | 2487–2534 | `workflows/contacts.html`:325–372 | 1 |
| `basis.settings.view` | 4104–4196 | `rules/settings.md`:9–101 | 2535–2584 | `workflows/settings.html`:6–55 | 2 |
| `basis.settings.toggle` | 4200–4345 | `rules/settings.md`:105–250 | 2585–2681 | `workflows/settings.html`:58–154 | 9 |
| `basis.settings.agenda_time` | 4349–4451 | `rules/settings.md`:254–356 | 2682–2739 | `workflows/settings.html`:157–214 | 1 |
| `basis.settings.duration` | 4455–4555 | `rules/settings.md`:360–460 | 2740–2794 | `workflows/settings.html`:217–271 | 3 |
| `basis.settings.language` | 4559–4656 | `rules/settings.md`:464–561 | 2795–2850 | `workflows/settings.html`:274–329 | 1 |
| `basis.settings.timezone` | 4660–4762 | `rules/settings.md`:565–667 | 2851–2906 | `workflows/settings.html`:332–387 | 1 |
| `basis.history.search` | 4766–4847 | `rules/history.md`:9–90 | 2907–2947 | `workflows/history.html`:6–46 | 1 |
| `basis.actionlog.recent` | 4851–4927 | `rules/history.md`:94–170 | 2948–2980 | `workflows/history.html`:49–81 | 1 |
| `basis.memory.remember` | 4931–5003 | `rules/memory.md`:9–81 | 2981–3011 | `workflows/memory.html`:6–36 | 1 |
| `basis.time.now` | 5007–5080 | `rules/utility.md`:9–82 | 3012–3043 | `workflows/utility.html`:6–37 | 3 |
| `basis.time.convert` | 5084–5179 | `rules/utility.md`:86–181 | 3044–3089 | `workflows/utility.html`:40–85 | 2 |
| `basis.calc.evaluate` | 5183–5244 | `rules/utility.md`:185–246 | 3090–3111 | `workflows/utility.html`:88–109 | 1 |
| `basis.google.status` | 5248–5306 | `rules/google.md`:9–67 | 3112–3132 | `workflows/google.html`:6–26 | 3 |
| `basis.google.calendars` | 5310–5367 | `rules/google.md`:71–128 | 3133–3153 | `workflows/google.html`:29–49 | 2 |
| `basis.google.connect_help` | 5371–5426 | `rules/google.md`:132–187 | 3154–3169 | `workflows/google.html`:52–67 | 4 |
| `basis.telegram.status` | 5430–5495 | `rules/google.md`:191–256 | 3172–3198 | `workflows/google.html`:70–96 | 1 |
| `basis.secretary.list` | 5499–5555 | `rules/secretary.md`:9–65 | 3199–3219 | `workflows/secretary.html`:6–26 | 1 |
| `basis.secretary.invite` | 5559–5668 | `rules/secretary.md`:69–178 | 3220–3283 | `workflows/secretary.html`:29–92 | 3 |
| `basis.secretary.clarify` | 5672–5724 | `rules/secretary.md`:182–234 | 3284–3299 | `workflows/secretary.html`:95–110 | 1 |
| `basis.bot.info` | 5728–5778 | `rules/bot.md`:9–59 | 3300–3312 | `workflows/bot.html`:6–18 | 4 |

Every Markdown target in that table identifies the explicit change `(#rule-name)` → `(rules/page.md#rule-name)`; the final column preserves each original occurrence count. There are 119 total retargets. The source and destination ranges refer to the original source and the actual reproducible baseline-model split output, with full raw hashes and UTF-8 byte offsets in the companion map.

All 52 original HTML `<pre>` blocks are now byte-identical on real visible workflow pages. The entire index is reconstructed from the original HTML through exactly 54 explicit retargets: its style body moves to index.css, its filter body moves to index.js, and 52 inline workflow blocks move to the linked HTML pages. No further HTML difference remains. The CSS and script bodies are themselves raw-equal; their added generated-file banners and external wrapper links are identified separately. The browser proof follows the visible links with JavaScript disabled and checks every workflow text.

The generated-file headers, previous/next navigation, catalogue footers, workflow-page wrappers and split-output guidance are additions. No original non-link content is removed. Bare concatenation still includes that added scaffolding and is not falsely labelled identical. The complete original public renderings are byte-identical, as shown above.

The later seed revision (#859) and calendar seed split (#904) remain intact in current generated pages. Their current file hashes and measured line counts are recorded independently from the same-input baseline reconstruction; old content was not copied over current product data.

## Native verification on 2026-10-31

The source-bound Home run used Bun 1.4.2. Frozen installation, formatting, generation, exact original-model rendering, freshness, Chromium runtime, all 26 SSG tests (1,782 assertions), whole-repository lint and typecheck passed. The browser check followed the visible workflow links with JavaScript disabled and checked every full workflow. All current physical generated pages are at most 961 lines. Original SSG titles, assertion strings, public-renderer test bodies and original browser check functions passed a second audit after formatting.

The native input manifest is `143309f13514455320cf65538d12b46929233183905dd4201e9d55d253b884bd`. The complete native artifact SHA-256 is `f8262e0e9b56d385d43e34028de72ca3e15dd2220f942daefab2716de6dada56`. This is focused document verification; the final exact-tree full Bun suite on 65.21.40.51 remains a separate acceptance gate.


## Historical renderer behavior and metadata representation

The public `renderMarkdown` and `renderHtml` functions retain the original full
output, including the original apostrophe entity spelling, category heading levels
and three-file generator description. The committed pages relocate those original
bytes and add the explicitly mapped navigation. This requirement does not claim
that the historical Markdown display behavior is correct: apostrophes can appear as
literal entity text, and that existing defect is tracked in
[#861](https://github.com/alex-mextner/HyperCalendarBot/issues/861).
Current build and offline-bundle instructions are maintained separately in
[the intent catalogue guide](../intent-catalogue.md).

The v2 public metadata represents each current-file checksum as an explicit
`path`/`sha256` record. The 79 plan/specification records and 35 generated-output
records round-trip to the exact v1 mappings. No document content, checksum, source
range, link replacement or raw archive payload changes with this representation.
The change avoids interpreting a documentation path containing `secretary` as a
secret variable name followed by a digest. Secret-scan rules and allowlists remain
unchanged. Four repeated table headers make rows after fenced diffs render as
tables; all original rows and diff bytes remain present.
