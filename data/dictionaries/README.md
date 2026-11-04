# Stress Dictionary

Russian word stress dictionary for Silero TTS. Maps bare words to stressed forms
with `+` before the stressed vowel (e.g. `молоко → молок+о`).

## Source

**OpenRussian** — [github.com/Badestrand/russian-dictionary](https://github.com/Badestrand/russian-dictionary)
License: CC-BY-SA. ~555K word forms extracted from nouns, verbs, adjectives, and others TSV files.

## How to regenerate

```bash
# 1. Clone the dictionary repo
git clone https://github.com/Badestrand/russian-dictionary /tmp/russian-dictionary

# 2. Generate stress-dict.json
bun scripts/generate-stress-dict.ts
```

## Format

```json
{
  "молоко": "молок+о",
  "привет": "прив+ет",
  "календарь": "календ+арь"
}
```

- Key: bare lowercase word (no stress marks)
- Value: same word with `+` inserted before the stressed vowel
- File size: ~26 MB, ~555K entries

## Usage

Registered at bot startup by `loadStressDictionary()` in `src/bootstrap/speech.ts` and read through
`StressDictionary.lazyFromFile()` in `src/services/voice/stress-dictionary.ts`: at startup when
`SILERO_PYTHON_PATH` is set, otherwise on first use (the `lookup_stress` tool), because parsing it costs about
80 MB retained and over 300 MB at the peak. Used by `markStress()` in `src/services/voice/stress-marker.ts` to
add stress marks to Russian text before feeding it to Silero TTS. The scripts under `scripts/` read it
directly with `StressDictionary.loadFromFile()`.
