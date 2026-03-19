# Timezone City Text Input

**Date:** 2026-03-19
**Status:** Approved

## Problem

Timezone selection in onboarding and `/settings` uses a two-level button menu (region → city) with a hardcoded list of ~12 cities per region. Most cities are missing. Users from Serbia, Bulgaria, Kazakhstan etc. have no direct match.

## Solution

Replace button menus with free-text city input. `city-timezones` library + AI (Haiku) resolve the input to an IANA timezone key. Location sharing remains as an alternative.

## Scope

All timezone selection flows use the same new approach:
- `src/bot/scenes/onboarding.scene.ts` — Step 1 (timezone)
- `src/bot/scenes/timezone.scene.ts` — timezone change via `/settings`
- `src/bot/handlers/callback.handler.ts` — group chat timezone picker (`CB.GROUP_SETTINGS_TZ`)

## New Module: `src/services/timezone/city-resolver.ts`

```
resolveCity(input: string, anthropicApiKey: string): Promise<string | null>
```

**Resolution chain:**

1. If input contains `/` and passes `validateTimezone(input)` → return immediately (user typed IANA key directly, e.g. `Europe/Belgrade`, `Asia/Tokyo`)
2. `city-timezones.lookupViaCity(input)` — direct match
3. `city-timezones.findFromCityStateProvince(input)` — fuzzy partial match
4. If steps 2-3 return results → pick the one with the highest `pop` field → extract its `timezone` → return
5. If no library result → AI call (Haiku): given city name in any language, return the IANA timezone key. Validate with `validateTimezone()`. If valid → return.
6. If AI returns invalid key → extract `Region/` prefix → collect candidates via `Intl.supportedValuesOf('timeZone').filter(z => z.startsWith(prefix))` → AI retry with candidates as context
7. Repeat up to **3 AI calls** total. Return `null` if all exhausted.

**Validation:**
```ts
function validateTimezone(tz: string): boolean {
  try { Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; }
  catch { return false; }
}
```

**Haiku system prompt:**
> You are a timezone resolver. Given a city name in any language or format, return the IANA timezone key (e.g. Europe/Belgrade, America/New_York, Asia/Tokyo). Return only the key, nothing else. If you cannot determine it, return UNKNOWN.

**On retry** (step 6), append to context:
> `{prev_key}` is not a valid IANA timezone. Valid zones in that region: `{candidates}`. Try again.

## UX Flow

### Prompt message (replaces current two-message region+location UI):
```
🌍 В каком городе вы находитесь?

Примеры: Белград, Belgrade, Нью-Йорк, бангкок, Алматы, київ

[📍 Отправить геолокацию]
```
Single message, one location button.

### On user text input → resolver succeeds:
```
✅ Europe/Belgrade (UTC+1) — верно?
[Да ✓]  [Нет, другой город]
```
"Нет, другой город" re-sends the prompt. No limit on user attempts.

### On user text input → resolver returns null:
```
Не удалось определить таймзону. Попробуйте ещё раз или:
• Отправьте 📍 геолокацию
• Введите код геолокации напрямую, например: Europe/Belgrade
  Список кодов: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones
```

### On location share: existing `geo-tz` logic unchanged.

## Scene Changes

**Both scenes:**
- Step type changes from `['callback_query', 'location']` to `['message', 'location', 'callback_query']`
- `resolveCity()` is called from both scenes — no logic duplication, resolution lives entirely in `city-resolver.ts`

**Remove from step `firstTime`:**
- `timezoneManualKeyboard()` call
- second `context.send()` with `timezoneMethodKeyboard()` (was a separate message)

**Add to step `firstTime`:**
- Single `context.send()` with city prompt text + `timezoneMethodKeyboard()` (location button)

**Add message handler** (`context.is('message')`):
- Extract text → call `resolveCity()`
- Success → send confirmation inline keyboard
- Failure → send fallback message with geo button + link

**Update `timezoneConfirmKeyboard()`** in `src/bot/keyboards.ts`:
- Change "Нет, вручную" / "No, choose manually" → "Нет, другой город" / "No, different city"
- Change payload from `CB.ONBOARD_TZ:manual` → `CB.ONBOARD_TZ:retry`

**Add callback handler for `CB.ONBOARD_TZ:retry`:**
- Re-send city prompt message

**Remove** the existing `else`-arm in the `CB.ONBOARD_TZ` handler that handled `payload === 'manual'` (showed `timezoneManualKeyboard()`). After the rename it is dead code.

**Remove callback handler for `CB.ONBOARD_TZ_REGION`** from both scenes.

## Cleanup (after both scenes updated)

| Item | Location | Action |
|------|----------|--------|
| `timezoneManualKeyboard()` | `src/bot/keyboards.ts` | Delete |
| `timezoneCitiesKeyboard()` | `src/bot/keyboards.ts` | Delete |
| `CB.ONBOARD_TZ_REGION` | `src/config/constants.ts` | Delete |
| `groupTimezoneRegionKeyboard()` | `src/bot/keyboards.ts` | Delete |
| `groupTimezoneCitiesKeyboard()` | `src/bot/keyboards.ts` | Delete |
| `TZ_REGIONS` | `src/config/constants.ts` | Delete |

## Dependencies

- `city-timezones` — `bun add city-timezones` (v1.3.3, zero deps, 59k dl/week, Dec 2025)
- `@anthropic-ai/sdk` — already in project
- `Intl.supportedValuesOf` + `Intl.DateTimeFormat` — built-in Bun

## Testing

- `city-resolver.ts` unit tests:
  - Latin city name → library match
  - Cyrillic input ("Белград") → AI normalizes → valid result
  - Fuzzy partial match ("New Yor") → highest pop result
  - Direct IANA input ("Europe/Belgrade") → skip AI, return immediately
  - AI returns invalid key → retry with suggestions → success
  - All 3 AI calls exhausted → return null
- Onboarding scene: message input → confirmation → save tz
- Timezone scene: same flow
- Fallback message shown when resolver returns null
