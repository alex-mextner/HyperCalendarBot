"""Output gates of the corpus build: the sensitive-value and format checks, the whole-corpus verification and the
leak debug helpers."""

from __future__ import annotations

import collections
import json
import os
import re
import sys
from dataclasses import dataclass, field

import scrub as scrub_module
from corpus_sources import EMAIL, HANDLE, LONG_DIGITS, PHONEISH, URL
from corpus_turns import PHRASES
from scrub import Scrubber, norm

# ─── gates ──────────────────────────────────────────────────────────────────────────────────────────────────────────


def walk(value, path: str = ""):
    if isinstance(value, str):
        yield path, value
    elif isinstance(value, list):
        for item in value:
            yield from walk(item, path)
    elif isinstance(value, dict):
        for key, item in value.items():
            yield from walk(item, f"{path}.{key}" if path else key)


def sensitive_values(text: str) -> set[str]:
    """Every e-mail, URL, handle, phone and long digit run of a RAW string; none may survive into the output."""
    found: set[str] = set()
    for pattern in (EMAIL, URL, HANDLE, LONG_DIGITS, PHONEISH):
        for match in pattern.finditer(text):
            value = match.group(0)
            if pattern is PHONEISH and re.search(r"\d{4}-\d{2}-\d{2}|:", value):
                continue
            found.add(value.lower())
    return found


def format_hits(text: str) -> dict[str, int]:
    """Output-format gate: only the scrubber's own placeholders may look like contact data."""
    hits: dict[str, int] = {}
    for label, pattern in (("email", EMAIL), ("url", URL), ("handle", HANDLE)):
        for match in pattern.finditer(text):
            value = match.group(0)
            if (
                value.endswith("@example.org")
                or "example.org/" in value
                or value.startswith("@px_")
            ):
                continue
            hits[label] = hits.get(label, 0) + 1
    return hits


def add_counts(total: dict[str, int], hits: dict[str, int]) -> None:
    for label, count in hits.items():
        total[label] = total.get(label, 0) + count


def _without_tools(history: list[dict]) -> list[dict]:
    return [{key: value for key, value in item.items() if key != "tools"} for item in history]


def _is_real_token(scrubber: Scrubber, token: str) -> bool:
    real = token in scrubber.real_norms or any(hit[0].real for hit in scrubber.forms.get(token, ()))
    return real and token not in scrub_module.pools.NEVER_ENTITY


def _whole_entity_phrases(scrubber: Scrubber, blob: str) -> list[list[str]]:
    """Registered multi-word private strings that survive verbatim in `blob`, as token lists."""
    survivors: list[list[str]] = []
    for phrase in PHRASES:
        tokens = phrase.split()
        if any(_is_real_token(scrubber, token) for token in tokens) and phrase in blob:
            survivors.append(tokens)
    return survivors


def _verify_fields(record: dict) -> dict:
    free = {key: record[key] for key in ("say", "replies", "executed")}
    free["history"] = _without_tools(record["history"])
    free["previousBot"] = record["context"]["previousBot"]
    return free


def verify_corpus(path: str, scrubber: Scrubber, fingerprint: str) -> int:
    """Run the output gates again on a written corpus against the live entity registry (odroid only)."""
    entity_leaks = 0
    regex_total: dict[str, int] = {}
    records = 0
    texts: list[str] = []
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            record = json.loads(line)
            records += 1
            for _, text in walk(_verify_fields(record)):
                texts.append(text)
                entity_leaks += len(scrubber.leaks(text))
                add_counts(regex_total, format_hits(text))
    blob = " ".join(scrub_module.WORD_RE.findall(norm("\n".join(texts))))
    whole = len(_whole_entity_phrases(scrubber, blob))
    print(
        json.dumps(
            {
                "records": records,
                "entityForms": entity_leaks,
                "wholeEntityStrings": whole,
                "regex": regex_total,
                "entityListSha256": fingerprint,
            }
        )
    )
    return 0 if entity_leaks == 0 and whole == 0 and not regex_total else 3


def raw_sensitive_of(turn: dict) -> set[str]:
    """Every contact-like value of the RAW strings of a turn."""
    found = sensitive_values(turn["text"]) | sensitive_values(turn["previousBot"] or "")
    for reply in turn["replies"]:
        found |= sensitive_values(reply)
    for item in turn["history"]:
        found |= sensitive_values(item.get("text") or "")
    for call in turn["calls"]:
        for _, raw_text in walk(call["args"]):
            found |= sensitive_values(raw_text)
        found |= sensitive_values(call.get("result") or "")
    return found


@dataclass
class GateTally:
    """What the output gates collect over all records."""

    leaks: list[tuple[str, str, str]] = field(default_factory=list)
    leak_fields: collections.Counter = field(default_factory=collections.Counter)
    regex: dict[str, int] = field(default_factory=dict)
    raw_sensitive: set[str] = field(default_factory=set)


def _mask_alnum(chars: str) -> list[str]:
    return [("a" if ch.isalnum() else ch) for ch in chars]


def _stem_matches(scrubber: Scrubber, token: str) -> list[tuple[str, scrub_module.Entry]]:
    return [
        (st, e)
        for st, e in scrubber.stem_entries.items()
        if token.startswith(st) and len(token) - len(st) <= 3
    ]


def _debug_context(token: str, text: str) -> list:
    folded = norm(text)
    at = folded.find(token)
    return [
        "ctx",
        _mask_alnum(folded[max(0, at - 2) : at]),
        _mask_alnum(folded[at + len(token) : at + len(token) + 2]),
        "len",
        len(text),
    ]


def _debug_raw_context(token: str, turn: dict) -> list[str] | None:
    raw = norm(
        json.dumps(
            [turn["text"], turn["previousBot"], turn["replies"], turn["history"]],
            ensure_ascii=False,
        )
    )
    if token not in raw:
        return None
    at = raw.find(token)
    return [
        ("A" if ch.isupper() else "l" if ch.isalpha() else ch)
        for ch in raw[max(0, at - 4) : at + len(token) + 4]
    ]


def _debug_probes(scrubber: Scrubber, token: str, turn: dict) -> list:
    return [
        "rescrubSame",
        scrubber.scrub(token) == token,
        "rawCtx",
        _debug_raw_context(token, turn),
        "tokenSame",
        scrubber._token(token, "", False, token) == token,
        "wordPassSame",
        scrubber._word_pass(token) == token,
        "safe",
        token in scrub_module.pools.SAFE_PROPER,
        "hasSpace",
        token != token.strip(),
        "lenLow",
        len(norm(token)),
    ]


def _debug_stems(scrubber: Scrubber, token: str) -> list:
    manual = []
    for stem, entry in _stem_matches(scrubber, token):
        word = scrubber._render(scrub_module.Hit(entry, "x", token[len(stem) :]), token)
        manual.append(
            (word == token, len(word), scrubber._is_real_form(word), token[: len(stem)] == stem)
        )
    first_stem = [(len(stem), stem == token) for stem, _ in _stem_matches(scrubber, token)]
    mapped = [
        scrubber.mapping.get(norm(entry.lemma)) for _, entry in _stem_matches(scrubber, token)
    ]
    explain = [
        (
            entry.kind,
            entry.cls,
            entry.gender,
            entry.real,
            len(stem),
            len(token) - len(stem),
            scrubber._pseudonym(entry).cls,
            len(scrubber._pseudonym(entry).lemma),
        )
        for stem, entry in _stem_matches(scrubber, token)
    ]
    return ["manual", manual, "firstStem", first_stem, "mapped", mapped, "explain", explain]


def _debug_vocabulary(
    scrubber: Scrubber, vocab: set[str], token: str, text: str, turn: dict
) -> list:
    raw_blob = norm(
        json.dumps(
            [
                turn["text"],
                turn["previousBot"],
                turn["replies"],
                turn["history"],
                [c["args"] for c in turn["calls"]],
            ],
            ensure_ascii=False,
        )
    )
    return [
        "capital",
        any(w[:1].isupper() for w in scrub_module.WORD_RE.findall(text) if norm(w) == token),
        "common",
        token in vocab,
        "inForms",
        token in scrubber.forms,
        "stemEntry",
        len(_stem_matches(scrubber, token)),
        "inRaw",
        token in raw_blob,
        "isPseudonym",
        token in {norm(v) for v in scrubber.mapping.values()},
        "inMapKeys",
        token in scrubber.mapping,
    ]


def _debug_leak(
    scrubber: Scrubber, vocab: set[str], turn: dict, path: str, token: str, text: str
) -> None:
    """DEBUG_LEAKS diagnostics of one leaked token, to stderr."""
    print(
        "DEBUG",
        path.split(".")[0],
        len(token),
        "ascii",
        token.isascii(),
        *_debug_context(token, text),
        *_debug_probes(scrubber, token, turn),
        *_debug_stems(scrubber, token),
        *_debug_vocabulary(scrubber, vocab, token, text, turn),
        file=sys.stderr,
    )


def _scanned_fields(record: dict) -> dict:
    free = {key: record[key] for key in ("say", "replies")}
    free["history"] = _without_tools(record["history"])
    free["previousBot"] = record["context"]["previousBot"]
    free["executed"] = [
        {"args": call["args"], "result": call["result"]} for call in record["executed"]
    ]
    return free


def scan_record(
    tally: GateTally, scrubber: Scrubber, vocab: set[str], turn: dict, record: dict
) -> None:
    for path, text in walk(_scanned_fields(record)):
        for reason, token, kind in scrubber.leaks(text):
            shown = token if token in vocab else f"<{len(token)}>"
            tally.leaks.append((reason, token, kind))
            if os.environ.get("DEBUG_LEAKS"):
                _debug_leak(scrubber, vocab, turn, path, token, text)
            where = path[:24] if path.startswith("executed") else path.split(".")[0]
            tally.leak_fields[(where, reason, kind, shown)] += 1
        add_counts(tally.regex, format_hits(text))


def _debug_phrases(
    scrubber: Scrubber, vocab: set[str], blob: str, phrases: list[list[str]]
) -> None:
    for tokens in phrases:
        print(
            "DEBUGPHRASE",
            [
                (
                    len(t),
                    t in vocab,
                    t in scrubber.real_norms,
                    t in scrubber.real_stems,
                    bool(scrubber.forms.get(t)),
                    t in blob.split(),
                )
                for t in tokens
            ],
            file=sys.stderr,
        )


def run_gates(records: list[dict], tally: GateTally, scrubber: Scrubber, vocab: set[str]) -> dict:
    """Whole-string gate (no multi-word private string survives verbatim) and raw-sensitive gate; returns the verdict."""
    blob = norm(
        "\n".join(
            text
            for record in records
            for _, text in walk({k: record[k] for k in ("say", "history", "replies", "executed")})
        )
    )
    surviving = sum(1 for value in tally.raw_sensitive if value in blob)
    blob = " ".join(scrub_module.WORD_RE.findall(blob))
    if surviving:
        tally.regex["rawSensitiveSurvives"] = surviving
    phrases = _whole_entity_phrases(scrubber, blob)
    if os.environ.get("DEBUG_LEAKS"):
        _debug_phrases(scrubber, vocab, blob, phrases)
    return {
        "entityForms": len(tally.leaks),
        "wholeEntityStrings": len(phrases),
        "regex": tally.regex,
    }


def gates_passed(gates: dict) -> bool:
    return not gates["entityForms"] and gates["wholeEntityStrings"] == 0 and not gates["regex"]
