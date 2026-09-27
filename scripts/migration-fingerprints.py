#!/usr/bin/env python3
"""Print "<migration name>\t<sha256 of its source>" for every entry in migrations.ts.

Reads the file's raw text from stdin (the deploy script pipes it in from either the
currently-running container or the candidate image) and splits it on the boundary that
starts each top-level migration object: an array opener or a previous element's trailing
comma, immediately followed by "\n  {\n    name: '...'". Requiring that "[" or "," right
before the boundary keeps text shaped like a migration entry inside another migration's own
up()/down() body (a comment, a seed-data array literal) from being cut out as a phantom extra
entry -- as long as that body text isn't itself preceded by "[" or "," at the same indent,
which the "independent" sanity check below can't catch either, since it uses the identical
structural requirement. This is a textual heuristic, not a real parser: closing that gap needs
an actual TypeScript parse, which is treated as disproportionate here -- exploiting it needs
repo write access, at which point editing this script directly is the much easier way to defeat
the gate. The trailing "];" that closes the array is stripped from the last chunk so that
appending a new migration entry never changes the fingerprint of the migration that used to be
last. This assumes the "];" that closes the migrations array is also the end of the file
(not enforced): code added after it would fold into the last migration's hashed body, so an
unrelated edit there would misreport as a change to that migration. Still fails closed either
way, just with a misleading name in the message.
"""

import hashlib
import re
import sys


def fingerprint_migrations(text: str) -> list[tuple[str, str]]:
    parts = re.split(r"(?<=[\[,])(?=\n  \{\n    name: ')", text)
    fingerprints = []
    for part in parts:
        match = re.search(r"name: '([^']+)'", part)
        if not match:
            continue
        name = match.group(1)
        # The name becomes a field in a hand-rolled tab-separated "name\tdigest" line handed to
        # awk on the bash side; a tab or newline in it would silently misalign that split.
        if not re.fullmatch(r"\w+", name):
            raise ValueError(f"migration name {name!r} contains characters outside [A-Za-z0-9_]")
        body = re.sub(r"\n\];\s*\Z", "", part)
        fingerprints.append((name, hashlib.sha256(body.encode()).hexdigest()))
    # Sanity check, not a fully independent one: it shares the split's "preceded by [ or ,"
    # requirement (see the module docstring's caveat), but is tolerant of quote character and
    # indentation width where the split needs an exact 2/4-space match. A format drift that
    # defeats the split -- a reformat to double quotes, a different indent width, tabs -- still
    # shows up here as every real entry, so the counts diverge instead of drifting together.
    # This is a security-relevant deploy gate, so a parse that silently loses or merges entries
    # must fail loud, not fail quiet: a caller that only checks "is the output non-empty" would
    # otherwise see a plausible but wrong fingerprint table.
    expected = len(re.findall(r"(?<=[\[,])\s*\{\s*name:\s*['\"][^'\"]+['\"]", text))
    if len(fingerprints) != expected:
        raise ValueError(
            f"parsed {len(fingerprints)} migration entries but found {expected} \"name: '...'\" "
            "occurrences in the input -- the file's shape has drifted from what this parser expects"
        )
    names = [name for name, _ in fingerprints]
    if len(names) != len(set(names)):
        raise ValueError("duplicate migration name found -- every migration name must be unique")
    return fingerprints


if __name__ == "__main__":
    for name, digest in fingerprint_migrations(sys.stdin.read()):
        print(f"{name}\t{digest}")
