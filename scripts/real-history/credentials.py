"""Credentials typed into the bot are never part of the evaluation corpus.

The Telegram-connect wizard asks a user for a login code and a 2FA password in ordinary chat turns. The name scrubber
only swaps entities, so those answers would pass through untouched. `redact_record` replaces every user turn that
answers such a prompt (and any bare spaced-digit code) with a marker; the benchmark reads `say`, never these turns.

    python3 scripts/real-history/credentials.py docs/intents/real-history   # redact a committed corpus in place

The build script applies `redact_record` to every record before the leak gates run, so a rebuild cannot bring them back.
"""

import hashlib
import json
import re
import sys
from pathlib import Path

MARKER = "[REDACTED:credential]"
# An assistant turn that asks for, or announces, a login code or a password.
PROMPT = re.compile(
    r"(введи(те)?\s+(пароль|код)|пароль\s*\(|двухфакторн|код\s+подтверждения\s+отправлен|"
    r"enter\s+(the\s+|your\s+)?(password|code)|two-factor|2fa|login\s+code)",
    re.IGNORECASE,
)
# A confirmation code typed with spaces or dashes ("6 0 1 2 5", "1-2-3-4-5").
SPACED_CODE = re.compile(r"^\s*\d(?:[\s-]\d){3,7}\s*$")


def redact_history(history):
    """Returns (new history, number of turns redacted)."""
    out, redacted, asking = [], 0, False
    for turn in history:
        text = turn.get("text") or ""
        role = turn.get("role")
        if role == "assistant" and text:
            asking = bool(PROMPT.search(text))
        elif role == "user" and text and (asking or SPACED_CODE.match(text)):
            turn = {**turn, "text": MARKER}
            redacted += 1
        out.append(turn)
    return out, redacted


def redact_record(record):
    history, count = redact_history(record.get("history") or [])
    if count:
        record = {**record, "history": history}
    return record, count


def main(directory: str) -> int:
    root = Path(directory)
    corpus = root / "corpus.jsonl"
    records = [json.loads(line) for line in corpus.read_text(encoding="utf-8").splitlines() if line]
    total, touched = 0, []
    for index, record in enumerate(records):
        records[index], count = redact_record(record)
        if count:
            total += count
            touched.append(record["id"])
    lines = [json.dumps(record, ensure_ascii=False, sort_keys=True) for record in records]
    digest = hashlib.sha256()
    for line in lines:
        digest.update(line.encode("utf-8"))
        digest.update(b"\n")
    checksum = digest.hexdigest()
    corpus.write_text("\n".join(lines) + "\n", encoding="utf-8")
    # manifest.json `checksum` and split.json `corpusChecksum` take this value (edited by hand to keep their layout).
    print(json.dumps({"redactedTurns": total, "records": touched, "checksum": checksum}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
