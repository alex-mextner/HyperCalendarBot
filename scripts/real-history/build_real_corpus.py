#!/usr/bin/env python3
"""Builds the scrubbed real-history corpus. RUN ON THE ODROID ONLY (root@odroidn2): the raw text never leaves it.

  nice ionice -c3 python3 build_real_corpus.py --out DIR --private DIR [--vocab-jsonl FILE ...] [--audit]

Reads (read-only): prod calendar.db (chat_history, user_action_log, users, contacts, events, group titles, memory),
the retained private corpora under private-audit/ and the old chat_history backups. Writes:
  OUT/real-history.jsonl   scrubbed records, one per distinct user text (only this goes to git / other hosts)
  OUT/manifest.json        counts, checksum, scrubber version, leak-gate results (no entity, no mapping)
  PRIVATE/mapping.json     secret + lemma->pseudonym mapping, 0600, never leaves the host
Each record carries the user message, the context shape, the tool calls the historical system actually executed with
their result status, and the scrubbed replies. `--audit` prints aggregate counts only and writes nothing.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import scrub as scrub_module
from corpus_gates import (
    GateTally,
    gates_passed,
    raw_sensitive_of,
    run_gates,
    scan_record,
    verify_corpus,
)
from corpus_sources import (
    AUDIT,
    ERROR_RESULT,
    QA_PROBE,
    SENSITIVE_PROMPT,
    load_secret,
    load_sources,
    load_vocab,
    read_rows,
    save_mapping,
    scan_sources,
    sha256_text,
)
from corpus_turns import local_clock, normal_key, register_entities, turns_of, user_profile
from scrub import Scrubber


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="/tmp/real-history-out")
    parser.add_argument("--private", default=f"{AUDIT}/real-history")
    parser.add_argument("--vocab-jsonl", action="append", default=[])
    parser.add_argument("--audit", action="store_true")
    parser.add_argument(
        "--verify",
        metavar="CORPUS",
        help="re-run the entity and format gates on an already written corpus file and exit",
    )
    parser.add_argument(
        "--scan",
        nargs="+",
        metavar="FINDLIST",
        help="probe the files of these find listings and write sources.json",
    )
    return parser.parse_args()


def _skip_reason(text: str, previous_bot: str | None) -> str | None:
    if "[redacted" in text or SENSITIVE_PROMPT.search(previous_bot or ""):
        return "connect_wizard"
    if re.fullmatch(r"[+\d\s().-]{5,}", text):
        return "digits_only"
    if not normal_key(text):
        return "empty"
    return None


def distinct_turns(turns: list[dict]) -> tuple[list[dict], collections.Counter]:
    """One turn per normalised text (the first one), with its repeat count, users and source classes; plus skip counts."""
    seen: dict[str, dict] = {}
    skipped: collections.Counter = collections.Counter()
    for turn in turns:
        reason = _skip_reason(turn["text"], turn["previousBot"])
        if reason:
            skipped[reason] += 1
            continue
        key = normal_key(turn["text"])
        entry = seen.get(key)
        if entry:
            entry["repeats"] += 1
            entry["users"].add(turn["user"])
            entry["classes"] |= turn["row"]["sources"]
            continue
        turn["repeats"] = 1
        turn["users"] = {turn["user"]}
        turn["classes"] = set(turn["row"]["sources"])
        seen[key] = turn
    return sorted(seen.values(), key=lambda t: (t["row"]["at"], str(t["user"]))), skipped


def print_audit(
    distinct: list[dict], per_source: dict[str, dict[str, int]], skipped: collections.Counter
) -> None:
    per_user = collections.Counter(t["user"] for t in distinct)
    tools = collections.Counter(c["name"] for t in distinct for c in t["calls"])
    print(
        json.dumps(
            {
                "distinct": len(distinct),
                "users": len(per_user),
                "perUser": sorted(per_user.values(), reverse=True),
                "tools": tools.most_common(30),
                "withTools": sum(1 for t in distinct if t["calls"]),
                "groups": sum(1 for t in distinct if (t["row"]["chat"] or 0) < 0),
                "sources": per_source,
                "skipped": dict(skipped),
            },
            ensure_ascii=False,
        )
    )


def learn_proper_nouns(scrubber: Scrubber, distinct: list[dict]) -> None:
    """First pass: learn every proper noun the heuristics find, so the second pass treats it identically in every
    message, field and letter case (a title «Визаран» in a tool call and «визаран» in the user's text)."""
    for turn in distinct:
        scrubber.scrub(turn["text"])
        scrubber.scrub(turn["previousBot"] or "")
        for reply in turn["replies"]:
            scrubber.scrub(reply)
        for item in turn["history"]:
            scrubber.scrub(item.get("text") or "")
        for call in turn["calls"]:
            scrubber.scrub_json(call["args"])
            scrubber.scrub(call.get("result") or "")


def _record_lang(text: str, profile_language: str) -> str:
    if re.search("[А-Яа-яЁё]", text):
        return "ru"
    if re.search("[A-Za-z]", text):
        return "en"
    return profile_language if profile_language in ("ru", "en") else "ru"


def _scrubbed_calls(scrubber: Scrubber, turn: dict) -> list[dict]:
    calls = []
    for call in turn["calls"]:
        result = call.get("result")
        calls.append(
            {
                "name": call["name"],
                "args": scrubber.scrub_json(call["args"]),
                "ok": None if result is None else not ERROR_RESULT.search(result),
                "result": None if result is None else scrubber.scrub(result)[:400],
            }
        )
    return calls


def build_record(
    index: int, turn: dict, scrubber: Scrubber, user_ids: dict, profile: dict[int, tuple[str, str]]
) -> dict:
    language, tz_name = profile.get(turn["user"], ("ru", "UTC"))
    zone, clock, date = local_clock(turn["row"]["at"], tz_name)
    calls = _scrubbed_calls(scrubber, turn)
    return {
        "id": f"rh-{index + 1:04d}",
        "user": user_ids[turn["user"]],
        "lang": _record_lang(turn["text"], language),
        "chat": "group" if (turn["row"]["chat"] or 0) < 0 else "private",
        "tz": zone,
        "clock": clock,
        "date": date,
        "say": scrubber.scrub(turn["text"]),
        "voice": turn["voice"],
        "context": {
            "priorTurns": turn["priorTurns"],
            "previousBot": scrubber.scrub(turn["previousBot"])[:300]
            if turn["previousBot"]
            else None,
        },
        "history": [
            {
                key: (scrubber.scrub(value)[:240] if isinstance(value, str) else value)
                for key, value in item.items()
            }
            for item in turn["history"]
        ],
        "executed": calls,
        "expectedTools": [call["name"] for call in calls],
        "expectSilence": not calls and not turn["replies"],
        "replies": [scrubber.scrub(reply)[:400] for reply in turn["replies"]][:4],
        "flags": {"qaProbe": bool(QA_PROBE.search(turn["text"]))},
        "repeats": turn["repeats"],
        "users": len(turn["users"]),
        "sources": sorted(turn["classes"]),
    }


def build_records(
    distinct: list[dict],
    scrubber: Scrubber,
    vocab: set[str],
    user_ids: dict,
    profile: dict[int, tuple[str, str]],
) -> tuple[list[dict], GateTally]:
    tally = GateTally()
    records: list[dict] = []
    for index, turn in enumerate(distinct):
        record = build_record(index, turn, scrubber, user_ids, profile)
        tally.raw_sensitive |= raw_sensitive_of(turn)
        scan_record(tally, scrubber, vocab, turn, record)
        records.append(record)
    return records, tally


KNOWN_WEAK_SPOTS = [
    "A first name that is in no database table, not in the built-in gazetteer and written in lower case is replaced only after a preposition cue (with/for/to/from/about) and when it is not one edit from a dictionary word.",
    "Narrative content with no name in it (health, family, pets, travel plans, long voice transcripts) is kept as written: it is not name-based personal data and the engine needs it.",
    "Absolute dates and clock times are real: only names, places, contacts and ids are pseudonymised.",
    "Two of twelve users write most of the rows (u07, u11): report per-user results, not only pooled ones.",
    "Pseudonyms are drawn from a small public pool; an inflected pseudonym can read slightly oddly (Cyrillic ending on a Latin or place pseudonym).",
]


def build_manifest(
    records: list[dict],
    checksum: str,
    source_rows: dict,
    user_texts: int,
    skipped: collections.Counter,
    user_count: int,
    entities: dict,
    gates: dict,
) -> dict:
    months = collections.Counter(record["date"][:7] for record in records)
    return {
        "schemaVersion": 1,
        "scrubberVersion": scrub_module.VERSION,
        "builtAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "records": len(records),
        "checksum": checksum,
        "file": "real-history.jsonl",
        "sourceRows": source_rows,
        "recordsBySourceClass": dict(
            collections.Counter(cls for record in records for cls in record["sources"])
        ),
        "userTexts": user_texts,
        "distinctTexts": len(records),
        "skipped": dict(skipped),
        "users": user_count,
        "byLang": dict(collections.Counter(r["lang"] for r in records)),
        "byChat": dict(collections.Counter(r["chat"] for r in records)),
        "withExecutedTools": sum(1 for r in records if r["executed"]),
        "byMonth": dict(sorted(months.items())),
        "entities": entities,
        "leakGates": {
            **gates,
            "passed": True,
            "note": "entity forms and stems, whole-string and regex gates run on every string of every record",
        },
        "knownWeakSpots": KNOWN_WEAK_SPOTS,
        "mapping": "private: kept at 0600 on the build host, never exported",
    }


def write_corpus(out: str, lines: list[str]) -> None:
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "real-history.jsonl"), "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")


def write_manifest(out: str, manifest: dict) -> None:
    with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")


def main() -> int:
    args = _parse_args()

    if args.scan:
        scan_sources(args.scan, args.private)
        return 0
    databases = load_sources(args.private)
    rows, per_source = read_rows(databases)
    turns = turns_of(rows)
    profile = user_profile(databases)
    print(
        f"databases {len(databases)}; rows unique {len(rows)} by source {per_source}; user text turns {len(turns)}",
        file=sys.stderr,
    )

    vocab, proper = load_vocab(args.vocab_jsonl)
    secret, mapping = load_secret(args.private)
    scrubber = Scrubber(vocab=vocab, proper=proper, secret=secret, mapping=mapping)
    entity_counts = register_entities(scrubber, databases)
    fingerprint = sha256_text("\n".join(sorted(scrubber.real_norms)))
    print(f"entities {entity_counts}, real lemmas {len(scrubber.real_norms)}", file=sys.stderr)
    if args.verify:
        return verify_corpus(args.verify, scrubber, fingerprint)

    distinct, skipped = distinct_turns(turns)
    print(f"distinct texts {len(distinct)}, skipped {dict(skipped)}", file=sys.stderr)
    if args.audit:
        print_audit(distinct, per_source, skipped)
        return 0

    learn_proper_nouns(scrubber, distinct)
    user_ids = {
        user: f"u{index + 1:02d}"
        for index, user in enumerate(sorted({t["user"] for t in distinct}, key=str))
    }
    records, tally = build_records(distinct, scrubber, vocab, user_ids, profile)
    lines = [json.dumps(record, ensure_ascii=False, sort_keys=True) for record in records]
    checksum = scrub_module.checksum(lines)
    gates = run_gates(records, tally, scrubber, vocab)
    print(f"gates {gates}", file=sys.stderr)
    if not gates_passed(gates):
        print("LEAK GATE FAILED: no corpus written", file=sys.stderr)
        print(
            json.dumps(
                {
                    "gates": gates,
                    "leakFields": [[list(k), v] for k, v in tally.leak_fields.most_common(40)],
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 3

    write_corpus(args.out, lines)
    source_rows = {
        "databasesRead": len(databases),
        "databasesByClass": dict(collections.Counter(item["class"] for item in databases)),
        "rowsFoundAndNewByClass": per_source,
        "uniqueRowsAfterDedupe": len(rows),
    }
    entities = {
        "registeredByKind": entity_counts,
        "lemmas": len(scrubber.real_norms),
        "listSha256": fingerprint,
    }
    manifest = build_manifest(
        records, checksum, source_rows, len(turns), skipped, len(user_ids), entities, gates
    )
    write_manifest(args.out, manifest)
    save_mapping(args.private, secret, scrubber.export_mapping())
    print(
        json.dumps(
            {
                k: manifest[k]
                for k in (
                    "records",
                    "users",
                    "checksum",
                    "leakGates",
                    "byLang",
                    "byChat",
                    "withExecutedTools",
                )
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
